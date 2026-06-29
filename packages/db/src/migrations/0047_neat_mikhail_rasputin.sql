ALTER TABLE "agent_memories" ADD COLUMN "tier" text DEFAULT 'episodic' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "access_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "last_accessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "embedding" jsonb;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "superseded_by_memory_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_superseded_by_memory_id_agent_memories_id_fk" FOREIGN KEY ("superseded_by_memory_id") REFERENCES "public"."agent_memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memories_agent_status_tier_idx" ON "agent_memories" USING btree ("agent_id","status","tier");