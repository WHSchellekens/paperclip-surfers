# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Paperclip

Paperclip is an open-source control plane for AI-agent companies. It provides org charts, task management, budgets, governance, approval gates, and activity tracking for autonomous AI agents. The current implementation target is V1, defined in `doc/SPEC-implementation.md`.

Before making changes, read: `doc/GOAL.md` → `doc/PRODUCT.md` → `doc/SPEC-implementation.md` → `doc/DEVELOPING.md` → `doc/DATABASE.md`.

## Commands

```sh
# Install & run dev (embedded Postgres, no DATABASE_URL needed)
pnpm install
pnpm dev                    # API + UI at http://localhost:3100 (watch mode)
pnpm dev:once               # Same but no file watching
pnpm dev:server             # API only
pnpm dev:ui                 # UI only

# Build & verify
pnpm build                  # Build all workspaces
pnpm -r typecheck           # TypeScript check all workspaces
pnpm test:run               # Run all tests once (vitest)
pnpm test                   # Run tests in watch mode

# Database
pnpm db:generate            # Generate Drizzle migration after schema changes
pnpm db:migrate             # Apply pending migrations

# E2E
pnpm test:e2e               # Playwright end-to-end tests

# Single test file
pnpm vitest run path/to/test.ts
```

**Verification before hand-off** — all three must pass:
```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

## Monorepo Structure

pnpm workspaces. Build order matters — dependencies must build before dependents.

| Package | Purpose |
|---------|---------|
| `packages/db` | Drizzle ORM schema (61 tables), migrations, DB client. Uses compiled `dist/schema/*.js` for drizzle-kit. |
| `packages/shared` | Types, Zod validators, constants, API path constants. No runtime logic. Used by all workspaces. |
| `packages/adapter-utils` | Shared adapter utilities |
| `packages/adapters/*` | 7 agent adapters (claude, codex, cursor, gemini, openclaw, opencode, pi). Each exports `./server`, `./ui`, `./cli`. |
| `packages/plugins/sdk` | Stable plugin SDK (protocol, types, UI hooks, testing) |
| `server` | Express 5 REST API, orchestration services, WebSocket realtime, auth, file storage |
| `ui` | React 19 + Vite 6 + Tailwind 4 + React Router 7 + TanStack Query board UI |
| `cli` | `paperclipai` npm CLI, built with esbuild + Commander.js |

## Architecture

**Company scoping**: Every domain entity is scoped to a company. Routes and services enforce company boundaries. Agent API keys must not cross companies.

**Contract synchronization**: Schema changes must propagate across all layers: `packages/db` schema → `packages/shared` types/validators → `server` routes/services → `ui` API clients/pages.

**Server** (`server/src/`):
- `routes/` — 27 API route handlers under `/api`
- `services/` — 66+ business logic services. Key ones: `heartbeat.ts` (agent scheduling/orchestration), `issues.ts` (task management), `budgets.ts` (cost tracking with hard-stops), `approvals.ts` (governance gates), `company-skills.ts` (skill injection)
- `adapters/` — adapter registry, dynamic loading of all 7 adapters
- `auth/` — JWT, API keys (hashed at rest), board auth
- `realtime/` — WebSocket connection manager

**Control-plane invariants** (must be preserved):
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for all mutations

## Database Workflow

1. Edit `packages/db/src/schema/*.ts`
2. Export new tables from `packages/db/src/schema/index.ts`
3. `pnpm db:generate` (compiles schema first, then runs drizzle-kit)
4. `pnpm -r typecheck` to validate

Dev uses embedded Postgres (leave `DATABASE_URL` unset). Data persists at `~/.paperclip/instances/default/db/`. Reset by deleting that directory.

## Lockfile Policy

Do not commit `pnpm-lock.yaml` in pull requests. CI on `master` regenerates it.

## API Conventions

- Base path: `/api`
- Board access = full-control operator context
- Agent access via bearer API keys (`agent_api_keys`)
- Mutations must write activity log entries
- Return consistent HTTP errors: `400/401/403/404/409/422/500`

## Test Configuration

Vitest projects: `packages/db`, `packages/adapters/opencode-local`, `server`, `ui`, `cli`. Tests are colocated in `__tests__/` directories. E2E uses Playwright (`tests/e2e/`).

## TypeScript

Target ES2023, strict mode, `NodeNext` module resolution. All packages extend `tsconfig.base.json` and output to `dist/`.
