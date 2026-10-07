# ADR 0001 — Foundation stack and pinned versions

- **Status:** Accepted (implementation started 2026-10-05)
- **Context:** Phase 0 foundation for Factory ERP. Factory discovery is deferred (surprise prototype), so these are engineering decisions only — no factory-specific assumptions.

## Decision

Component families follow `docs/ARCHITECTURE.md` §A. Versions were verified against the npm registry and peer-dependency ranges on 2026-10-05 and are pinned exactly in `pnpm-lock.yaml`.

| Component | Chosen | Notes / verification |
|---|---|---|
| Node.js | 24 LTS (≥ 24.7) | Active LTS. Needed for the built-in `crypto.argon2` (argon2id with no native add-on). |
| pnpm | 11.18 (via corepack) | Dependency build scripts are blocked by default. Only `esbuild` is allowed (`allowBuilds` in `pnpm-workspace.yaml`). |
| TypeScript | **6.0.x, not 7.0** | TS 7 (the native port) is the latest release, but `typescript-eslint` 8.71 supports only `<6.1`. Revisit when type-aware linting supports TS 7. |
| PostgreSQL | 18 (`postgres:18-alpine`) | UUIDv7 is generated in the application, so the schema has no dependency on any particular major version. |
| Fastify | 5.12 | Includes `@fastify/cookie`, `@fastify/static` and `@fastify/rate-limit` (login only). |
| Kysely + kysely-codegen | 0.29 / 0.20 | DB-first: `db/migrations/*.sql` → generated `schema.generated.ts`. CI runs `--verify`. |
| Zod | 4.6 | Contracts shared by the API, the web app and future AI tools. |
| decimal.js | 10.6 | Wrapped in `Money`, `Qty`, `Rate` and `Percent`. JS numbers are never used for money. |
| React / Vite / Tailwind | 19.3 / 8.3 / 4.3 | Plus TanStack Router 1.170 and TanStack Query 5.104. |
| Vitest | 5.0 | `unit` and `integration` projects. Integration tests run against real PostgreSQL, one cloned database per file. |
| PDF | Headless Chrome/Chromium through `playwright-core` | Resolves the "PDF renderer" decision left open in Round 2 §5.2. It uses a system browser (none is bundled). HTML templates are pure functions and are unit-tested without a browser. Typst remains the lighter alternative if the factory hardware cannot spare a browser process. |

## Deliberately not used (yet)

- **pg-boss.** A transactional outbox polled with `FOR UPDATE SKIP LOCKED` covers V1. Add pg-boss when scheduled jobs are needed.
- **WebSocket.** V1 polls (R2-D5).
- **Redis, Kubernetes, microservices, GraphQL, ORM magic.**
- **`packages/ui`.** It has a single consumer today, so the components stay in `apps/web`. Extract it when a second app needs them.
- **`apps/docai` and `apps/control-plane`.** These come later, per the architecture.

## Consequences

- Upgrading TypeScript to 7 is blocked on typescript-eslint support.
- `crypto.argon2` was added in Node 24.7. It is isolated in `modules/identity/password.ts`, so moving to an npm argon2 package would be a one-file change.
- PDF generation needs a Chrome/Chromium binary on the server (`PDF_BROWSER_EXECUTABLE`).
