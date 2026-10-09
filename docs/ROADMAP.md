# Factory ERP — Current State and Implementation Roadmap

**Status:** approved by the owner · **Slice 0 (hardening) complete on 7 October 2026** (§11) · **Slice 1 (procure-to-pay) complete on 9 October 2026** (§12) · Slice 2 waits for the owner's go-ahead · baseline commit `1732f0b`

**What this document is.** Written in response to the "full product vision" brief. It does four things:

- describes what is actually implemented today;
- compares that against the 40-point vision;
- reviews the architecture critically;
- proposes an order for building the rest, as integrated end-to-end slices.

**Notes on the brief:**
- **Name:** the brief calls the product _Factory OS_. It was renamed **Factory ERP** on 7 October 2026, and this document keeps the new name.
- **Truncation:** the brief stops at "Step 8 — Test". §8 here is therefore my testing strategy, and §9–§10 add the decisions and first steps that a roadmap needs.

**How it was produced.** The **code is the source of truth**; documents are cited only to say what is _planned_. Every status below points to a file. At the baseline I:
- ran the full suite — format, lint, strict typecheck of all 5 packages, **229/229 tests** on real PostgreSQL, the generated-schema drift check, the production build, and **36/36 browser checks** on a throwaway database with **zero server error logs**;
- analysed the import graph;
- scanned every database write site;
- inspected the live database (tables, triggers, roles, row-level security).

---

## 0. Summary

**What exists.** A **narrow but deep** core. One business flow is complete:

> customer → GST invoice → PDF → receivable → receipt → bill-wise allocation → cancellation or credit note

It runs on a platform layer whose design is production-grade.

| Measure | Count |
|---|---|
| Commands (writes) | 13 |
| Queries (reads) | 19 |
| HTTP endpoints | 37 |
| Permissions | 16 |
| Roles | 8 |
| Migrations | 6 |
| Database tables and views | 27 tables and 3 views |

**What does not exist yet:**
- everything upstream of the invoice: orders, stock movements, purchasing, production and workforce;
- all AI code;
- deployment and backups;
- user administration;
- editing of master data. Customers and items can be created but not changed.

**Architecture verdict: sound; keep it.** The core is the right spine for an AI-native ERP:
- the command and query buses;
- append-only ledgers;
- invariants enforced in the database;
- the AI risk tiers that are already declared on every command and query.

No rewrite is needed. There are, however, **twelve shortcuts to fix before more modules are built** (§3.2). The most serious are:
- the app connects to PostgreSQL as a **superuser**, which could switch off the immutability triggers;
- there are **no backups**;
- master data and users **cannot be edited or administered**;
- module boundaries are **described in ARCHITECTURE.md but not enforced in code**.

**Recommended build order** (§4):

| # | Slice | Size |
|---|---|---|
| 0 | Hardening and seams | S–M |
| 1 | Procure-to-pay with a real stock ledger | L |
| 2 | AI gateway and copilot v0 | M |
| 3 | Document intake → purchase-bill drafts | M–L |
| 4 | Make-to-order: sales order → work order → production → dispatch → invoice | L |
| 5 | Workforce | M–L |
| 6 | Quality, maintenance, tasks and notifications | M |
| 7 | Accounting depth | gated by decisions |

A production-readiness track (deployment, monitoring, off-site backups and the CA gate) runs alongside the slices.

**Sizes:** S ≈ a few days · M ≈ 1–2 weeks · L ≈ 3–5 weeks of focused build at the pace so far. These are rough and not commitments.

**Why procure-to-pay comes before AI:**
- It creates the **stock write path** that flows A, C and E all need.
- It reuses patterns already proven on the sales side: numbering, immutable documents, ledgers, the settlement lock and PDFs.
- It is the landing zone for document AI.
- It gives the copilot a second half of the business to reason about.

The AI **boundaries** are still fixed now, in slice 0, so that nothing built afterwards has to be rewritten for AI.

---

## 1. Inventory of what is built

| Layer | What exists | Where |
|---|---|---|
| Packages | `money`: exact decimal Money/Qty/Rate/Percent, Indian formatting, amount in words. `gst`: pure engine v1.0.0 and financial year. `contracts`: Zod schemas, DTOs and permission codes shared by the API and the web app. | `packages/*/src` |
| Platform | command bus, query bus, audit, idempotency, outbox, numbering, blob store, PDF renderer, clock, IDs, DB-error mapping | `apps/core/src/platform/` |
| Modules | identity, company, parties, catalog, sales (invoices, credit notes, cancellation, PDFs), receivables, finance (customer ledger), documents (read), audit (read), analytics (dashboard) | `apps/core/src/modules/` |
| Database | 6 forward-only migrations in 10 schemas: append-only and guard triggers, deferred settlement checks (FO003/FO004), composite foreign keys | `db/migrations/` |
| Web | dashboard, invoices, credit notes, customers, items and stock, receipts, receivables, command palette, mobile layout | `apps/web/src/` |
| Tests | 229 tests in 22 files (unit, property-based, integration on real PostgreSQL); 36 browser checks in 3 journeys run on a throwaway database | `*.test.ts`, `apps/web/e2e/` |
| CI | format, lint, typecheck, migrate, codegen check, test, build, e2e | `.github/workflows/ci.yml`. It has **never run**: the repository has no remote yet. |
| Ops | development PostgreSQL only; `/health` and `/health/db`; JSON logs | `compose.yaml`, `http/health-routes.ts`, `logger.ts` |

**Dependency footprint.** The core has 9 external runtime dependencies (`fastify` and three plugins, `kysely`, `pg`, `pino`, `playwright-core`, `zod`). The web app has 4 (`react`, `react-dom`, TanStack Router and TanStack Query). The code base is lean, and it should stay that way.

---

## 2. Implementation matrix

**Statuses:**
- **COMPLETE** — works end to end for its defined scope, is enforced on the server and is tested. What remains are extensions.
- **PARTIAL** — works and is tested, but a core part of the feature is missing.
- **FOUNDATION ONLY** — schema, types or hooks exist, but there is no user-facing workflow.
- **PLANNED** — designed in `docs/ARCHITECTURE.md` only.
- **NOT STARTED** — neither code nor design.

> **Nothing financial is production-ready.** "COMPLETE" means functionally complete on demo data. Every financial or tax capability still has to pass the CA gate (ARCHITECTURE Round 2 §7). GST rates are `DEMO_UNVERIFIED`, and PDFs are watermarked SPECIMEN.

Paths are relative to `apps/core/src` unless they start with `db/`, `packages/` or `apps/`.

### 2.1 Platform and cross-cutting

| Feature | Status | Evidence | Gaps | Depends on | Phase |
|---|---|---|---|---|---|
| Platform runtime | COMPLETE | `config.ts` validates the environment with Zod and fails fast. `db/migrate.ts` runs forward-only, checksummed migrations. **Slice 0:** the server runs as a least-privilege runtime role (`db/roles.ts`, migration 0007), refuses a privileged role in production, and never migrates in production. | Production still needs a dedicated non-superuser owner role (development uses the Docker superuser as owner). | — | production track |
| Authentication | PARTIAL | argon2id, equal-timing login, hashed 256-bit session tokens. **Slice 0:** user administration, admin-set temporary passwords with a forced change, own password change, every attempt recorded (`identity.login_attempts`), per-username backoff (`identity/sign-in-backoff.ts`), sessions revoked on deactivation and reset. | No TOTP, no self-service reset by email, a user always gets their first company. | — | TOTP before remote access |
| RBAC | PARTIAL | Checked centrally in both buses; role matrix snapshot-tested. **Slice 0:** owners and administrators assign roles in the app; only owners manage owners; nobody changes their own roles; the company keeps an active owner (`identity/admin.ts`). | Roles are fixed bundles (no custom roles); no scopes (warehouse, department), amount limits, maker-checker or field masking. | — | 1 onwards |
| Audit | PARTIAL | `platform/audit.ts` writes in the same transaction; append-only and no-truncate triggers; the runtime role cannot update or delete it. **Slice 0:** refused sign-ins of known users, outbox failures and retries, user and role changes are audited (never a password). | No hash chain (ARCHITECTURE §P); history is shown per document only; retention not decided [VERIFY R-15/R-16]. | — | 2 (viewer), production (chain) |
| Command bus | COMPLETE | `platform/commands.ts`: all 13 business mutations; `platform/command-bus.int.test.ts` | No retry on deadlock or serialisation failure (SQLSTATE 40P01/40001) | — | 1 |
| Query bus | COMPLETE | `platform/queries.ts`: every query declares permission, AI tier and **data class**, and runs in one **read-only, repeatable-read snapshot** (Slice 0). | — | — | — |
| Idempotency | COMPLETE | `platform/idempotency.ts`: claimed inside the transaction with a request-hash check. `http/route-kit.ts` requires the header on every command route. | Keys never expire | — | later |
| Outbox | COMPLETE | `platform/outbox.ts`: same-transaction enqueue (with the company), lease, backoff, FAILED after 8 attempts. **Slice 0:** handlers render in a `prepare` phase outside any lock and attach in a short `apply`; failures are audited, listed and retryable (`modules/operations`). | No alerting outside the app (production track). | — | — |
| Document numbering | COMPLETE | `platform/numbering.ts`: gapless per financial year under a row lock, with a date-order check | Only one DEFAULT series. There is no TEST series for CA review (Round 2 §7.3). | readiness gate | before parallel run |
| Finance readiness gate | PARTIAL | `platform.companies.finance_readiness` drives the SPECIMEN watermark (`sales/pdf/print-model.ts`) | One state for the whole company, not per capability. No command to change it. No TEST series. | CA | before parallel run |
| Audit logs (vision #31) | PARTIAL | see Audit | see Audit | — | 0, 2 |
| Role-based permissions (vision #32) | PARTIAL | see RBAC | see RBAC | — | 0 |

### 2.2 Sales, customers, tax and receivables

| Feature | Status | Evidence | Gaps | Depends on | Phase |
|---|---|---|---|---|---|
| Executive dashboard | PARTIAL | `analytics/dashboard.ts` with the insights registry: 7 KPIs from real queries, filtered by the viewer's permissions | Sales and receivables only. No production, stock, purchase or cash KPIs, and no exceptions list. | each module | every slice |
| Customers | PARTIAL | Create, **edit, archive and reactivate** (Slice 0, `parties/commands.ts`), optimistic versions, before/after audit; archiving refused with drafts or an open balance; issued documents keep their snapshot. | One address (no ship-to), no contacts list, no credit limit; GSTIN check digit not validated [VERIFY R-09]. | — | 1 |
| Items and catalog | COMPLETE | Create, **edit, archive and reactivate** (Slice 0, `catalog/commands.ts`); archiving refused while a draft uses the item; drafts re-price on save; issued lines keep their snapshot. | Extensions: UOM conversion, reorder level, supplier-item aliases. Rates are `DEMO_UNVERIFIED` [VERIFY R-01]. | — | 1 |
| Sales orders and quotations | NOT STARTED | — | — | inventory write path | 4 |
| Dispatch and delivery challans | NOT STARTED | **Invoices do not move stock**: nothing in `modules/sales` references stock | — | inventory write path | 4 [VERIFY R-04, R-07] |
| Sales invoices | COMPLETE | `sales/draft-commands.ts`, `sales/issue-command.ts`: recomputed on the server, details snapshotted at issue, immutability triggers, ledger posting, PDF via the outbox; `sales/invoices.int.test.ts` | Not tax-ready. No bill-to/ship-to split, e-invoice IRN [VERIFY R-06], e-way bill [VERIFY R-07], bill of supply, export or SEZ [VERIFY R-05/R-23], or TCS [VERIFY R-17]. | CA | CA gate |
| GST engine | PARTIAL | `packages/gst`: pure, versioned and decimal-only; 22 tests, including property tests over 400 random invoices | Intra- and inter-state supplies only. No SEZ or export, reverse charge [R-11], cess or composition [R-13]. **The inward side (input tax credit) does not exist.** Rounding policy needs the CA [R-10]. | CA | 1 (inward), CA gate |
| Invoice PDF generation | COMPLETE | `platform/pdf.ts`: headless Chrome with JavaScript off and the network blocked. Invoice and credit-note templates. SHA-256 verified on download. | Needs Chrome on the server. No PO or challan templates. No digital signature [VERIFY R-24]. | — | each slice |
| Customer receipts (money in) | COMPLETE | `receivables/commands.ts`: append-only receipts, bill-wise allocation, money kept on account | Reversal, refund and un-allocation are **deliberately absent** (ADR 0002). No bank reconciliation. | owner and CA decision | 1 or 7 |
| Receivables | COMPLETE | `receivables/summary.ts` and the `finance.invoice_balances` view: ageing, with a tested reconciliation invariant | Ageing runs from invoice date, not due date. No reminders or statements. | — | 1 |
| Credit notes | COMPLETE | `sales/credit-notes/*`, migration 0006, deferred check FO004; 28 tests | Against one invoice only. Not allowed after full payment. No debit notes. | CA [VERIFY R-03] | later |
| Invoice cancellation | COMPLETE | `sales/cancel-command.ts` with a reversing ledger entry; 14 tests | The policy for issued tax invoices is unverified [VERIFY R-03/R-06] | CA | CA gate |
| Accounting | FOUNDATION ONLY | `finance.party_ledger_entries`: an append-only customer sub-ledger. By decision R2-D4, Tally keeps the official books. | No general ledger, chart of accounts, journals, bank accounts or P&L | Tally decision | 7 |
| Tally integration | PLANNED | ARCHITECTURE §Q, phase 1 | No export. The import format needs verifying. | vouchers from slices 0–1 | 1 (end) |
| Expenses | PLANNED | ARCHITECTURE §Q, phase 7 | — | payables | 7 |

### 2.3 Purchasing and inventory

| Feature | Status | Evidence | Gaps | Depends on | Phase |
|---|---|---|---|---|---|
| Suppliers | COMPLETE (V1) | Parties with the supplier role (Slice 0) plus **bank details under maker-checker** (Slice 1): `parties/bank-accounts.ts`, migration 0013, RESTRICTED query, masked command results and audit, log redaction; suppliers screens. | No MSME status [VERIFY R-18]; one address. | — | 1 |
| Purchasing and POs | COMPLETE (V1) | `modules/purchasing/orders`: draft → approve (separate permission, repriced, gapless `PO/<FY>/<n>`) → part-received → received, short-close and cancel with reasons; SQL freezes approved orders; PDF via the outbox; 13 tests | No amendments, approval thresholds or multi-level approval; no reorder suggestions | suppliers, items | 1 |
| Goods receipts (GRN) | COMPLETE (V1) | `modules/purchasing/receipts`: accepted + rejected (with reason), no over-receipt (command + deferred SQL FO006), stock only through `inventory.recordStockMovements`; property test over random delivery sequences | Over-receipt is not permitted at all; no quality inspection step; no returns to supplier | POs, inventory write path | 1 |
| Purchase invoices | COMPLETE (V1) | `modules/purchasing/invoices`: PO-based and direct paths, duplicate-bill check, shared GST engine, pure three-way match with company tolerances and property tests, override permission + reason, posting credits the payable ledger | Input tax credit, reverse charge [VERIFY R-11], TDS [VERIFY R-17], debit notes, attachments of the paper bill | GRN, inward GST | 1 |
| Payables and supplier payments | COMPLETE (V1) | `modules/payables`, `finance/payables-ledger.ts`: maker-checker payments (command + SQL), full/partial/multi-bill/on-account allocation under row locks, deferred SQL FO005, payables summary (owed, overdue, due this week, paid, on account) and KPIs | Refunds, un-allocation, payment runs, bank file export | purchase invoices | 1 |
| Inventory | PARTIAL | **Write path owned by the inventory module** (`inventory/movements.ts`): append-only ledger with UOM, source, reference and actor; sign and company checks in SQL; negative-stock guard under advisory locks; compensating adjustments with a reason; opening stock through the same API; stock and movement screens | No valuation or cost, no lots or batches, no transfers. Sales do not consume stock. | — | 1–2 |
| Warehouses | PARTIAL | `inventory.warehouse.create`; two demo stores | No archive screen, transfers or bins | inventory | 2 |

### 2.4 Shop floor and workforce

| Feature | Status | Evidence | Gaps | Depends on | Phase |
|---|---|---|---|---|---|
| Production management | PLANNED | ARCHITECTURE §Q phase 4 | — | inventory, BOM | 4 |
| Bills of materials | PLANNED | — | versioned BOMs | items | 4 |
| Work orders | PLANNED | — | — | BOM, inventory | 4 |
| Machines | PLANNED | §G.4 examples | — | — | 4 |
| Maintenance | PLANNED | §Q phases 4 and 6 | — | machines | 6 |
| Quality | PLANNED | §Q phase 6 | — | production, GRN | 4 (minimal), 6 |
| Employees | PLANNED | the HR and WORKER roles exist only as role codes | Personal data handling [VERIFY R-21] | — | 5 |
| Attendance and shifts | PLANNED | §Q phase 4 (including biometric device import) | — | employees | 5 |
| Workforce allocation | PLANNED | §G.5: a constraint solver, not an LLM | [VERIFY R-19] | employees, machines, work orders | 5 |

### 2.5 Documents, collaboration and analytics

| Feature | Status | Evidence | Gaps | Depends on | Phase |
|---|---|---|---|---|---|
| Document management | FOUNDATION ONLY | `docs.documents` (append-only), content-addressed blobs, hash-verified download. **Slice 0:** access derived from the owning record (`documents/access.ts`): an invoice PDF needs invoice-read permission and an invoice that points at it; unknown kinds are denied by default; `document.read` is gone. | No upload, attachments or document screen. | — | 3 |
| Document and invoice OCR | PLANNED | §G.6 pipeline | — | uploads, purchase invoices, AI gateway | 3 |
| Internal communication | PLANNED | §E.6 (notifications, announcements, comments) | — | — | 6 |
| Tasks | PLANNED | §E.6 | — | — | 6 |
| Notifications | PLANNED | §E.6 | [VERIFY R-22] for SMS and WhatsApp | — | 6 |
| Analytics and reporting | FOUNDATION ONLY | the insights contract (`analytics/insights.ts`) and 7 KPIs | No reports, exports, drill-downs or charts | each module | every slice |

### 2.6 AI

| Feature | Status | Evidence | Gaps | Depends on | Phase |
|---|---|---|---|---|---|
| AI guard rails | COMPLETE | `CommandAiTier` in `platform/commands.ts`. Every command and query declares a tier: 4 DRAFT, 9 CONFIRM, 18 READ and 1 FORBIDDEN. Both buses reject an `ai_agent` actor outside its tier, and this is tested. | No tool registry, AI session table or action cards yet | — | 2 |
| AI gateway (provider-agnostic) | FOUNDATION ONLY | **Slice 0:** `packages/ai` — `AiGateway` and `ProviderAdapter` interfaces, provider-neutral request types, and the pure `route()` (task × data class × capability × availability × qualification × cost × latency × policy × fallback), property-tested. | No gateway implementation, adapters or usage ledger. | — | 2 |
| AI copilot | PLANNED | §G.1–G.4 | — | gateway | 2 |
| AI workflow execution | PLANNED | §G.5: scheduled jobs that create drafts | — | copilot, scheduler | 6 |
| AI workforce allocation | PLANNED | §G.5: a solver; the LLM only explains | — | workforce | 5 |
| Local inference | PLANNED | §H.1–H.2, §9.4 (qualification benchmarks) | — | gateway, hardware | 2 |
| Cloud inference | PLANNED | §9.2, owner decision S6 | — | gateway, owner policy | 2 |
| Local, cloud and hybrid deployment | FOUNDATION ONLY | The policy's `mode` (LOCAL / CLOUD / HYBRID) and per-task preferences are part of `route()` and its tests. | No runtime or provider integration. | gateway | 2 |
| Configurable model and provider selection | FOUNDATION ONLY | `AiPolicy` / `TaskPolicy` types (model per task via pinning, fallbacks, data-class limits, cloud switch, budget). | Not stored, no commands, no UI (deliberately). | gateway | 2 (policy as data); UI later |
| Policy-based AI routing | FOUNDATION ONLY | `packages/ai/src/routing.ts` with property tests for every safety invariant (Slice 0). | Not wired to anything yet. | gateway | 2 |
| AI usage and cost visibility | FOUNDATION ONLY | Cost is estimated in integer micro-rupees per candidate, and a monthly cloud budget is enforced by `route()`. | No usage ledger, price book or report. | gateway | 2 |

### 2.7 Operations

| Feature | Status | Evidence | Gaps | Depends on | Phase |
|---|---|---|---|---|---|
| Offline and local-first operation | PARTIAL | **No runtime internet dependency**: the web bundle is self-hosted, the PDF renderer blocks the network, and no external APIs are called. One origin for LAN and remote use (R2-D1). | No PWA service worker or offline command queue (§J.2). Not yet running on a factory node. | deployment | 5 (floor workflows) |
| Deployment | FOUNDATION ONLY | Development database in Compose; the production build serves the web app; CI now uses the same Compose service and the runtime/owner role split. | No Dockerfile, `deploy/` folder, TLS, tunnel or installer. CI has still never run (no remote, by your instruction). | — | production track |
| Backups | PARTIAL | **Slice 0:** `pnpm backup` / `backup:verify` / `backup:restore` (`ops/backup.ts`): consistent dump + blobs + manifest, checksum verification, restore drill (also in the test suite), restore into a new database only. | No schedule, off-site encrypted copies, retention or WAL archiving. | deployment | production track |
| Observability | FOUNDATION ONLY | pino JSON logs (secrets redacted), `/health`, `/health/db`. **Slice 0:** failed background jobs are visible in the app and on the dashboard. | No metrics, alerting, heartbeat or disk checks. | deployment | production track |
| SaaS and multi-tenancy | FOUNDATION ONLY | `company_id` on every business table (now also on outbox events); one database per tenant by design. **Slice 0:** an isolation harness attacks every command and query with another company's identifiers. | No control plane or tenant registry; usernames are one namespace per database. | a second factory | later |

**Totals after Slice 0 (65 rows; two of them, audit logs and role-based permissions, repeat vision items #31 and #32). Before Slice 0: 13 / 11 / 9 / 29 / 3.**

| Status | Rows |
|---|---|
| COMPLETE | 14 |
| PARTIAL | 12 |
| FOUNDATION ONLY | 13 |
| PLANNED | 24 |
| NOT STARTED | 2 |

Vision items #33–#40 (local-first operation, local, cloud and hybrid LLMs, the gateway, configuration, cost visibility and routing) are all PLANNED or NOT STARTED, apart from the AI guard rails.

---

## 3. Architecture health check

### 3.1 The 16 questions

| # | Question | Verdict | Evidence and comment |
|---|---|---|---|
| 1 | Do business mutations consistently go through the command bus? | ✅ Yes | All 13 business writes are `defineCommand` handlers. Writes outside the bus, each justified: login and logout (`identity/auth-service.ts`, audited, because there is no actor before login); outbox handlers (`sales/pdf/pdf-handler.ts`, audited as `system`); seed bootstrap (roles, company, users and **opening stock**, `seed/seed.ts`). **Risk:** nothing stops a future module writing outside the bus. Add an architecture test (§8). |
| 2 | Are permissions enforced centrally? | ✅ Yes, coarse | Checked once in each bus, before the transaction. Permissions are reloaded on every request, so revocation is immediate. The UI only hides what the server already forbids. Missing: scopes, amount limits, maker-checker and object-level rules. `document.read` will leak future HR or salary documents unless access is derived from the owning entity (§3.2 #6). |
| 3 | Are financial records immutable where required? | ⚠️ In SQL, yes; in operation, no | Guard triggers protect issued invoices and credit notes. Ledgers, receipts, allocations, audit and stock are append-only, with no-truncate guards. **But the runtime role is a superuser.** It can `ALTER TABLE … DISABLE TRIGGER`, `SET session_replication_role = replica` or drop tables, so immutability is a convention, not a guarantee (§3.2 #1). The audit log is not hash-chained. |
| 4 | Are money calculations deterministic? | ✅ Yes | decimal.js value objects (`packages/money`), `NUMERIC` columns, and engine inputs and outputs as strings. ESLint bans `parseFloat` and `Number.parseFloat`. The only `Number()` in the web app is an integer count of credit days. |
| 5 | Are GST calculations isolated from the UI? | ✅ Yes | A pure package. The browser uses it **only for preview**; the server recomputes on save and again on issue. The engine version and policy are stored on each document. |
| 6 | Is audit logging reliable? | ✅ Mostly | The bus's types require at least one audit record, written in the same transaction. Missing: failed logins, tamper evidence (a hash chain), and alerts on high-risk events. |
| 7 | Is idempotency actually enforced? | ✅ Yes | The header is mandatory on every command route. The key is claimed in the transaction, the request hash is compared, and concurrent duplicates block on the primary key. Tested. Keys never expire (minor). |
| 8 | Is the outbox reliable? | ✅ With two caveats | At-least-once delivery, idempotent handlers, a lease, backoff and a FAILED state. **Caveats:** FAILED events show only in logs, with no view, alert or retry command. The PDF handler renders Chrome while holding `FOR UPDATE` on the invoice row, which blocks payments and credit notes on that invoice for several seconds. Render first, then lock and attach. |
| 9 | Are modules decoupled enough? | ⚠️ Moderately | There are no file-level cycles. But ARCHITECTURE §E.2–E.3 promises things that **do not exist**: a public `index.ts` per module, a `domain/` vs `infra/` split, "a module writes only to its own schema", and "dependency-cruiser enforces them in CI". Today modules deep-import each other (receivables imports `sales/settlement-lock.ts`), and sales writes `docs.documents` from its PDF handler. This is acceptable at this size, but it will not stay acceptable as purchasing, inventory and production arrive. |
| 10 | Are there dependency cycles? | ⚠️ Two, both at module level | (a) **analytics ↔ sales, finance and receivables.** The KPI contract (`analytics/insights.ts`) sits in analytics, while the dashboard imports each module's KPIs. Move the contract to `platform/`. (b) **db ↔ platform** via `platform/paths.ts`. Trivial. No file-level cycles. |
| 11 | Does the database enforce critical invariants? | ✅ Strongly | Foreign keys, including the composite `(invoice_id, customer_id, company_id)`; CHECK constraints; write-once cancellation fields; deferred settlement triggers (FO003/FO004); a unique ledger source key; gapless numbering. Missing: a negative-stock guard (no stock commands exist yet), and the superuser problem in #3. |
| 12 | Are the APIs thin adapters? | ✅ Yes | `http/routes.ts` only maps HTTP to input. The one route with extra code (document download) only sets headers. |
| 13 | Can the future AI layer use the same command and query infrastructure? | ✅ Yes | Every definition carries a name, description, Zod input, permission and AI tier. The `ai_agent` actor path is enforced and tested. Still to add: output data classification on queries, tool examples, and an AI session record (§5.11). |
| 14 | Can local and cloud LLM providers be swapped without rewriting business logic? | ✅ Today (no AI code exists) | The risk lies in how AI gets built. §5 defines the boundary: business modules never import AI code, and the AI code reaches business data only through the buses. Enforce it with the same architecture test as #9. |
| 15 | Is anything over-engineered? | ⚠️ The plan, not the code | The code is lean. Over-engineering risk sits in ARCHITECTURE.md, which designs Caddy, cloudflared, pg-boss, a Python OR-Tools sidecar, separate `docai` and `llm` containers, a hash-chained audit log, qualification benchmarks and a control plane. **Build each only when a slice needs it.** The document has also drifted from the code: it says pg-boss runs AI jobs, while ADR 0001 chose the outbox. The duplicated settlement checks (in the application and in SQL) are deliberate defence in depth. Keep them, but limit SQL triggers to **money invariants**, because each one doubles the cost of changing a rule. |
| 16 | Are there dangerous shortcuts to fix first? | ❌ Yes | See §3.2. |

### 3.2 Fix before building more modules

| # | Priority | Issue | Why it matters | Fix | Size |
|---|---|---|---|---|---|
| 1 | **P1** | The runtime database role is a **superuser**, and migrations run at startup under it | Any bug or compromise in the app can switch off the immutability triggers. This undermines the whole "the database guards the money" design. | Two roles. `factoryerp_owner` owns the schema and runs migrations. `factoryerp_app` gets data access only: no DDL, TRUNCATE, superuser or `session_replication_role`. Add a test proving the app role cannot disable a trigger. | S |
| 2 | **P1** | No backups at all | One disk failure loses everything once real data exists | v0: `pg_dump -Fc` plus a checksummed copy of the blob directory, a restore into a scratch database, and a restore drill as a CI job. WAL archiving and off-site copies come in the production track. | S |
| 3 | **P1** | Master data is create-only | A wrong customer address or GST rate cannot be corrected, so no real use is possible | `parties.update` / `archive` and `items.update` / `archive`, with optimistic versioning. Issued documents keep their snapshots (this already works). A supplier screen. | S–M |
| 4 | **P1** | No user or role administration | The owner cannot add an accountant without a developer | `users.create`, `setRoles`, `deactivate` and `resetPassword`, plus changing your own password. OWNER-only and FORBIDDEN for the AI. | S–M |
| 5 | P2 | Module boundaries exist only in the documentation | Coupling compounds with every module | A public `index.ts` per module, plus a Vitest architecture test (no new dependency) that fails on cross-module deep imports and on writes to another module's schema. Move the KPI contract to `platform/`. | S |
| 6 | P2 | `document.read` grants every document | Uploaded HR, salary or bank documents would be readable by anyone with that permission | Derive document access from the owning entity's read permission (a map from document kind to permission) | S |
| 7 | P2 | FAILED outbox events are invisible, and the PDF render holds a lock | A PDF can silently never appear, and settlement on that invoice stalls during rendering | An admin query and a retry command for FAILED events; a dashboard exception; render before locking | S |
| 8 | P2 | Reports read outside a snapshot | A report can show figures that briefly fail to reconcile while writes are under way | A `consistency: 'snapshot'` flag on query definitions, which runs them in a `READ ONLY, REPEATABLE READ` transaction | S |
| 9 | P2 | The readiness gate is company-wide and toggles only the watermark | Moving to parallel running needs a TEST series and per-capability states (Round 2 §7.3) | Readiness per capability, TEST number series, and an OWNER command with the CA reference recorded. Before parallel running. | M |
| 10 | P2 | Logins: failed attempts are not audited; no lockout; the rate limit is per IP and in memory | Behind a tunnel, every client may appear as `127.0.0.1`, which makes the limit global. Brute force goes unseen. | Audit failed attempts; a per-username backoff; check that the real client IP is resolved behind the tunnel; TOTP before remote access | S |
| 11 | P3 | The documentation has drifted from the code | Readers trust rules that are not enforced | Fix ARCHITECTURE §E.3 (dependency-cruiser, `index.ts`), §H.2 (pg-boss), and the outstanding formula in the README, which still reads "grand total − Σ allocations" and should also subtract credit notes | S |
| 12 | P3 | No git remote, so CI has never run | The CI workflow is untested | Create a private repository, push, and get CI green | S |

**Slice 0 outcome:** fixes 1–8 and 10–12 are done, except that #12 (push to a remote) is
deliberately deferred by the owner's instruction: the work stays local, so CI has not run yet.
#9 (readiness per capability) waits for the CA, as planned. Details in §11.

---

## 4. Vertical slices

### 4.1 The candidate flows, judged against the code

| Flow | Exists today | Missing | Hard dependencies | Verdict |
|---|---|---|---|---|
| **A** Order-to-cash, make-to-order | The tail: invoice → receivable → payment, with corrections | Sales orders, production requirement, work orders, production, quality, finished goods, dispatch | The stock write path (B), BOMs and work orders (C) | Build its front half with C in **slice 4** |
| **B** Procure-to-pay | The supplier flag on parties; opening stock | POs, GRNs, stock receipts, purchase invoices, payables, supplier payments | Editable masters (slice 0) | **First (slice 1).** It creates the stock write path that A, C and E need. It reuses proven patterns. It is the landing zone for OCR. Payables are the second half of the owner's money view. |
| **C** Raw material → finished goods | Item types (raw material, component, finished good); the stock ledger table | BOMs, work orders, material issue, production entries, scrap and rejects, finished-goods receipt | Stock coming in (B) | **Slice 4**, together with A |
| **D** Workforce | Role codes only | Employees, skills, shifts, attendance, allocation | Machines and work orders (C) for allocation; attendance alone does not depend on them | **Slice 5.** Attendance could move earlier if discovery shows that is the factory's biggest pain. |
| **E** Document intake | The content-addressed blob store and hash-verified documents | Upload, attachments, review queue, extraction, validation | A draft to create (purchase invoices from B), the gateway's vision capability (F) | **Slice 3** |
| **F** AI copilot | Buses with AI tiers, and the `ai_agent` actor | The gateway, tool registry, runtime, action cards, evaluations | None beyond the gateway, but its value grows with data breadth | **Slice 2**, with its seams laid in slice 0 |

**This order assumes discovery stays deferred.** ARCHITECTURE §Q says discovery decides the module order. I chose this order from technical dependencies and from what a typical MSME needs most. Revisit it when discovery happens.

### 4.2 Dependency graph

```
slice 0  hardening + seams ──────────────────────────────────────────┐
   │                                                                  │
slice 1  procure-to-pay + stock write path ──┬─────────────┐          │
   │                                         │             │          │
slice 2  AI gateway + copilot v0 ◀───────────┘             │          │
   │                                                       │          │
slice 3  document intake → purchase-bill drafts ◀──────────┘          │
   │                                                                  │
slice 4  make-to-order (A + C) ◀── stock (1)                          │
   │                                                                  │
slice 5  workforce (D) ◀── machines + work orders (4)                 │
   │                                                                  │
slice 6  quality · maintenance · tasks · notifications · AI workflows │
slice 7  accounting depth (decision-gated)                            │
production track: deploy · TLS · tunnel · monitoring · off-site backups · CA gate ◀┘
```

### 4.3 Slice definitions

Each slice ends with:
- `pnpm verify` green;
- the codegen drift check green;
- new end-to-end journeys green;
- the dev database reseeded clean;
- a short ADR for any decision it settled.

#### Slice 0 — Hardening and seams (S–M)

The twelve fixes in §3.2, plus the AI seams in §5.11. **No new business module.**

**Exit criteria:**
- an e2e journey: the owner adds an accountant → the accountant corrects a customer's address → an already-issued invoice still shows the old address;
- the restore drill passes;
- the app role demonstrably cannot disable a trigger;
- the architecture test is green;
- CI is green on the remote.

#### Slice 1 — Procure-to-pay with a real stock ledger (L)

**Masters:**
- supplier details: **bank details** (RESTRICTED, maker-checker on every change) and MSME registration [VERIFY R-18];
- item reorder level.

**Documents:**

| Document | Lifecycle and rules |
|---|---|
| Purchase order | DRAFT → SUBMITTED → APPROVED → PARTLY_RECEIVED → CLOSED or CANCELLED. Approval thresholds. A PO PDF. |
| Goods receipt (GRN) | Against PO lines, with accepted and rejected quantities. Each accepted line creates a stock `RECEIPT` movement. |
| Purchase invoice | The supplier's number, plus a duplicate check on (supplier GSTIN, number, financial year). Inward GST. Matched to GRN and PO. Input-tax fields [VERIFY R-11 reverse charge, R-17 TDS]. |
| Supplier payment | Recorded by one user and approved by another (maker-checker). Bill-wise allocation that mirrors receipts and reuses the settlement lock. |

**Inventory:**
- a stock-movement API owned by the inventory module;
- a SQL guard against negative stock;
- adjustments with a reason and approval;
- transfers between warehouses;
- a **valuation method decision** (moving average or FIFO) for the CA.

**Finance:**
- supplier ledger entries;
- payables ageing by **due date** (receivables get due-date ageing too);
- **Tally voucher export** for sales, credit notes, receipts, purchases and payments. The format needs verifying with the CA.

**AI tiers:**

| Tier | Commands |
|---|---|
| DRAFT | PO drafts, purchase-invoice drafts |
| CONFIRM | submit, approve, GRN record, invoice post, payment record and approve |
| FORBIDDEN | changing supplier bank details |

**Exit criteria:**
- an e2e journey: PO → partial GRN → stock rises → purchase invoice matched → payable → part payment approved by a second user → payables ageing → Tally export file;
- a simulated physical count reconciles with the ledger.

#### Slice 2 — AI gateway and copilot v0 (M)

**Gateway (§5):**
- a fake provider for tests;
- **one local adapter** (Ollama);
- **one cloud adapter**;
- a routing policy stored as data;
- a usage and cost ledger.

**Copilot:**
- a tool registry generated from the buses;
- the agent runtime loop;
- a chat panel;
- **action cards** for proposals.

**Tools:**
- READ tools over sales, receivables, purchasing and stock;
- DRAFT tools: prepare an invoice, prepare a PO.

**Defaults:** **local only**. Cloud use needs an OWNER opt-in per task.

**Evaluation:** an evaluation set of about 50 utterances to start, growing to 150+ as in §G.7, with injection and permission-escalation cases.

**Exit criteria:**
- the evaluation threshold passes;
- every figure in an answer links to the tool result it came from;
- the cost of each session is visible;
- **with AI switched off, every workflow is unaffected**.

#### Slice 3 — Document intake (M–L)

**Intake:**
- upload with MIME sniffing and size limits;
- attachments on any entity;
- a review queue.

**Extraction:**
- **text-layer parsing first**;
- OCR or vision models via the gateway, run in an isolated step with **no tool access**.

**Checks and output:**
- deterministic validation: GSTIN, totals, duplicates, PO/GRN match;
- approval creates a **purchase-invoice draft through the normal command**;
- supplier and item alias memory;
- a gold evaluation set.

**Exit criteria:** field accuracy is measured on the gold set, and reviewing a bill takes less time than entering it by hand.

#### Slice 4 — Make-to-order (L)

**Build:**
- sales orders;
- versioned BOMs;
- work orders, created from a sales order or for stock;
- material issue (stock `ISSUE`);
- production entries: good, scrap and rework;
- finished-goods receipt;
- a minimal quality check;
- dispatch / delivery challans (stock out) → **invoice from dispatch**;
- machines as basic work centres.

**Decision needed:** how invoices, dispatch and stock relate [VERIFY R-04, R-07]. My recommendation: dispatch moves the stock. A direct invoice without a dispatch moves it at issue, in the same transaction.

**Exit criteria:** a journey from sales order → work order → issue → production with scrap → QC → dispatch → invoice → receipt, with stock and work-in-progress reconciling.

#### Slice 5 — Workforce (M–L)

- **People:** employees, as personal data under the DPDP Act [VERIFY R-21]; skills.
- **Time:** shifts; attendance, both manual and imported from devices.
- **Allocation:** first a manual allocation board. Then a solver proposal (DRAFT tier; the supervisor confirms) [VERIFY R-19].
- **Offline:** the PWA offline outbox (§J.2) for attendance and production entries.

#### Slice 6 — Quality, maintenance, tasks and notifications (M)

- **Quality:** inspections and NCRs.
- **Maintenance:** maintenance tickets and preventive-maintenance schedules.
- **Collaboration:** tasks and comments on any entity; in-app notifications, then WhatsApp and email [VERIFY R-22].
- **AI workflow execution:** scheduled jobs that create **drafts** only.

#### Slice 7 — Accounting depth (gated by decision R2-D4)

- either a general ledger, or keeping Tally as the books with a richer export;
- bank reconciliation;
- expenses;
- GSTR exports [VERIFY R-14];
- period close.

#### Production track (in parallel; must finish before the first real data)

- **Packaging:** Dockerfile, a `deploy/` folder, Caddy for TLS, the tunnel.
- **Operations:** the `factoryerp` install and upgrade CLI; heartbeat and alerts.
- **Backups:** encrypted off-site backups, and a restore drill on the real node.
- **Gates:** the CA gate for each capability, and TOTP for remote users.

---

## 5. AI architecture

### 5.1 The chain, and who owns each step

```
USER ─▶ AI COPILOT (agent runtime) ─▶ AI GATEWAY ─▶ provider adapter ─▶ local or cloud model
             │  ▲ model output = text or JSON proposals only
             ▼  │
        TOOL REGISTRY (generated, filtered per user and tier)
             │
        QUERY BUS / COMMAND BUS ─▶ AUTHORIZATION ─▶ BUSINESS RULES ─▶ DB TRANSACTION ─▶ AUDIT + OUTBOX
```

- **The model** produces text and JSON proposals. It never holds a database handle, SQL, credentials or permissions.
- **The gateway** is deterministic code. It decides _which_ model runs, records usage and cost, and enforces data-class policy.
- **The agent runtime** is deterministic code. It runs the loop, executes tool calls _as the user_ through the buses, and enforces step, time and token limits.
- **The buses** stay the only path into business state, exactly as for HTTP.
- **Humans** execute every CONFIRM action from an action card, through the ordinary HTTP route.

### 5.2 Components and where the code lives

```
packages/ai/                      pure: types, routing function, policy evaluation (no I/O, no DB)
apps/core/src/ai/
  gateway.ts                      AiGateway implementation: route → invoke → fallback → record
  registry/providers.ts           provider registry (adapters, health, circuit breakers)
  registry/models.ts              model registry (capabilities, context window, locality)
  policy/                         policy store (data, versioned) + data-class guard + redaction
  usage/                          usage and cost ledger, budgets
  adapters/fake.ts                deterministic provider for tests and CI (no network)
  adapters/ollama.ts              local runtime
  adapters/anthropic.ts           cloud provider A
  adapters/openai-compatible.ts   cloud provider B, and self-hosted servers such as vLLM
  copilot/tools.ts                tool registry generated from command and query definitions
  copilot/runtime.ts              bounded agent loop
  copilot/proposals.ts            action cards (persisted proposals; humans execute them)
db/migrations/00xx_ai.sql         ai.sessions, ai.messages, ai.tool_calls, ai.invocations,
                                  ai.policies, ai.proposals, ai.qualifications, ai.price_book
```

**Boundary rules**, enforced by the architecture test:
1. No business module imports anything from `ai/`.
2. Only adapters import provider SDKs or make HTTP calls to model endpoints.
3. `ai/` reaches business data **only** through `CommandBus` and `QueryBus`, as the user. It may write only its own `ai` schema (telemetry, sessions, proposals), just as audit writes `audit`.

### 5.3 Interfaces that business code depends on

```ts
export type Capability = 'chat' | 'tools' | 'structured' | 'vision' | 'embed';
export type DataClass = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
export type Task =                       // what the call is for; policy is written per task
  | 'copilot.answer' | 'copilot.plan'
  | 'doc.classify' | 'doc.extract' | 'doc.extract.handwritten'
  | 'text.summarize' | 'search.embed';

export interface AiCallContext {
  task: Task;
  dataClass: DataClass;                  // high-water mark of everything in the request
  companyId: string;
  userId: string;
  aiSessionId: string;
  budget?: { maxCostMicroInr?: bigint; maxLatencyMs?: number; maxOutputTokens?: number };
  signal?: AbortSignal;
}

export interface AiGateway {
  generate(ctx: AiCallContext, req: GenerateRequest): Promise<AiResult<GenerateOutput>>;
  /** Output is validated against the Zod schema; one repair retry, then a typed failure. */
  generateStructured<T>(ctx: AiCallContext, req: StructuredRequest<T>): Promise<AiResult<T>>;
  embed(ctx: AiCallContext, req: EmbedRequest): Promise<AiResult<number[][]>>;
  /** Images and PDF pages in, text or structured output out. */
  vision<T>(ctx: AiCallContext, req: VisionRequest<T>): Promise<AiResult<T>>;
}

export type AiResult<T> =
  | { ok: true; value: T; served: ServedBy }          // the UI shows "local" or "cloud"
  | { ok: false; reason: 'AI_UNAVAILABLE' | 'POLICY_BLOCKED' | 'BUDGET_EXCEEDED'
        | 'SCHEMA_INVALID' | 'TIMEOUT'; served?: ServedBy };

export interface ProviderAdapter {
  id: string;                            // 'ollama-local', 'anthropic', …
  locality: 'LOCAL' | 'CLOUD';
  listModels(): Promise<ModelInfo[]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
  invoke(model: string, req: NormalizedRequest, signal: AbortSignal): Promise<NormalizedResponse>;
}
```

`GenerateRequest`, `NormalizedRequest` and similar types are provider-neutral: messages, tool schemas, images and a JSON-schema output format. Adapters translate them to each provider's API. Nothing outside `adapters/` knows any provider's wire format.

### 5.4 Routing is deterministic code, not a model decision

```
route(task, dataClass, capabilities, budget):
  candidates = models where
      model.capabilities ⊇ capabilities                    # capability match
      policy.allows(task, dataClass, model.locality, model) # owner policy; default LOCAL only
      provider.healthy() and circuit closed                 # availability
      qualified(model, task, this hardware)                 # passed this task's evaluation (§9.4)
      estCost(model, request) ≤ budget.remaining            # cost (local = 0 money; tokens recorded)
      p95Latency(model, task) ≤ budget.maxLatencyMs         # measured from the usage ledger
  order by policy.preference(task)       # e.g. hybrid: local first; cloud for doc.extract.handwritten
  none left → AI_UNAVAILABLE → the UI opens the manual path
```

- **Fallback** moves only down the _same filtered list_. It can never reach a provider the policy excluded, so a local failure never quietly becomes a cloud call.
- **The three deployment modes are one setting**, not three code paths:

| Mode | Policy |
|---|---|
| **LOCAL** | Cloud is disallowed for every task |
| **CLOUD** | Cloud is preferred for every allowed data class |
| **HYBRID** | Preference is set per task: routine and sensitive work goes local; complex reasoning and handwritten bills go to an approved cloud model |

### 5.5 Data classification and its enforcement

- **Classification starts at the source.** Every query definition declares the class of its output (`dataClass`), and contract schemas mark RESTRICTED fields: bank account numbers, credentials, TOTP secrets, and later salaries. Tool results are built by code, so their class is known.
- **High-water mark per session.** Once CONFIDENTIAL data enters a conversation, every later model call in that session must go to a provider allowed for CONFIDENTIAL. Otherwise one cloud call could carry earlier local-only context.
- **RESTRICTED fields are removed before any prompt**, by schema, not by pattern matching. They are replaced with a marker such as "[restricted: bank account on file]".
- **Images cannot be redacted.** A scanned supplier bill can show bank details, so document-AI calls are RESTRICTED by default. They run **locally**, and go to cloud only if the OWNER explicitly permits cloud for that task. Credentials never reach any model.
- **Cloud calls are audited.** Each one records the task, data class, field list, provider, model and policy version in `ai.invocations`.

### 5.6 Usage, cost and budgets

- **The ledger.** `ai.invocations` is append-only. Each row records the session, user, task, provider, model, locality, data class, input and output tokens, **cost in micro-rupees**, latency, outcome, the provider it fell back from, the policy version, and a request hash. Prompt and response bodies are kept locally under a retention class.
- **Prices are data** (`ai.price_book`, effective-dated, entered by an admin). They are never hard-coded, because provider prices change [VERIFY at build time].
- **Budgets:**
  - per request (the `budget` field above);
  - per company per month. When the monthly cap is reached, cloud is refused, the gateway falls back to local or returns `BUDGET_EXCEEDED`, and the owner is notified.
- **Visibility:** an owner-only report of usage by task, user, provider and day, with local and cloud usage side by side.

### 5.7 Copilot runtime, tools and action cards

**The tool registry** is generated from the buses:
- READ queries and DRAFT commands become tools;
- CONFIRM commands become a `propose_action` tool, which **persists a proposal** and never executes it;
- FORBIDDEN items are never listed;
- the registry is filtered to what the signed-in user's permissions allow;
- JSON Schema is generated from the Zod inputs (Zod 4 has a built-in JSON Schema export [VERIFY at build time]).

**The runtime** is a small loop that we own:
- maximum steps, tool calls, wall time and tokens;
- no orchestration framework;
- tool calls run with `actorKind: 'ai_agent'` and the session ID, so `audit.events` already records them correctly.

**Action cards:**
- The UI renders a card from the **persisted** draft or proposal, never from model text.
- A human click calls the ordinary HTTP route as `actorKind: 'user'`.
- The worst a prompt injection can do is produce a bad draft that a person must still approve.

**Numbers:** a figure in an answer must cite a tool result, and the UI can show that result.

**Untrusted content** — OCR text, documents and messages — enters prompts only as quoted data, and only in calls that cannot trigger actions.

### 5.8 What administrators will configure

Configuration is stored as data, versioned, and changed only by FORBIDDEN-tier OWNER commands. **The AI can never change its own policy.**

- available local models and cloud providers (and their keys, stored outside the database);
- the default model, and a model per task;
- the mode (local, cloud or hybrid) and per-task preferences;
- fallback order;
- per-request and monthly cost caps;
- latency targets;
- which data classes may go to cloud, per task;
- whether cloud inference is permitted at all (**default: no**);
- the usage and cost report.

**Not now:** the management UI and a provider marketplace. Slice 2 seeds a policy row and edits it with a command.

### 5.9 What must not use an LLM

| Capability | Done by |
|---|---|
| GST and invoice totals, rounding, amounts in words | `packages/gst` and `packages/money` |
| Stock balances, valuation, reorder suggestions, stock-out forecasts | SQL and domain code |
| Receivables and payables ageing, outstanding amounts, reconciliation | SQL views |
| Payment allocation suggestions (oldest first) | deterministic code (already in the receipt screen) |
| Document numbering, duplicate detection, GSTIN validation [R-09], three-way match | deterministic code |
| Workforce allocation | a constraint solver; the LLM gathers preferences and explains the result |
| Production KPIs and variance | deterministic analytics; the LLM only narrates the tool's output |
| Permission and tier decisions, AI routing | the buses and the gateway's policy code |

### 5.10 Where the LLM adds real value

- turning natural language into the right tool calls;
- asking clarifying questions when a search is ambiguous;
- narrating deterministic results;
- classifying documents;
- extracting fields from images and scans (always reviewed by a person);
- drafting messages and descriptions;
- semantic search, later.

### 5.11 Seams to add now (slice 0), so the copilot is never a rewrite

1. `dataClass` on every `QueryDefinition`, and RESTRICTED markers in contract schemas.
2. Optional `examples` on command and query definitions, for tool descriptions and evaluations.
3. `packages/ai` with the interfaces in §5.3, a pure `route()` function, and property tests. No adapters and no network.
4. The architecture test's AI rules: no business module imports `ai/`; `ai/` imports only the buses, contracts and its own schema.
5. A rule that **every new command declares its AI tier from day one** (already true; keep it in code review).

---

## 6. Data flow and entity map

### 6.1 Target flows across the system

```
                   ┌──────────── Item / BOM / UOM / HSN+rate ───────────┐
                   ▼                                                    ▼
Customer ─▶ Sales order ─▶ Work order ─▶ Material issue ─▶ Production entry ─▶ FG receipt
   │            │              ▲   │            ▲               │   └▶ Scrap / reject ─▶ Quality (NCR)
   │            │              │   └▶ Machine ◀─┼── Allocation ◀─ Employee ◀─ Shift / Attendance / Skills
   │            ▼              │                │
   │        Dispatch (stock out, e-way bill) ─▶ Sales invoice ─▶ Customer ledger ─▶ Receipt / allocation
   │                                              └▶ Credit note / cancellation
Supplier ─▶ Purchase order ─▶ GRN (stock in) ─▶ Purchase invoice ─▶ Supplier ledger ─▶ Payment (maker-checker)
                                                   ▲
Document upload ─▶ text / OCR ─▶ extraction proposal ─▶ deterministic validation ─▶ human review ─┘
AI copilot ─▶ tools ─▶ query/command bus ─▶ any entity above (as the user, within tier)
Every command ─▶ audit.events + outbox ─▶ PDFs · notifications · exports · KPIs
Stock movements (one ledger) ◀── GRN · issue · production · FG receipt · dispatch · adjustment · transfer
```

### 6.2 Entities and boundaries missing from the current database

| Context | Exists | Missing (to be added by the slice that needs it) |
|---|---|---|
| party | `parties` (one address, a customer/supplier flag) | contacts; multiple addresses (bill-to and ship-to); bank details (RESTRICTED, maker-checker); MSME registration; credit limit |
| catalog | items, UOMs, HSN codes, effective-dated rates | UOM conversions; reorder level; supplier-item aliases; BOM and BOM lines (versioned); routings and operations (later) |
| inventory | warehouses, `stock_movements`, `stock_on_hand` | movement commands; cost per movement and a valuation layer; lots and batches (if discovery needs them); reservations; physical counts |
| sales | invoices, invoice lines, credit notes | sales orders; dispatch / delivery challans; debit notes; refund vouchers; e-invoice and e-way-bill references [R-06/R-07] |
| purchase | — | POs and lines with approvals; GRNs and lines; purchase invoices and lines; supplier debit notes (returns) |
| finance | customer ledger, receipts, allocations | supplier ledger entry types; supplier payments and allocations; TDS and TCS fields [R-17]; expenses; bank accounts |
| production | — | work centres and machines; work orders; material issues; production entries (good, scrap, rework); downtime events |
| quality and maintenance | — | inspection plans and results; NCRs; maintenance tickets; preventive-maintenance schedules |
| workforce | role codes | employees (**not** parties: different access rules and personal data); skills; shifts; attendance; allocations |
| docs | `documents` (system PDFs) | uploads; a link table from document to entity; extraction proposals; review records |
| collaboration | — | tasks, comments, notifications, announcements |
| ai | — | sessions, messages, tool calls, invocations, policies, proposals, qualifications, price book |
| identity | users, roles, sessions | login attempts; TOTP secrets (RESTRICTED); permission scopes; user administration |
| system | `number_series`, outbox, idempotency | readiness per capability; TEST series |

### 6.3 Boundary rules for every new module

- **Each table has one owning module.** Only that module writes it.
- **Invariants that span modules commit in one transaction.** The calling module uses the owning module's public API inside the same transaction. Issuing a GRN, for example, calls `inventory.recordMovement(tx, …)` rather than inserting into `inventory.stock_movements` directly.
- **Reads across modules** may join tables directly in queries and views. They are read-only, and reporting stays simple.
- **Side effects that may lag** (PDFs, notifications, exports) go through the outbox.

---

## 7. Security review

| Area | Current state (evidence) | Gap | Fix | When |
|---|---|---|---|---|
| Authentication | argon2id, equal-timing login, hashed session tokens; **Slice 0:** every attempt recorded, per-username backoff, refusals audited, forced change of admin-set passwords (`identity/*`) | No TOTP. The per-IP limit needs the real client IP behind a tunnel. | TOTP for privileged and remote users; verify the client IP | Before remote access |
| Session security | HttpOnly, SameSite=Lax; `COOKIE_SECURE` required in production (`config.ts`); revocation; permissions reloaded each request | No idle timeout separate from the TTL. No device or session list. | Idle timeout; "sign out everywhere" | Slice 0 |
| CSRF | SameSite=Lax, JSON-only bodies (`text/plain` parser removed), no CORS | No `Origin` check, which matters once same-site subdomains exist | Reject state-changing requests with a foreign `Origin` | Before remote access |
| RBAC | Central, tested, snapshot of the role matrix; **Slice 0:** roles assigned in the app with self- and owner-protection rules | Coarse: no scopes, amount limits or field masking; OWNER and ADMIN have everything | Scopes and limits per slice, as data | Slices 1–5 |
| Financial permissions | Creating a draft and issuing it are separate permissions | No thresholds; no second approver anywhere | Approval thresholds on POs, payments and credit notes | Slice 1 |
| Maker-checker | None | Needed for supplier bank details, supplier payments, the readiness switch and role changes | A generic "pending approval" pattern: recorder ≠ approver, both audited | Slice 1 |
| Auditability | Every mutation, in the same transaction, append-only | Not tamper-evident; no alerts on high-risk events | Hash chain per company; owner alerts | Production track |
| AI permissions | Tiers enforced in both buses; the AI acts as the user | No per-user or per-company AI enablement; no session records | `ai.sessions`, AI enablement as data, the tool filter in §5.7 | Slice 2 |
| Sensitive data | Phone and email on parties; secrets redacted from logs (`logger.ts`). **Slice 0:** every query declares its data class; credential fields are marked RESTRICTED and kept out of idempotency hashes and logs | DPDP obligations not yet mapped [VERIFY R-21] | Retention classes; employee data rules in Slice 5 | Slice 5 |
| Local and cloud data boundary | No AI, so nothing leaves the node | — | Default local-only; cloud opt-in per task and data class; high-water-mark rule; RESTRICTED never to cloud unless the OWNER explicitly permits it for document AI; credentials never to any model; every cloud call audited | Slice 2 |
| Secrets | `.env` for development (git-ignored); config validated | No production secret storage | systemd credentials or sops/age (§P); cloud API keys never stored in the database, prompts or logs | Production track |
| Database privileges | **Done in Slice 0:** least-privilege runtime role; owner credentials kept out of the production server; drift tests | Production owner must not be a superuser | Dedicated owner role at install | Production track |
| Document uploads | Not built | — | MIME sniffing, size limits, originals stored immutably, parsers run in a sandbox, nothing executed, access derived from the owning entity | Slice 3 |
| Remote access | Not built (decision R2-D6 open) | — | Tunnel, TOTP, `Origin` check, real-IP rate limits, LAN-only roles | Production track |
| Multi-tenant isolation | `company_id` filters in every handler, **attacked by the isolation harness for every command and query** (Slice 0), plus a check that no foreign key crosses companies | Usernames are one namespace per database | One database per tenant stays the SaaS model; row-level security optional later | — |
| Supply chain | Frozen lockfile in CI; few dependencies; pnpm blocks build scripts by default | No dependency audit | `pnpm audit` in CI; reviewed update PRs | Slice 0 |

---

## 8. Testing strategy

**What is in place**, and stays:
- unit and property tests for money and GST;
- integration tests on a real, migrated PostgreSQL (one template database, cloned per file);
- concurrency tests with forced interleavings;
- tests for the SQL invariants themselves;
- a role-matrix snapshot;
- a self-contained end-to-end runner (throwaway database, the production build, failure on any server error log);
- manual mutation checks, recorded in the summary PDF.

**What to add:**

| Test type | What it proves | When |
|---|---|---|
| Architecture test | No business write outside a command handler, the documented exceptions or the owning module. No cross-module deep imports. No module imports `ai/`. `ai/` never imports `db/`. | Slice 0 |
| Isolation harness | Every query and command, called with a second company's IDs, returns NOT_FOUND. This runs automatically for each new definition. | Slice 0 |
| Privilege test | The app role cannot disable triggers, truncate or run DDL | Slice 0 |
| Restore drill | Back up → restore into a scratch database → the reconciliation invariants hold → a PDF's hash still verifies | Slice 0, in CI |
| Ledger invariants per slice | Stock: Σ movements = on hand, never negative. Payables: balance = outstanding − unallocated. Make-to-order: work-in-progress reconciles. | Each slice |
| Maker-checker tests | The recorder cannot approve their own entry; both steps are audited | Slice 1 |
| Gateway routing property tests | Over random policies, data classes and health states: **no request above its allowed class ever reaches a cloud adapter**; fallback never widens policy; the budget is never exceeded | Slice 2 |
| Adapter contract tests | Recorded fixtures per provider; no network in CI; the fake provider drives the runtime tests | Slice 2 |
| Copilot evaluation suite | Tool selection and arguments for 50, then 150+ utterances; injection and escalation cases; "figures must cite a tool" checks; run on every prompt or model change (§G.7) | Slice 2 onwards |
| Document-AI gold set | Field-level accuracy and review time; a regression gate when a model changes | Slice 3 |
| CA golden suite | The CA's worked cases, as tests (Round 2 §7.4) | Before parallel run |
| Load smoke test | Expected concurrent users on one node, with AI running alongside | Production track |

**Mutation checks** stay targeted and manual for now: remove a lock or guard, and check that a test fails. A full mutation-testing tool is not worth the dependency at this size.

---

## 9. Decisions needed from you

| # | Decision | My recommendation |
|---|---|---|
| 1 | Approve the slice order in §4 | Yes, as proposed. Revisit after discovery. |
| 2 | Default AI mode for the first factory | **Local only**, with cloud as an explicit per-task opt-in (the existing decision S6) |
| 3 | Default cloud provider for slice 2 | One cloud adapter first (Anthropic), behind the same interface as the OpenAI-compatible adapter, so swapping or adding providers is configuration |
| 4 | How invoices, dispatch and stock relate | Dispatch moves stock; a direct invoice moves it at issue. Needs CA input [VERIFY R-04/R-07]. |
| 5 | Inventory valuation method | Ask the CA (moving average or FIFO); it is needed before slice 1 finishes |
| 6 | Maker-checker scope | Supplier bank details, supplier payments, the readiness switch and role changes from slice 1. Add amount thresholds later. |
| 7 | Keep Tally as the official books (R2-D4)? | Yes for V1; build the Tally export in slice 1 |
| 8 | Refunds and receipt reversal (open since ADR 0002) | Decide with the CA before parallel run |

---

## 10. First steps (slice 0, in order, each small and separately verifiable) — done, see §11

1. Create the private remote, push, and get CI green (§3.2 #12).
2. Split the database roles and move migrations to the owner role. Add the privilege test (§3.2 #1).
3. Backup and restore scripts, plus the restore-drill test (§3.2 #2).
4. The architecture test, a public `index.ts` per module, and moving the KPI contract to `platform/` (§3.2 #5).
5. The isolation harness over every query and command (§7).
6. Edit and archive for parties and items; the supplier screen (§3.2 #3).
7. User and role administration; changing your own password; failed-login audit and backoff (§3.2 #4, #10).
8. Document permissions derived from the owning entity; the FAILED-outbox view and retry; PDF rendering outside the lock (§3.2 #6, #7).
9. Snapshot consistency for reports (§3.2 #8).
10. AI seams: `dataClass` on queries, RESTRICTED markers, and `packages/ai` interfaces with the pure `route()` function and property tests (§5.11).
11. Fix the documentation drift in ARCHITECTURE.md and the README (§3.2 #11).

Readiness per capability (§3.2 #9) waits until the step before parallel running, because it depends on the CA.

---

## 11. Slice 0 — what was built, and the decisions it settled (7 October 2026)

No new business module. Every item went through the command bus, has tests, and kept every
existing test green. Final state: **385 automated tests and 44 browser checks pass**.

| # | Task | Result | Where |
|---|---|---|---|
| 1 | Database privileges | Owner and runtime roles; startup refuses a privileged runtime role in production; privilege drift tests | `db/migrations/0007_runtime_role.sql`, `apps/core/src/db/roles.ts`, `db/privileges.int.test.ts` |
| 2 | Backup and restore | Snapshot-consistent dump + blobs + manifest, file verification, restore drill, restore into a new database | `apps/core/src/ops/`, README "Backup and restore" |
| 3 | Architecture boundaries | Public `index.ts` per module, table ownership, write placement, no cycles, outbox for side effects, AI rules | `apps/core/test/architecture.ts`, `src/architecture.test.ts` |
| 4 | Multi-company isolation | Every registered command and query attacked with another company's identifiers; fingerprint of the victim's rows; every cross-company foreign key checked | `apps/core/src/isolation.int.test.ts`, `src/registry.ts` |
| 5 | Master data editing | Edit, archive, reactivate for parties and items; supplier view | `modules/parties`, `modules/catalog`, web parties and items screens |
| 6 | Users and roles | Create, roles, deactivate, reset, own password change, forced change, backoff, sign-in audit | `modules/identity/admin.ts`, migration 0008, web Users & roles |
| 7 | Document permissions | Access from the owning record; deny by default | `modules/documents/access.ts` |
| 8 | Outbox reliability | Company on every event, failures audited, list and retry, dashboard warning | migration 0009, `modules/operations`, web Background jobs |
| 9 | PDF locking | Render outside any lock, attach in a short transaction; proven by a test that fails on the old code | `sales/pdf/pdf-handler.ts`, `sales/pdf-locking.int.test.ts` |
| 10 | Report snapshots | Every query in one read-only repeatable-read transaction | `platform/queries.ts`, `platform/query-snapshot.int.test.ts` |
| 11 | AI seams | `dataClass` on every query, RESTRICTED credential fields, `examples`, `packages/ai` interfaces and pure `route()` with property tests | `packages/contracts/src/data-class.ts`, `packages/ai` |
| 12 | AI tier rule | Static checks on the registry and a runtime test that every non-DRAFT command and FORBIDDEN query refuses the AI | `src/registry.test.ts`, `src/isolation.int.test.ts` |

### 11.1 Decisions settled

- **Role model.** Owner (migrations, backups, restores) and runtime (rows only). In development the
  owner is the Docker superuser for convenience; production needs a dedicated non-superuser owner.
  The runtime has UPDATE on exactly one append-only column, `finance.receipts.id`, because
  PostgreSQL requires UPDATE privilege for `SELECT … FOR UPDATE`; an actual update is still
  refused by the trigger, and a test pins this as the only exception.
- **Module ownership.** Each table has one owning module; only that module writes it, on the
  transaction it was given. Cross-module writes call the owner's public function in the same
  transaction. Reads may cross modules.
- **Isolation.** A new command or query without an isolation case fails the suite.
- **Passwords.** Administrators set first and temporary passwords; the server never returns or
  stores one in plain text. RESTRICTED fields are kept out of idempotency hashes and logs.
- **Sign-in protection.** Per-IP limit (configurable, default 10/min) plus per-username backoff that
  treats unknown usernames like real ones. It delays rather than locks, so nobody can lock an
  employee out for good.
- **Documents.** `document.read` was removed; reading a document needs the permission of its
  owning record. Uploads stay unreadable until Slice 3 gives them owners.
- **Queries** are read-only snapshots; **PDFs** are side effects that never hold a financial lock.
- **AI boundary.** Business modules never import AI code; AI code never imports the database and
  reaches data only through the buses and module APIs; `packages/ai` depends only on contracts and
  Zod. RESTRICTED results are never readable by the AI.

### 11.2 Remaining risks

- CI has never run (no remote yet, by instruction).
- No off-site or scheduled backups, no WAL archiving, no monitoring outside the app.
- No TOTP; the per-IP limit needs the real client IP once a tunnel is in front.
- Production deployment (non-superuser owner, TLS, tunnel, secrets) is not built.
- Customers have one address; there is no maker-checker yet.
- Nothing is production tax-ready: GST rates are demo data and PDFs remain SPECIMEN until the CA gate.

### 11.3 Next: Slice 1 — procure-to-pay with a real stock ledger (§4.3) — done, see §12.

---

## 12. Slice 1 — procure-to-pay and the inventory write path (9 October 2026)

Supplier → PO → approval → GRN → stock → purchase invoice → three-way match → supplier
payable → supplier payment (maker-checker) → allocation → outstanding. No architectural change:
every write goes through the command bus, every table has one owning module, side effects use
the outbox and documents use the existing access rules. Final state: **504 automated tests (178 unit, 326 integration) and 58 browser checks pass, with zero server error log lines**.

| Area | Result | Where |
|---|---|---|
| Inventory write path | `recordStockMovements(tx, …)` is the only way to move stock; append-only ledger with UOM, source type/id/line, reference and actor; SQL sign, company and uniqueness checks; negative-stock guard (advisory locks, then sum); compensating adjustments; seed uses the same API | migration 0010, `modules/inventory` |
| Purchase orders | Lifecycle below; approval separate from drafting; gapless numbering with a concurrency test; frozen by SQL once approved | migration 0011, `modules/purchasing/orders` |
| Goods receipts | Accepted/rejected split, no over-receipt (command + FO006), status follows accepted quantity | `modules/purchasing/receipts` |
| Purchase invoices | PO-based and direct paths, duplicate-bill key, shared GST engine, three-way match, override with reason | migration 0012, `modules/purchasing/invoices` |
| Payables | Append-only supplier payable ledger (owned by finance), balances views, summary and open-bill queries, KPIs | `modules/finance/payables-ledger.ts`, `modules/payables` |
| Supplier payments | Request → approve/reject by a different user; full, partial, multi-bill, on-account; FO005 | `modules/payables` |
| Bank details | RESTRICTED, maker-checker, superseded not edited, masked results and audit, log redaction, FORBIDDEN to the AI | migration 0013, `modules/parties/bank-accounts.ts` |
| PO PDF | Rendered through the outbox (two-phase handler), SPECIMEN watermark, access via the owning order | `modules/purchasing/pdf` |
| UI | Suppliers, Purchase orders, Goods receipts, Supplier bills, Payables, Supplier payments, Stock; command palette entries; the browser only previews | `apps/web/src/features/{purchasing,payables,inventory}` |
| Demo data | Six POs (one draft, one short-closed), four GRNs (one with rejections, one partial), six bills (one accepted with a price difference, one direct, one draft), four payments (full, partial, advance, one awaiting approval), bank details (one approved, one pending) | `seed/demo-data.ts` |

### 12.1 Decisions settled

- **PO lifecycle.** `DRAFT → APPROVED → PARTIALLY_RECEIVED → RECEIVED`; `APPROVED | PARTIALLY_RECEIVED → CLOSED` (short-close, reason); `DRAFT | APPROVED` with nothing received `→ CANCELLED` (reason). Numbered at approval, in PO-date order.
- **Receiving.** Received = accepted + rejected. Only accepted quantity counts against the order and enters stock. Over-receipt is not permitted in V1; making it an explicit permission is a later decision.
- **Purchase invoice numbering** follows the **posting date**, not the supplier's bill date, because bills arrive out of order. **Supplier payment numbers** follow the approval date for the same reason. Ledger entries keep the bill and payment dates.
- **Three-way match** compares the bill with the order and with everything accepted on the order (one bill may cover several deliveries). Findings: not on the order, different item, more than received, price above the order, total differs. Tolerances are company data (defaults: 0 %, 0 %, ₹1) for the CA to set. Nothing is decided by a model.
- **Maker-checker** for supplier payments and supplier bank details: requester ≠ approver, checked in the command and by a SQL CHECK. Both steps are audited.
- **Ownership.** purchasing owns orders, receipts and purchase invoices; inventory owns warehouses and stock movements; finance owns the payable ledger; payables owns supplier payments and allocations; parties owns bank details.

### 12.2 Remaining risks and open points

- CA / regulatory: input tax credit and place of supply on purchases [VERIFY R-05], reverse charge [VERIFY R-11], TDS [VERIFY R-17], MSME payment timelines [VERIFY R-18], match tolerances, advances to suppliers, bank identifier formats [VERIFY R-25].
- No purchase returns or debit notes, PO amendments, approval thresholds, supplier refunds or payment runs.
- No stock valuation, transfers or batches; sales still do not consume stock (Slice 2).
- Bank-detail changes are audited but do not yet alert the owner (no notification channel).
- CI has still never run; production deployment is not built.

### 12.3 Next: Slice 2, on the owner's go-ahead.
