import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentMemories } from "@paperclipai/db";
import {
  cosineSimilarity,
  EMBEDDING_MODEL_ID,
  getEmbedder,
  type EmbedFn,
} from "./embeddings.js";
import { estimateTokens } from "./token-estimate.js";
import { logger } from "../../middleware/logger.js";

type MemoryRow = typeof agentMemories.$inferSelect;

export type WakeContext = {
  issueTitle?: string | null;
  wakeReason?: string | null;
  commentText?: string | null;
  taskKey?: string | null;
};

export type InjectionSelection = {
  rules: MemoryRow[];
  episodic: MemoryRow[];
  usedEmbeddings: boolean;
  debug: {
    totalActive: number;
    ruleCount: number;
    episodicConsidered: number;
    episodicSelected: number;
    tokenBudget: number;
    approxTokens: number;
  };
};

const DEFAULT_INJECTION_TOKEN_BUDGET = 1500;
// Rules are never dropped, but warn if the always-on tier alone is unexpectedly large.
const RULE_TOKEN_WARN_CEILING = 1200;
// Intentionally high: only merge true twins (e.g. a repeated "clean scan" snapshot that differs
// only by timestamp). Lower values wrongly merge distinct facts that share boilerplate phrasing
// (e.g. two contacts' "outreach email sent" records), which would silently drop a real memory.
const NEAR_DUPLICATE_THRESHOLD = 0.985;

function normalizeForHash(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function computeContentHash(title: string, content: string): string {
  return createHash("sha256").update(`${normalizeForHash(title)}\n${normalizeForHash(content)}`).digest("hex");
}

function recencyNorm(createdAt: Date | string | null): number {
  if (!createdAt) return 0;
  const ts = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  return 1 / (1 + ageDays / 30);
}

function accessNorm(accessCount: number): number {
  return Math.min(1, (accessCount ?? 0) / 10);
}

function usableEmbedding(m: MemoryRow): number[] | null {
  if (m.embeddingModel !== EMBEDDING_MODEL_ID) return null;
  const e = m.embedding;
  return Array.isArray(e) && e.length > 0 ? e : null;
}

/** Render one memory the way it appears in the injected appendix. */
export function renderMemoryItem(m: Pick<MemoryRow, "title" | "category" | "source" | "scope" | "content">): string {
  return `## ${m.title}\n**Category:** ${m.category} | **Source:** ${m.source} | **Scope:** ${m.scope}\n\n${m.content}`;
}

/**
 * Build the markdown memory appendix: an optional authoritative date line, an always-on
 * "Operating Rules" tier, then the relevance-ranked "Relevant Memories".
 */
export function renderInjection(input: {
  rules: MemoryRow[];
  episodic: MemoryRow[];
  dateLine?: string | null;
}): string {
  const parts: string[] = [];
  if (input.dateLine) parts.push(input.dateLine.trim());
  if (input.rules.length > 0) {
    parts.push(
      `# Operating Rules (always apply)\n\nThese rules are non-negotiable.\n\n${
        input.rules.map(renderMemoryItem).join("\n\n---\n\n")
      }`,
    );
  }
  if (input.episodic.length > 0) {
    parts.push(
      `# Relevant Memories\n\nAccumulated learnings most relevant to this task.\n\n${
        input.episodic.map(renderMemoryItem).join("\n\n---\n\n")
      }`,
    );
  }
  return parts.length > 0 ? `${parts.join("\n\n")}\n\n` : "";
}

/**
 * Pure ranking + token-budgeting for injection. Always returns ALL rules (never dropped); ranks
 * episodic memories by semantic similarity to `qvec` when available (and the memory has a usable
 * same-model embedding), otherwise by a recency/confidence/access heuristic, then greedily fills
 * the remaining token budget. Extracted as a pure function so it is unit-testable without a DB.
 */
export function computeInjectionSet(params: {
  rules: MemoryRow[];
  episodic: MemoryRow[];
  qvec: number[] | null;
  tokenBudget: number;
}): { rules: MemoryRow[]; episodic: MemoryRow[]; approxTokens: number } {
  const { rules, episodic, qvec, tokenBudget } = params;

  const scored = episodic.map((m) => {
    const mvec = usableEmbedding(m);
    let score: number;
    if (qvec && mvec) {
      score = 0.85 * cosineSimilarity(qvec, mvec) + 0.1 * (m.confidence ?? 0.5) + 0.05 * recencyNorm(m.createdAt);
    } else {
      score = 0.5 * recencyNorm(m.createdAt) + 0.3 * (m.confidence ?? 0.5) + 0.2 * accessNorm(m.accessCount);
    }
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // Rules are always included in full.
  let approxTokens = rules.reduce((sum, m) => sum + estimateTokens(renderMemoryItem(m)), 0);
  const selectedEpisodic: MemoryRow[] = [];
  for (const { m } of scored) {
    const cost = estimateTokens(renderMemoryItem(m));
    if (approxTokens + cost > tokenBudget) continue;
    selectedEpisodic.push(m);
    approxTokens += cost;
  }

  return { rules, episodic: selectedEpisodic, approxTokens };
}

export function memoryLoaderService(db: Db, opts?: { embed?: EmbedFn }) {
  const resolveEmbedder = (): Promise<EmbedFn> =>
    opts?.embed ? Promise.resolve(opts.embed) : getEmbedder();

  /** Active rows eligible for injection: global memories plus the current project's memories. */
  async function loadActiveForInjection(agentId: string, projectId?: string | null): Promise<MemoryRow[]> {
    const scopeCondition = projectId
      ? or(
          eq(agentMemories.scope, "global"),
          and(eq(agentMemories.scope, "project"), eq(agentMemories.projectId, projectId)),
        )
      : eq(agentMemories.scope, "global");

    return db
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.agentId, agentId), eq(agentMemories.status, "active"), scopeCondition))
      .orderBy(desc(agentMemories.createdAt));
  }

  const svc = {
    async loadMemories(
      agentId: string,
      projectId?: string | null,
      opts?: { scope?: "global" | "project"; category?: string },
    ) {
      const conditions = [eq(agentMemories.agentId, agentId)];

      if (opts?.scope) {
        conditions.push(eq(agentMemories.scope, opts.scope));
      }

      if (opts?.category) {
        conditions.push(
          eq(
            agentMemories.category,
            opts.category as "pattern" | "preference" | "decision" | "learning" | "feedback",
          ),
        );
      }

      if (projectId) {
        conditions.push(eq(agentMemories.projectId, projectId));
      }

      // Return global + project-scoped memories
      const memories = await db
        .select()
        .from(agentMemories)
        .where(and(...conditions))
        .orderBy(desc(agentMemories.createdAt));

      // If projectId specified and no scope filter, also include global memories
      if (projectId && !opts?.scope) {
        const globalMemories = await db
          .select()
          .from(agentMemories)
          .where(
            and(eq(agentMemories.agentId, agentId), eq(agentMemories.scope, "global")),
          )
          .orderBy(desc(agentMemories.createdAt));

        // Deduplicate by id
        const seen = new Set(memories.map((m) => m.id));
        for (const m of globalMemories) {
          if (!seen.has(m.id)) {
            memories.push(m);
          }
        }
      }

      return memories;
    },

    /**
     * Choose a BOUNDED, relevance-ranked set of memories to inject into a run. Always includes
     * every `rule`-tier memory; ranks `episodic` memories by semantic similarity to the wake
     * context (falling back to a recency/confidence/access heuristic when embeddings are
     * unavailable) and greedily fills a token budget.
     */
    async selectMemoriesForInjection(
      agentId: string,
      wakeContext: WakeContext,
      selectOpts?: { projectId?: string | null; tokenBudget?: number },
    ): Promise<InjectionSelection> {
      const tokenBudget = selectOpts?.tokenBudget ?? DEFAULT_INJECTION_TOKEN_BUDGET;
      const active = await loadActiveForInjection(agentId, selectOpts?.projectId ?? null);
      const rules = active.filter((m) => m.tier === "rule");
      const episodic = active.filter((m) => m.tier !== "rule");

      const queryText = [wakeContext.issueTitle, wakeContext.wakeReason, wakeContext.commentText, wakeContext.taskKey]
        .map((v) => (v ?? "").trim())
        .filter((v) => v.length > 0)
        .join(" — ");

      let qvec: number[] | null = null;
      if (queryText) {
        try {
          const embed = await resolveEmbedder();
          qvec = (await embed([queryText], "query"))?.[0] ?? null;
        } catch {
          qvec = null;
        }
      }

      // Rules are always injected in full (never dropped); warn if the tier is unexpectedly large.
      const ruleTokens = rules.reduce((sum, m) => sum + estimateTokens(renderMemoryItem(m)), 0);
      if (ruleTokens > RULE_TOKEN_WARN_CEILING) {
        logger.warn(
          { agentId, ruleCount: rules.length, ruleTokens, ceiling: RULE_TOKEN_WARN_CEILING },
          "memory injection: rule tier exceeds soft ceiling; consider consolidating rules",
        );
      }

      const { episodic: selectedEpisodic, approxTokens } = computeInjectionSet({
        rules,
        episodic,
        qvec,
        tokenBudget,
      });

      // Best-effort access bookkeeping for what we actually injected (atomic, do not block the run).
      const injectedIds = selectedEpisodic.map((m) => m.id);
      if (injectedIds.length > 0) {
        void (async () => {
          try {
            await db
              .update(agentMemories)
              .set({ accessCount: sql`${agentMemories.accessCount} + 1`, lastAccessedAt: new Date() })
              .where(inArray(agentMemories.id, injectedIds));
          } catch {
            /* best-effort; never block the run */
          }
        })();
      }

      return {
        rules,
        episodic: selectedEpisodic,
        usedEmbeddings: qvec !== null,
        debug: {
          totalActive: active.length,
          ruleCount: rules.length,
          episodicConsidered: episodic.length,
          episodicSelected: selectedEpisodic.length,
          tokenBudget,
          approxTokens,
        },
      };
    },

    async saveMemory(data: {
      agentId: string;
      companyId: string;
      scope: "global" | "project";
      projectId?: string | null;
      category: "pattern" | "preference" | "decision" | "learning" | "feedback";
      title: string;
      content: string;
      source: "self" | "ceo" | "board" | "human";
      confidence?: number;
      tier?: "rule" | "episodic";
    }) {
      const tier = data.tier ?? "episodic";
      const contentHash = computeContentHash(data.title, data.content);
      const projectId = data.projectId ?? null;

      const scopeMatch = data.scope === "project" && projectId
        ? and(eq(agentMemories.scope, "project"), eq(agentMemories.projectId, projectId))
        : eq(agentMemories.scope, "global");

      // 1) Exact duplicate (same normalized title+content) → bump instead of inserting.
      const [exact] = await db
        .select()
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.agentId, data.agentId),
            eq(agentMemories.status, "active"),
            eq(agentMemories.contentHash, contentHash),
            scopeMatch,
          ),
        )
        .limit(1);
      if (exact) {
        const [bumped] = await db
          .update(agentMemories)
          .set({
            confidence: Math.min(1, (exact.confidence ?? 0.5) + 0.1),
            accessCount: (exact.accessCount ?? 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(agentMemories.id, exact.id))
          .returning();
        return bumped ?? exact;
      }

      // 2) Embed (best-effort) for storage + near-duplicate merge.
      let vec: number[] | null = null;
      try {
        const embed = await resolveEmbedder();
        vec = (await embed([data.content], "passage"))?.[0] ?? null;
      } catch {
        vec = null;
      }

      if (vec) {
        const candidates = await db
          .select()
          .from(agentMemories)
          .where(
            and(
              eq(agentMemories.agentId, data.agentId),
              eq(agentMemories.status, "active"),
              scopeMatch,
            ),
          );
        let best: { row: MemoryRow; sim: number } | null = null;
        for (const row of candidates) {
          const rvec = usableEmbedding(row);
          if (!rvec) continue;
          const sim = cosineSimilarity(vec, rvec);
          if (!best || sim > best.sim) best = { row, sim };
        }
        if (best && best.sim >= NEAR_DUPLICATE_THRESHOLD) {
          const [merged] = await db
            .update(agentMemories)
            .set({
              title: data.title,
              content: data.content,
              contentHash,
              embedding: vec,
              embeddingModel: EMBEDDING_MODEL_ID,
              confidence: Math.min(1, (best.row.confidence ?? 0.5) + 0.1),
              accessCount: (best.row.accessCount ?? 0) + 1,
              updatedAt: new Date(),
            })
            .where(eq(agentMemories.id, best.row.id))
            .returning();
          return merged ?? best.row;
        }
      }

      // 3) Insert new.
      const [memory] = await db
        .insert(agentMemories)
        .values({
          agentId: data.agentId,
          companyId: data.companyId,
          scope: data.scope,
          projectId,
          category: data.category,
          title: data.title,
          content: data.content,
          source: data.source,
          confidence: data.confidence ?? 0.5,
          tier,
          contentHash,
          embedding: vec ?? undefined,
          embeddingModel: vec ? EMBEDDING_MODEL_ID : undefined,
        })
        .returning();

      return memory;
    },

    async updateMemory(
      id: string,
      data: {
        title?: string;
        content?: string;
        category?: "pattern" | "preference" | "decision" | "learning" | "feedback";
        confidence?: number;
        tier?: "rule" | "episodic";
      },
    ) {
      const patch: Record<string, unknown> = { ...data, updatedAt: new Date() };

      // If content changed, re-hash and re-embed so dedup/retrieval stay correct.
      if (data.content !== undefined || data.title !== undefined) {
        const [existing] = await db.select().from(agentMemories).where(eq(agentMemories.id, id)).limit(1);
        if (existing) {
          const title = data.title ?? existing.title;
          const content = data.content ?? existing.content;
          patch.contentHash = computeContentHash(title, content);
          if (data.content !== undefined) {
            try {
              const embed = await resolveEmbedder();
              const vec = (await embed([content], "passage"))?.[0] ?? null;
              if (vec) {
                patch.embedding = vec;
                patch.embeddingModel = EMBEDDING_MODEL_ID;
              }
            } catch {
              /* leave embedding as-is */
            }
          }
        }
      }

      const [updated] = await db
        .update(agentMemories)
        .set(patch)
        .where(eq(agentMemories.id, id))
        .returning();

      return updated;
    },

    /** Soft-archive memories (used by the consolidation/librarian flow). Reversible. */
    async archiveMemories(ids: string[], supersededByMemoryId?: string | null) {
      if (ids.length === 0) return 0;
      const result = await db
        .update(agentMemories)
        .set({
          status: "archived",
          archivedAt: new Date(),
          supersededByMemoryId: supersededByMemoryId ?? null,
          updatedAt: new Date(),
        })
        .where(inArray(agentMemories.id, ids))
        .returning();
      return result.length;
    },

    async deleteMemory(id: string) {
      const [deleted] = await db
        .delete(agentMemories)
        .where(eq(agentMemories.id, id))
        .returning();

      return deleted;
    },

    async getMemory(id: string) {
      const [memory] = await db
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.id, id))
        .limit(1);

      return memory ?? null;
    },
  };

  return svc;
}
