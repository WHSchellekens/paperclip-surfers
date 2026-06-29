/**
 * De-duplicate / consolidate an agent's episodic memories by merging near-identical entries so
 * they stop occupying multiple injection slots. SAFE + REVERSIBLE: keeps the best representative
 * of each near-duplicate cluster and SOFT-ARCHIVES the rest (status='archived', supersededByMemoryId
 * = representative). Never deletes. Never touches `tier='rule'` memories. Dry-run by default.
 *
 * Run from the server workspace so deps resolve:
 *   cd server && DATABASE_URL=postgres://... \
 *     node --import ./node_modules/tsx/dist/loader.mjs scripts/memory-consolidate.ts \
 *       --agents=<id>,<id> [--threshold=0.92] [--apply]
 *
 * Clusters are formed only within the same (agentId, scope, projectId) group, by cosine similarity
 * of the stored embeddings (same embedding model only).
 */
import { agentMemories, and, createDb, eq, inArray } from "@paperclipai/db";
import { cosineSimilarity, EMBEDDING_MODEL_ID } from "../src/services/agent-runtime/embeddings.js";

type Row = typeof agentMemories.$inferSelect;

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : undefined;
}

// Union-find over rows whose pairwise cosine >= threshold (within an already-scoped group).
function clusterByCosine(rows: Row[], threshold: number): Row[][] {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  for (let i = 0; i < rows.length; i++) {
    const ei = rows[i].embedding;
    if (!Array.isArray(ei)) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const ej = rows[j].embedding;
      if (!Array.isArray(ej)) continue;
      if (cosineSimilarity(ei, ej) >= threshold) union(i, j);
    }
  }
  const groups = new Map<number, Row[]>();
  rows.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(r);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

// Best representative to keep: highest confidence, then longest content, then newest.
function pickRepresentative(cluster: Row[]): Row {
  return [...cluster].sort((a, b) =>
    (b.confidence ?? 0) - (a.confidence ?? 0) ||
    (b.content?.length ?? 0) - (a.content?.length ?? 0) ||
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0];
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL is required"); process.exit(1); }
  const agentIds = (arg("agents") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (agentIds.length === 0) { console.error("--agents=<id>,<id> is required"); process.exit(1); }
  const threshold = Number(arg("threshold") ?? "0.92");
  const apply = process.argv.includes("--apply");

  const db = createDb(dbUrl);
  console.log(`Mode: ${apply ? "APPLY (soft-archive)" : "DRY-RUN"} | threshold cosine >= ${threshold}\n`);

  let grandArchive = 0;
  for (const agentId of agentIds) {
    const rows: Row[] = await db
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.agentId, agentId), eq(agentMemories.status, "active"), eq(agentMemories.tier, "episodic")));
    const usable = rows.filter((r) => r.embeddingModel === EMBEDDING_MODEL_ID && Array.isArray(r.embedding));

    // Group by (scope, projectId) so we never merge across scopes.
    const byScope = new Map<string, Row[]>();
    for (const r of usable) {
      const k = `${r.scope}::${r.projectId ?? ""}`;
      if (!byScope.has(k)) byScope.set(k, []);
      byScope.get(k)!.push(r);
    }

    const clusters: Row[][] = [];
    for (const group of byScope.values()) clusters.push(...clusterByCosine(group, threshold));

    const archiveIds: string[] = [];
    const repBumps: { id: string; confidence: number }[] = [];
    console.log(`=== agent ${agentId.slice(0, 8)} | active episodic: ${rows.length} (embedded: ${usable.length}) | duplicate clusters: ${clusters.length} ===`);
    for (const cluster of clusters) {
      const rep = pickRepresentative(cluster);
      const dups = cluster.filter((r) => r.id !== rep.id);
      archiveIds.push(...dups.map((r) => r.id));
      repBumps.push({ id: rep.id, confidence: Math.min(1, (rep.confidence ?? 0.5) + 0.05 * dups.length) });
      console.log(`  KEEP  [${rep.id.slice(0, 8)}] ${rep.title.slice(0, 70)}`);
      for (const d of dups) console.log(`   └─ archive [${d.id.slice(0, 8)}] ${d.title.slice(0, 70)}`);
    }
    console.log(`  → would archive ${archiveIds.length}; active episodic ${rows.length} -> ${rows.length - archiveIds.length}\n`);
    grandArchive += archiveIds.length;

    if (apply && archiveIds.length > 0) {
      for (const b of repBumps) {
        await db.update(agentMemories).set({ confidence: b.confidence, updatedAt: new Date() }).where(eq(agentMemories.id, b.id));
      }
      // Archive in chunks, tagging each with its representative.
      for (const cluster of clusters) {
        const rep = pickRepresentative(cluster);
        const dupIds = cluster.filter((r) => r.id !== rep.id).map((r) => r.id);
        if (dupIds.length === 0) continue;
        await db
          .update(agentMemories)
          .set({ status: "archived", archivedAt: new Date(), supersededByMemoryId: rep.id, updatedAt: new Date() })
          .where(inArray(agentMemories.id, dupIds));
      }
      console.log(`  APPLIED: archived ${archiveIds.length} duplicates for ${agentId.slice(0, 8)}.\n`);
    }
  }

  console.log(`${apply ? "Archived" : "Would archive"} ${grandArchive} duplicate memories total across ${agentIds.length} agents.`);
  if (!apply) console.log("Re-run with --apply to perform the soft-archive (reversible: status='archived').");
  process.exit(0);
}

void main();
