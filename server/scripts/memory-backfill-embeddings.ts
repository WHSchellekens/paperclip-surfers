/**
 * Backfill embeddings + content hashes for existing agent_memories rows, and (optionally) seed
 * canonical "rule"-tier memories. Idempotent: only touches rows missing an embedding/hash.
 *
 * Run from the server workspace so node resolves @paperclipai/db, drizzle-orm and the optional
 * embedding dep from server/node_modules:
 *   cd server && DATABASE_URL=postgres://... \
 *     node --import ./node_modules/tsx/dist/loader.mjs scripts/memory-backfill-embeddings.ts
 *   (optionally) ... scripts/memory-backfill-embeddings.ts --seed-rules=<agentId>,<agentId>
 *
 * Doubles as a model warm-up (first run downloads/caches the local embedding model). If the
 * optional embedding dependency is unavailable, rows still get content hashes (embeddings null).
 */
import { agentMemories, agents, createDb, eq, isNull } from "@paperclipai/db";
import { getEmbedder, EMBEDDING_MODEL_ID } from "../src/services/agent-runtime/embeddings.js";
import { computeContentHash, memoryLoaderService } from "../src/services/agent-runtime/memory-loader.js";

const BATCH = 32;

const WEEKDAY_RULE = {
  category: "pattern" as const,
  title: "Never compute weekdays — verify date/weekday pairs",
  content:
    "Never write a day-of-week from memory or computation. Use the authoritative current date provided each run. " +
    "For any other date, call GET $PAPERCLIP_API_URL/api/utils/weekday?date=YYYY-MM-DD and use the returned weekday verbatim. " +
    "A wrong weekday-date pair (e.g. 'maandag 19 mei' when 19 May is a dinsdag) is a critical error. If you cannot verify, omit the weekday and write only the date.",
};

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const seedArg = process.argv.find((a) => a.startsWith("--seed-rules"));
  const seedAgentIds = seedArg && seedArg.includes("=")
    ? seedArg.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const db = createDb(dbUrl);
  const svc = memoryLoaderService(db);
  const embed = await getEmbedder();

  // 1) Backfill embeddings + content hashes for rows missing an embedding.
  const rows = await db.select().from(agentMemories).where(isNull(agentMemories.embedding));
  console.log(`Found ${rows.length} memories without embeddings.`);

  let embedded = 0;
  let hashedOnly = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vecs = await embed(batch.map((r) => r.content), "passage");
    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      const vec = vecs?.[j] ?? null;
      await db
        .update(agentMemories)
        .set({
          contentHash: row.contentHash ?? computeContentHash(row.title, row.content),
          ...(vec ? { embedding: vec, embeddingModel: EMBEDDING_MODEL_ID } : {}),
          updatedAt: new Date(),
        })
        .where(eq(agentMemories.id, row.id));
      if (vec) embedded++;
      else hashedOnly++;
    }
    console.log(`  processed ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  console.log(`Backfill done: ${embedded} embedded, ${hashedOnly} hash-only (embeddings unavailable).`);

  // 2) Optionally seed the canonical weekday rule for the named agents (dedup-safe via saveMemory).
  for (const agentId of seedAgentIds) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) {
      console.warn(`  seed-rules: agent ${agentId} not found, skipping`);
      continue;
    }
    await svc.saveMemory({
      agentId,
      companyId: agent.companyId,
      scope: "global",
      category: WEEKDAY_RULE.category,
      title: WEEKDAY_RULE.title,
      content: WEEKDAY_RULE.content,
      source: "human",
      confidence: 1,
      tier: "rule",
    });
    console.log(`  seeded weekday rule for agent ${agentId}`);
  }

  process.exit(0);
}

void main();
