import { describe, expect, it } from "vitest";
import { agentMemories } from "@paperclipai/db";
import { computeInjectionSet, renderMemoryItem } from "../services/agent-runtime/memory-loader.ts";
import { cosineSimilarity, EMBEDDING_MODEL_ID } from "../services/agent-runtime/embeddings.ts";
import { estimateTokens } from "../services/agent-runtime/token-estimate.ts";

type MemoryRow = typeof agentMemories.$inferSelect;

let idCounter = 0;
function mem(p: Partial<MemoryRow> = {}): MemoryRow {
  idCounter += 1;
  return {
    id: `m${idCounter}`,
    agentId: "agent",
    companyId: "company",
    scope: "global",
    projectId: null,
    category: "learning",
    title: `title-${idCounter}`,
    content: "content",
    source: "self",
    confidence: 0.5,
    tier: "episodic",
    status: "active",
    accessCount: 0,
    lastAccessedAt: null,
    archivedAt: null,
    embedding: null,
    embeddingModel: null,
    contentHash: null,
    supersededByMemoryId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...p,
  } as MemoryRow;
}

describe("cosineSimilarity", () => {
  it("is 1 for identical unit vectors, 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("returns 0 on length mismatch or empty", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("computeInjectionSet", () => {
  it("ranks episodic by semantic similarity to the query vector", () => {
    const near = mem({ id: "near", embedding: [1, 0], embeddingModel: EMBEDDING_MODEL_ID });
    const mid = mem({ id: "mid", embedding: [0.7, 0.7], embeddingModel: EMBEDDING_MODEL_ID });
    const far = mem({ id: "far", embedding: [0, 1], embeddingModel: EMBEDDING_MODEL_ID });
    const res = computeInjectionSet({ rules: [], episodic: [far, mid, near], qvec: [1, 0], tokenBudget: 100000 });
    expect(res.episodic.map((m) => m.id)).toEqual(["near", "mid", "far"]);
  });

  it("falls back to recency/confidence heuristic when there is no query vector", () => {
    const stale = mem({ id: "stale", createdAt: new Date(Date.now() - 120 * 86_400_000), confidence: 0.4 });
    const fresh = mem({ id: "fresh", createdAt: new Date(), confidence: 0.9, accessCount: 9 });
    const res = computeInjectionSet({ rules: [], episodic: [stale, fresh], qvec: null, tokenBudget: 100000 });
    expect(res.episodic[0].id).toBe("fresh");
  });

  it("ignores embeddings from a different model (treats them as unusable)", () => {
    const staleModel = mem({ id: "stale", embedding: [1, 0], embeddingModel: "some-old-model" });
    // qvec present but the only memory has a stale-model embedding -> still selectable via heuristic, no crash.
    const res = computeInjectionSet({ rules: [], episodic: [staleModel], qvec: [1, 0], tokenBudget: 100000 });
    expect(res.episodic.map((m) => m.id)).toEqual(["stale"]);
  });

  it("always includes all rules, even when the token budget is 0", () => {
    const r1 = mem({ id: "r1", tier: "rule", content: "an operating rule with some length" });
    const r2 = mem({ id: "r2", tier: "rule" });
    const e1 = mem({ id: "e1" });
    const res = computeInjectionSet({ rules: [r1, r2], episodic: [e1], qvec: null, tokenBudget: 0 });
    expect(res.rules.map((m) => m.id)).toEqual(["r1", "r2"]);
    expect(res.episodic).toHaveLength(0);
  });

  it("never exceeds the token budget", () => {
    const episodic = Array.from({ length: 25 }, (_, i) => mem({ id: `e${i}`, content: "x".repeat(400) }));
    const budget = 300;
    const res = computeInjectionSet({ rules: [], episodic, qvec: null, tokenBudget: budget });
    expect(res.approxTokens).toBeLessThanOrEqual(budget);
    expect(res.episodic.length).toBeLessThan(25);
    const rendered = res.episodic.reduce((sum, m) => sum + estimateTokens(renderMemoryItem(m)), 0);
    expect(rendered).toBeLessThanOrEqual(budget);
  });
});
