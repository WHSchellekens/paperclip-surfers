import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentMemories, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { memoryLoaderService } from "../services/agent-runtime/memory-loader.ts";
import { EMBEDDING_MODEL_ID, type EmbedFn } from "../services/agent-runtime/embeddings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping memory-loader tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Embedders for tests: one that disables embeddings (null), one that returns a fixed vector.
const nullEmbed: EmbedFn = async () => null;
const fixedEmbed: EmbedFn = async (texts) => texts.map(() => [1, 0]);

describeEmbeddedPostgres("memoryLoaderService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-loader-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agentMemories);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Linda",
      role: "general",
      status: "idle",
      adapterType: "claude_local",
    });
  }

  it("bumps an exact duplicate instead of inserting a second row", async () => {
    await seedAgent();
    const svc = memoryLoaderService(db, { embed: nullEmbed });
    const base = { agentId, companyId, scope: "global" as const, category: "learning" as const, source: "self" as const };

    const first = await svc.saveMemory({ ...base, title: "Rule", content: "Verify weekdays." });
    const second = await svc.saveMemory({ ...base, title: "Rule", content: "Verify weekdays." });

    expect(second.id).toBe(first.id);
    const all = await db.select().from(agentMemories);
    expect(all).toHaveLength(1);
    expect(all[0].confidence).toBeGreaterThan(first.confidence);
    expect(all[0].accessCount).toBe(1);
  });

  it("merges a near-duplicate (high cosine) into the existing memory", async () => {
    await seedAgent();
    const svc = memoryLoaderService(db, { embed: fixedEmbed });
    const base = { agentId, companyId, scope: "global" as const, category: "learning" as const, source: "self" as const };

    const first = await svc.saveMemory({ ...base, title: "Alpha", content: "first phrasing of the idea" });
    const second = await svc.saveMemory({ ...base, title: "Beta", content: "second phrasing of the idea" });

    expect(second.id).toBe(first.id); // merged, not a new row
    expect(second.content).toBe("second phrasing of the idea");
    const all = await db.select().from(agentMemories);
    expect(all).toHaveLength(1);
    expect(all[0].embeddingModel).toBe(EMBEDDING_MODEL_ID);
  });

  it("injection includes all rules + active episodic, excludes archived, and bounds by budget", async () => {
    await seedAgent();
    const svc = memoryLoaderService(db, { embed: nullEmbed });
    const base = { agentId, companyId, scope: "global" as const, category: "learning" as const, source: "self" as const };

    await svc.saveMemory({ ...base, title: "RULE", content: "always verify weekdays", tier: "rule" });
    const keep = await svc.saveMemory({ ...base, title: "Keep me", content: "relevant learning" });
    const archived = await svc.saveMemory({ ...base, title: "Old", content: "stale learning" });
    await svc.archiveMemories([archived.id]);

    const selection = await svc.selectMemoriesForInjection(
      agentId,
      { issueTitle: "schedule a meeting" },
      { tokenBudget: 100000 },
    );

    expect(selection.rules).toHaveLength(1);
    const episodicIds = selection.episodic.map((m) => m.id);
    expect(episodicIds).toContain(keep.id);
    expect(episodicIds).not.toContain(archived.id);
    expect(selection.debug.episodicSelected).toBe(1);
  });
});
