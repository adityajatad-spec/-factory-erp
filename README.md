# Factory ERP

An AI-native ERP for Indian MSME factories: sales, purchasing, inventory, production, workforce, accounting and GST, with a local-first deployment and an AI copilot that acts **only** through typed, permission-checked commands.

> **Status: early prototype.**
>
> - The Phase 0 foundation, the sales-to-cash loop, Slice 0 hardening and Slice 1 (procure-to-pay with the inventory write path) are built.
> - **All data is synthetic demo data.** Factory discovery is deferred (see [`docs/discovery/README.md`](docs/discovery/README.md)).
> - GST rates are labelled `DEMO_UNVERIFIED`.
> - Invoice PDFs carry a **SPECIMEN** watermark until a chartered accountant has validated the calculations ([architecture, Round 2 §7](docs/ARCHITECTURE.md)).

## What works today

**The full vertical slice:** sign in → see the demo company → search or create customers and items → draft a sales invoice → deterministic GST calculation → issue it → invoice PDF → audit trail → dashboard.

**The sales-to-cash loop:** issued invoice → customer receipt → bill-wise allocation (full, partial, one receipt across several invoices) → derived outstanding and payment status → receivables ageing.

- Receipts and allocations are **append-only**.
- Outstanding is always **derived** as grand total − Σ allocations − Σ issued credit notes, never stored or edited.
- **Overpayment rule:** money that isn't allocated stays on account as a customer credit. It can be allocated later, and is never silently capped.
- Allocation is protected by row locks, plus a deferred SQL check at commit.

**The sales correction path** ([ADR 0002](docs/adr/0002-sales-correction-path.md)): issued invoices are never edited or deleted — they are corrected by a new record.

- **Invoice cancellation:** `ISSUED → CANCELLED` with a mandatory reason, recorded once (who, when, why). The invoice keeps its number, values and PDF. A reversing entry clears the customer balance. Only invoices with no payments and no credit notes can be cancelled — refunds and un-allocation are not modelled yet.
- **Credit notes:** a separate document (`DRAFT → ISSUED`, then immutable) against one issued invoice of the same customer, with its own gapless `CN/<FY>/<n>` series. Lines credit invoice lines (returns at the invoiced rate, or price reductions per unit) through the same GST engine, inheriting the invoice's tax position. Partial and full credits are supported. It can never credit more than a line's taxable value or the invoice's outstanding amount.
- **Derived settlement:** outstanding = grand total − payments − credit notes. Payment status adds `CREDITED`. Receivables, ageing and dashboard KPIs exclude cancelled invoices and net out credit notes.
- **Defence in depth:** one settlement lock serialises payments, credit notes and cancellation on an invoice, and deferred SQL checks re-verify every rule at commit (FO003/FO004).
- **Credit-note PDFs** are generated from the same template and renderer, watermarked SPECIMEN, and hash-verified.

**Procure-to-pay** (Slice 1): supplier → purchase order → approval → goods receipt → stock → supplier bill → three-way match → what we owe → supplier payment (maker-checker) → allocation → outstanding.

- **Suppliers** are parties with the supplier role (no duplicate entity). **Bank details** are RESTRICTED: proposed by one person and approved by another (the old details are superseded, never edited), masked in every command result and audit record, redacted from logs, and never available to the AI.
- **Purchase orders:** `DRAFT → APPROVED → PARTIALLY_RECEIVED → RECEIVED`, short-close (`CLOSED`) or `CANCELLED` (nothing received), each with a reason. Drafting and approving are separate permissions; approval reprices with the shared GST engine (supplier's state vs ours), gives a gapless `PO/<FY>/<n>` number, freezes the order in SQL and renders a SPECIMEN PDF through the outbox.
- **Goods receipts (GRN):** received = accepted + rejected; rejected quantity needs a reason, is not stocked and does not use up the order. Over-receipt is refused in the command and again by a deferred SQL check (FO006). Accepted goods enter stock **only through the inventory module's API**.
- **Inventory write path:** an append-only stock ledger (UOM, source document, reference, actor) with database sign checks; stock on hand is the ledger's sum, never a stored number; stock can never go negative; corrections are compensating adjustments with a reason.
- **Supplier bills (purchase invoices):** `DRAFT → POSTED`, then immutable. Two explicit paths: against a PO, or direct. Tax is recomputed from the billed rates; the supplier's printed total is kept and compared. The same bill entered twice is refused. Our `PI/<FY>/<n>` number follows the posting date, because bills arrive out of order.
- **Three-way match** (`purchasing/invoices/matching.ts`): pure and deterministic — item, quantity against what was accepted (across all receipts and earlier bills), price against the order and the total against ours, with tolerances stored per company (defaults: none, ₹1 on totals). A bill with differences can only be posted by someone with the override permission, with a reason that is recorded.
- **What we owe:** posting credits an append-only supplier payable ledger. Payables show, per supplier: owed, unpaid bills, overdue, due this week, paid and money on account — all derived on the server (`balance = Σ outstanding − Σ on account`).
- **Supplier payments:** recorded by one user and approved by a different one (enforced in the command and by a SQL check). Approval numbers the payment, debits the ledger and settles the proposed bills — re-checked under row locks, all or nothing. Full, partial, multi-bill and on-account (advance) payments; on-account money is allocated later. A deferred SQL check (FO005) re-verifies every allocation at commit.

- **Authentication and RBAC**
  - argon2id passwords and server-side sessions in `HttpOnly`/`SameSite=Lax` cookies.
  - Eight seeded roles with code-defined permissions.
  - The UI hides what a role cannot do, and the server enforces it independently.
  - Every sign-in attempt is recorded. After five failures for a username — real or not — the next attempt must wait (30 s, doubling to 15 min), so guessing is slow and usernames cannot be probed.
- **Running the factory without a developer** (Slice 0)
  - **Users & roles:** create sign-ins, assign roles, deactivate, reset passwords. Administrators set a first or temporary password; the user must choose their own before anything else works. Nobody can change their own roles or deactivate themselves, only an owner manages owners, and the company always keeps an active owner.
  - **Master data:** customers, suppliers and items can be edited (codes never change) and archived instead of deleted. Archiving is refused while a party has drafts or an open balance, or an item sits on a draft. Issued documents keep the details they were issued with.
  - **Background jobs:** a PDF job that keeps failing stops, is audited, shows on the dashboard and can be retried from Administration → Background jobs.
  - **Backups** with a restore drill (below).
- **Command bus:** every mutation runs validate → authenticate → authorize → idempotency → transaction → domain rules → persist → audit → outbox. HTTP routes are thin adapters. AI-tier rules are enforced in both buses: an AI agent could at most prepare drafts and can never issue an invoice. Today the copilot has no command tools at all.
- **Copilot** (backend in Slice 2, the page at `/copilot` in Slice 3): questions in plain language, answered by a **local** model (Ollama; nothing is downloaded, nothing goes to a cloud service) from five read-only lookups — customers and suppliers, receivables, payables, stock on hand and warehouses. It runs as the signed-in person: the server re-checks their session, permissions and the company's AI policy throughout every turn, and it cannot change anything.
  - Answers name the lookups they used, link to the ERP pages where the figures can be checked, and say when a lookup was cut short. A question can be cancelled (Esc); this stops the server's turn, although a model call already running cannot be recalled.
  - Nothing is saved: each question is answered on its own and leaving the page clears the conversation.
  - AI is off until the server is configured (`AI_PROVIDER`, `AI_MODEL`, see `.env.example`) and the owner sets a company AI policy. There is no policy screen yet: the policy is set through `PUT /api/v1/ai/policy`.
  - The browser E2E journey uses a deterministic test provider (`AI_PROVIDER=fake`, refused in production), not a real model; answers that use lookups and failure states are mocked in the browser there.
- **GST engine** (`packages/gst`)
  - Pure, deterministic and versioned. Uses decimal arithmetic only.
  - Computes CGST/SGST or IGST, line discounts, a rate-wise summary, the round-off and the amount in words in the Indian numbering system.
  - The browser uses it for a live preview. The server recomputes authoritatively on save and again on issue.
- **Invoices**
  - Drafts carry optimistic concurrency.
  - Issuing assigns a **gapless number per financial year** under a row lock and snapshots seller and customer details.
  - Issued invoices are **immutable, enforced by PostgreSQL triggers**.
  - Issuing also posts to the customer ledger (append-only) and emits an outbox event that renders the PDF in headless Chrome.
- **Audit:** append-only `audit.events`, written in the same transaction as the change. It records the actor, actor kind (user, ai_agent or system), request ID, command, and before/after state.
- **Dashboard:** KPIs come from modules through an insights registry, with no mock numbers. Each KPI is filtered by the viewer's permissions.
- **Web app:** a dense, keyboard-first ERP UI with a Ctrl/⌘+K command palette, `/` to search and `N` for a new invoice. It is responsive down to phone width. **The core serves the built app itself**, so the LAN and remote paths use one origin (R2-D1).

**Not built yet (by design):**

- refunds, receipt reversals and un-allocation; credit notes after full payment; debit notes; unlinked or multi-invoice credit notes
- purchase returns and debit notes, PO amendments, supplier refunds, input tax credit, reverse charge and TDS on purchases
- production, workforce, maintenance, quality and full accounting
- document AI; copilot drafts and action cards, conversation history and an AI policy screen
- the control plane and SaaS features

The sidebar only shows modules that work.

## Quick start

Prerequisites: **Node 24 (≥ 24.7)**, **pnpm** (`corepack enable`), **Docker**, and Google Chrome or Chromium (for PDFs).

```bash
cp .env.example .env        # local dev settings
pnpm install
pnpm db:up                  # PostgreSQL 18 in Docker (bound to 127.0.0.1 only)
pnpm db:seed                # migrate (as the owner), create the runtime role, load demo data
pnpm dev                    # API on :3000, web on http://127.0.0.1:5173
```

**Demo users:**

- Usernames: `owner`, `admin`, `accountant`, `production`, `purchase`, `hrmanager`, `supervisor`, `worker`.
- Password: `factory-demo` (override with `DEMO_PASSWORD`).
- Try `accountant` for the full invoicing flow, and `worker` to see permission filtering.
- Purchasing: `purchase` drafts orders and enters bills, `supervisor` receives goods, `accountant` posts bills and records payments, `owner` (or `admin`) approves orders, payments and bank details.

**Production-style run** (one origin, the core serves the web app):

```bash
pnpm build
cd apps/core && WEB_DIST_DIR=../web/dist node --env-file=../../.env dist/main.js   # http://127.0.0.1:3000
```

## Commands

| Command                                       | What it does                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm verify`                                 | Format check, lint, typecheck, then every test. Run before pushing.                                                                                                                                                            |
| `pnpm test:unit` / `pnpm test:integration`    | Unit tests, or integration tests against real PostgreSQL. Each test file gets its own database cloned from a migrated template.                                                                                                |
| `pnpm --filter @factory-erp/web e2e`          | After `pnpm build`: all browser journeys (smoke, receivables, corrections, administration, procure-to-pay, copilot) on a throwaway database with fresh demo data and the test AI provider. Your dev database is never touched. |
| `pnpm --filter @factory-erp/web e2e:journeys` | The same journeys against an app you are already running (`BASE_URL`, default `:3000`).                                                                                                                                        |
| `pnpm db:migrate`                             | As the schema owner (`DATABASE_OWNER_URL`): apply forward-only SQL migrations, then create the runtime login role if missing. In development the server also does this at startup; in production it never does.                |
| `pnpm backup` / `pnpm backup:verify <dir>`    | Back up the database and PDFs; verify a backup with a full restore drill. See [Backup and restore](#backup-and-restore).                                                                                                       |
| `pnpm backup:restore <dir> --database <name>` | Restore a backup into a **new** database (never over an existing one).                                                                                                                                                         |
| `pnpm db:codegen`                             | Regenerate Kysely types from the database (`--verify` in CI).                                                                                                                                                                  |
| `pnpm db:seed -- --reset`                     | **Dev only:** drop everything and rebuild the demo dataset.                                                                                                                                                                    |

## Repository layout

```
apps/core          Fastify API: platform (command bus, auth, audit, outbox), modules, seed
apps/web           React + Vite web app (served by the core in production)
packages/money     Money / Qty / Rate / Percent (decimal.js) and Indian formatting
packages/gst       Pure GST invoice engine and Indian financial year
packages/contracts Zod schemas, DTO types, permission codes and data classes shared by API, web and AI tools
packages/ai        Provider-agnostic AI interfaces and the pure routing policy (no providers yet)
db/migrations      Plain SQL migrations — the database schema is the source of truth
docs/              Architecture, ADRs, deferred factory-discovery material
```

## Engineering rules (enforced, not aspirational)

- **No floats for money.** Values are exact decimal strings end to end. Lint rules ban `parseFloat`/`Math.round` in the financial packages.
- **The database defends invariants:** CHECK constraints, foreign keys, triggers that keep ledgers and audit append-only, immutable issued documents, and non-overlapping effective-dated GST rates.
- **No business logic in routes.** Every mutation goes through the command bus and every read through the query bus. Every query runs in one read-only snapshot, so a report never mixes two moments.
- **Module boundaries are tested** (`apps/core/src/architecture.test.ts`): other code imports a module only through its `index.ts`; every table has one owning module and only it writes there, inside the command's transaction; no module cycles; commands never render PDFs or write blobs (the outbox does); business modules never import AI code, and AI code never imports the database.
- **Every command and query is in one registry** (`apps/core/src/registry.ts`), and each declares its AI tier — and, for queries, the class of data it returns. A **multi-company isolation harness** (`apps/core/src/isolation.int.test.ts`) attacks every one of them with another company's identifiers.
- **Strict TypeScript** (`noUncheckedIndexedAccess`, `erasableSyntaxOnly`) with type-aware ESLint. Avoid `any`.
- **Regulatory values** (tax rates, number formats, thresholds) are data tagged `[VERIFY R-nn]`, never constants presented as fact.

## Database roles

The application never runs as a database superuser or as the schema owner.

| Role                                                       | Connection           | Can                                 | Cannot                                                                                                                                          |
| ---------------------------------------------------------- | -------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner (`factoryerp` in development)                        | `DATABASE_OWNER_URL` | Run migrations, back up and restore | — (in production, a dedicated non-superuser owner; see the roadmap)                                                                             |
| Runtime (`factoryerp_app`, member of `factoryerp_runtime`) | `DATABASE_URL`       | Read and write rows                 | Change the schema, disable triggers, `TRUNCATE`, set `session_replication_role`, create extensions, or update/delete rows of append-only tables |

`pnpm db:migrate` creates the runtime login role from `DATABASE_URL` if it is missing (it never changes an existing password). At startup the server checks the schema is current and inspects its own role: in production it refuses to start as a privileged role, in development it warns. `apps/core/src/db/privileges.int.test.ts` proves the runtime role cannot do any of the above and fails if a later migration forgets to restrict a new append-only table or view.

### Role permissions on existing installations (e.g. the new `ai.policy.manage`)

Role permissions are defined in code (`apps/core/src/platform/roles.ts`) and written to `identity.role_permissions` by role synchronisation (`syncRoles`). `ai.policy.manage` goes to OWNER only — ADMIN is defined as every permission except it.

- **Today:** role sync runs only from the development seed and the test fixtures. On a development database, `pnpm db:seed` (without `--reset`) re-syncs the roles before it notices the demo data already exists, and changes nothing else.
- **Required before production (not built yet):** an idempotent role sync run by `pnpm db:migrate` as the schema owner, so a deployed database receives new permissions in the same step as the migration that needs them. Never use the demo seed to update a production installation.

Until a role has `ai.policy.manage`, nobody can set an AI policy, and with no policy AI stays off — the failure mode is safe.

## Backup and restore

```bash
pnpm backup                                      # → .backups/factoryerp-<UTC timestamp>/
pnpm backup:verify .backups/factoryerp-…         # restore drill into a throwaway database
pnpm backup:restore .backups/factoryerp-… --database factoryerp_restored
```

- **What is backed up:** the whole database (`pg_dump`, custom format, as the owner) and every generated document in the blob store (`DATA_DIR/blobs`), plus a `manifest.json` with versions, the dump's SHA-256 and row counts taken **in the dump's own snapshot**.
- **Where:** `BACKUP_DIR`, by default `.backups/` at the repository root (git-ignored). A backup directory only gets its final name once it is complete.
- **Verification:** every blob is checked against its content address and the dump against its checksum; then it is restored into a throwaway database, where row counts, the schema version, every document's blob and the receivables reconciliation (ledger = outstanding − unallocated) are checked, and the throwaway database is dropped. The same drill runs in the test suite (`apps/core/src/ops/backup.int.test.ts`).
- **Restore:** always into a **new** database; blobs are merged into `DATA_DIR` (content-addressed, so nothing is overwritten). Then stop the server, point `DATABASE_URL`/`DATABASE_OWNER_URL` at the new database, run `pnpm db:migrate`, and start it.
- **Not backed up:** `.env` and other secrets, database roles and passwords (recreated by `pnpm db:migrate`), the built application (rebuild from git), logs, and the Docker volume itself.
- **Production will also need:** a schedule, copies on a second disk and **off-site, encrypted** (keys escrowed with the owner), retention and pruning, continuous WAL archiving for point-in-time recovery, alerting on failed or stale backups, and a restore drill on the real server.

`pg_dump`/`pg_restore` come from the local client tools when their version matches the server, and otherwise run inside the Compose `db` container.

## Open CA / regulatory validation points

Nothing here is production tax-ready. GST rates are demo data, and invoice and credit-note PDFs stay watermarked SPECIMEN until a chartered accountant validates them. Open points include:

- line-level rounding and rupee rounding of grand totals
- credit-note grounds, particulars and time limits [VERIFY R-03]
- whether and when an issued invoice may be cancelled rather than credited [VERIFY R-03/R-06]
- the treatment of advances and of credits after payment
- purchase side: place of supply and input tax credit [VERIFY R-05], reverse charge on inward supplies such as freight [VERIFY R-11], TDS on purchases [VERIFY R-17], MSME payment timelines that would change due dates [VERIFY R-18]
- three-way-match tolerances (company settings, defaulting to none), advances paid to suppliers, and booking supplier bills by posting date
- bank-detail formats (IFSC, account numbers) are checked for shape only [VERIFY R-25]

The full list is in [ADR 0002](docs/adr/0002-sales-correction-path.md) and the regulatory register in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and [`docs/adr/`](docs/adr/) for recorded decisions.
