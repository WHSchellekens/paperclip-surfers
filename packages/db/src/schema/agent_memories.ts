import { type AnyPgColumn, pgTable, uuid, text, timestamp, real, integer, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";

export const agentMemories = pgTable(
  "agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    scope: text("scope").notNull().$type<"global" | "project">(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    category: text("category").notNull().$type<"pattern" | "preference" | "decision" | "learning" | "feedback">(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    source: text("source").notNull().$type<"self" | "ceo" | "board" | "human">(),
    confidence: real("confidence").notNull().default(0.5),
    // Tiering: "rule" memories are always injected and never capped/evicted; "episodic" are retrieval-ranked.
    tier: text("tier").notNull().default("episodic").$type<"rule" | "episodic">(),
    // Soft-archive: archived rows stay for history but are excluded from injection.
    status: text("status").notNull().default("active").$type<"active" | "archived">(),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // Semantic retrieval: stored as a plain array (cosine computed in Node); null until embedded.
    embedding: jsonb("embedding").$type<number[]>(),
    embeddingModel: text("embedding_model"),
    // Stable hash of normalized title+content for exact-duplicate detection on write.
    contentHash: text("content_hash"),
    // When a memory is consolidated into a canonical one, it points back to it (and is archived).
    supersededByMemoryId: uuid("superseded_by_memory_id").references((): AnyPgColumn => agentMemories.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentScopeIdx: index("agent_memories_agent_scope_idx").on(table.agentId, table.scope),
    agentProjectIdx: index("agent_memories_agent_project_idx").on(table.agentId, table.projectId),
    companyIdx: index("agent_memories_company_idx").on(table.companyId),
    agentStatusTierIdx: index("agent_memories_agent_status_tier_idx").on(table.agentId, table.status, table.tier),
  }),
);
