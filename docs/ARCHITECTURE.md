# Factory ERP — Master Architecture

**Status:** working architecture. **Implementation started on 2026-10-05.** Factory discovery is deferred because this is a surprise prototype (see `docs/discovery/README.md`).
- Every factory-specific assumption in this document is **provisional**.
- Development uses clearly labelled synthetic demo data.
- Version decisions are recorded in `docs/adr/0001-foundation-stack-and-versions.md`.

**Date:** 2026-10-05
**Scope:** The architecture for the whole product and a phased delivery plan.

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-10-05 | First proposal, sections A–S |
| v0.2 | 2026-10-05 | Architecture Review Round 2: decisions confirmed and deferred, Factory V1 / SaaS Later boundary, revised topology, version-agnostic stack, regulatory verification register, CA validation gate, outage matrix, hardware-adaptive AI, hostile review, discovery questionnaire and data checklist |
| v0.3 | 2026-10-05 | **Building started.** Discovery deferred (surprise prototype). Phase 0 foundation and the first vertical slice are implemented: auth/RBAC → parties → items → invoice draft → GST → issue → PDF → audit → dashboard. See the README. |
| v0.4 | 2026-10-07 | Renamed **Factory ERP**. Sales-to-cash receivables loop and the **sales correction path** (invoice cancellation, credit notes) implemented — see `docs/adr/0002-sales-correction-path.md`. G.2 updated: invoice cancellation is CONFIRM. |
| v0.5 | 2026-10-07 | **Slice 0 — hardening** (see `docs/ROADMAP.md` §11). Least-privilege runtime database role (P), backup and restore with a restore drill, module rules now enforced by a test (E.3), multi-company isolation harness, master-data editing and user administration, document access derived from the owning record, outbox failure handling, one read-only snapshot per query, and the AI seams (`dataClass` on queries, RESTRICTED fields, `packages/ai` with the pure routing policy, G.1). Jobs use the transactional outbox, not pg-boss (ADR 0001). |

**How to read this document:**
- Sections A–S are the base proposal, already edited for Round 2.
- **Architecture Review — Round 2** at the end is **authoritative wherever the two conflict**. ADRs will consolidate both.
- `[VERIFY R-nn]` marks a regulatory claim that must be confirmed against official sources before implementation (Round 2 §6). Every number tagged this way is a placeholder, not a fact.
- **The discovery documents live in separate files**, so they can be printed and taken to the factory:
  - [`docs/discovery/factory-discovery-questionnaire.md`](discovery/factory-discovery-questionnaire.md)
  - [`docs/discovery/data-collection-checklist.md`](discovery/data-collection-checklist.md)

---

## 0. Repository assessment

| Finding | Detail |
|---|---|
| Repository contents | Empty. `Factory Dashboard/` has no files, hidden or otherwise. |
| Version control | Not a git repository. |
| Existing technology choices | None. There are no code, configs, schemas or docs to keep or migrate. |
| Dev machine | Apple M4 with 16 GB RAM, macOS 26.5, 89 GB free disk. Installed: Node 24.12, npm 11.6, Python 3.13.9, uv 0.12, Docker 29.6 (daemon not running), git 2.52 and the Ollama CLI (daemon not running). No local `psql`. |

What this means:
- The project starts from scratch. No code exists yet, so no risk comes from existing code. The risks come from scope, domain correctness and operations (see R).
- Every choice in this document is a proposal. After approval, each major decision becomes an ADR in `docs/adr/`.
- The dev machine is fine for development, with Postgres running in Docker. It does **not** represent factory hardware. AI performance has to be benchmarked on the real target machine.
- The tool versions listed above describe the dev machine. They are **not** version decisions.
- The dev machine is ARM64, and the factory server will probably be x86-64. Container images and Python ML wheels must therefore build for both architectures.

### 0.1 Assumptions (please correct)
1. The factory is in India and registered for GST under the regular scheme. The first tenant has one GSTIN or a few.
2. The books are kept today in Tally (or similar) by an in-house accountant and/or an external CA.
3. The factory has tens to a few hundred employees, fewer than 50 concurrent system users, and up to a few thousand invoices a month.
4. Workers mostly carry Android phones and office staff use Windows PCs. Wi-Fi on the shop floor is patchy.
5. Internet and grid power can each be down for hours at a time.
6. A small team (1–3 engineers plus AI assistance) builds and maintains the system.

These are placeholders. Factory Discovery (Round 2 §11) replaces them with facts. **No business workflow gets implemented on an assumption.**

### 0.2 Architectural principles
1. **One source of truth and one writer per tenant.** Business data is never replicated multi-master.
2. **AI proposes, deterministic code computes and validates, and humans approve** anything with consequences.
3. **Every mutation is a typed command**: validated, authorized, transactional, idempotent and audited. HTTP endpoints and AI tools are both thin adapters over the same commands.
4. **Money and stock are append-only ledgers.** Corrections are new entries, such as reversals and credit notes, never edits.
5. **The core works with no AI and no internet.** AI and cloud add capability. They never become something the system needs in order to stay up.
6. **Anything set by law or policy is effective-dated data**, never a constant in code. This covers tax rates, numbering rules and approval thresholds.
7. **Use the fewest moving parts that meet the requirements**: one database, one application process and optional sidecars.

---

## A. Technology stack

| Concern | Proposal | Why | Considered or rejected |
|---|---|---|---|
| Server language | TypeScript (strict) on a Node.js **Active LTS** release, chosen at ADR time | One language for the UI, the API, the shared calculation code and the AI tool schemas. Strong typing and a large hiring pool. | Python/FastAPI is a credible alternative (S2). Go builds a great single binary but is slower for CRUD-heavy ERP work. Java and .NET are heavier. |
| HTTP framework | Fastify | Fast, explicit, schema-first and mature | NestJS adds structure through decorator magic. Express is dated. |
| Contracts | Zod schemas (a release with native JSON Schema export) generating OpenAPI 3.x and JSON Schema | One schema drives API validation, generated client types, forms and AI tool definitions | Hand-written OpenAPI. tRPC works only for TypeScript and is a poor fit for AI and integrations. |
| Database | PostgreSQL: a supported major release with at least 3 years of community support left, chosen at ADR time | Transactional DDL, rich constraints, NUMERIC, JSONB, full-text search and `pg_trgm`, all present in every supported major. UUIDv7 is generated **in the application**, so no particular major is needed. Runs on modest hardware. | MySQL. SQLite is great locally but weak for concurrent multi-user writes and has no server roles. MongoDB is ruled out. |
| Database access | Kysely (typed SQL builder) with kysely-codegen, and migrations in plain SQL | The database schema is the source of truth and the types are generated from it. No ORM magic sits between us and financial queries. | Prisma has a heavier runtime and weaker support for constraints and triggers. Drizzle is fine, but defining the schema in TypeScript inverts our "database first" approach. |
| Decimal math | `decimal.js` wrapped in `Money`, `Qty` and `Rate` value types | The JavaScript `number` type is forbidden for money and quantities | Integer paise is workable, but rates and per-kg prices need more decimal places. |
| Jobs and queue | **As built:** a transactional outbox table in Postgres, polled with `FOR UPDATE SKIP LOCKED` (ADR 0001). pg-boss only if scheduling needs outgrow it. | Durable jobs without adding Redis; the outbox commits with the business change | BullMQ with Redis. Temporal is overkill. |
| Realtime | **V1:** short polling, or Server-Sent Events if needed. **Later, with chat:** WebSocket from core plus Postgres `LISTEN/NOTIFY`. | V1 notifications and dashboards don't need sub-second push (Round 2 §10.2) | A separate pub/sub broker |
| Web app | React and Vite SPA with TanStack Router, Query and Table, shadcn/ui with Tailwind, installable as a PWA | The same bundle is served on the LAN and remotely, with an offline shell and no SSR server | Next.js needs an SSR runtime we don't need. Native mobile apps can come later, if ever. |
| PDF | Typed React templates rendered to static HTML, then printed by headless Chromium (Playwright) | Familiar HTML and CSS, print CSS and correct shaping of Indic scripts | Typst is lighter and worth revisiting. pdfmake and React-PDF have layout limits. |
| TLS and reverse proxy | Caddy | Automatic certificates and simple config | nginx is fine but needs more config. |
| Remote access | Outbound tunnel (Cloudflare Tunnel in v1) | No open ports, works behind ISP CGNAT, and costs nothing | Port forwarding is insecure and often impossible. A self-hosted WireGuard relay is an option (S5). |
| Document AI sidecar | Python with FastAPI, managed by uv. The Python version is whatever the chosen OCR/ML libraries support, which is often not the newest. | The OCR, vision and solver ecosystem is in Python | OCR in Node is immature. |
| LLM runtime | Any local runtime with an OpenAI-compatible API. Candidates are Ollama, llama.cpp server and vLLM, **chosen after benchmarking the factory hardware**. A cloud provider sits behind the same gateway, used only where policy allows. | The architecture depends on the API shape, not on a product or version | Bespoke runtimes |
| Backups | pgBackRest for the database (point-in-time recovery, encrypted) and restic for files, both going to S3-compatible object storage in an India region with object lock | Point-in-time recovery that resists ransomware | A nightly `pg_dump` alone. It is kept as a secondary copy. |
| Packaging | Docker Compose on Ubuntu Server LTS | Reproducible. The same images run in dev, staging, the factory and cloud nodes. | Kubernetes is ruled out. Bare installs drift. |
| Repo tooling | pnpm workspaces, ESLint and Prettier, an architecture test for module boundaries (no extra tool), GitHub Actions | | Nx and Turborepo aren't needed at this size. |
| Tests | Vitest, fast-check (property tests), Testcontainers (real Postgres), Playwright (E2E), pytest | | Database mocks. We test against real Postgres. |

**Version policy:** this table fixes component *families* only.
- Major versions are chosen and verified when the ADR is recorded, using the checklist in Round 2 §5.
- Exact versions are then pinned in lockfiles and image digests.

The stack deliberately **leaves out** Redis, Kafka, Kubernetes, microservices, GraphQL, a separate vector database (`pgvector` covers it if needed), CRDT or sync engines, and LLM orchestration frameworks. Our agent loop is small, auditable code.

---

## B. System architecture

Factory V1 topology. Round 2 §3 has the detailed path analysis.
```
 REMOTE: owner/staff on 4G or at home              LOCAL: phones, office PCs, floor tablets on factory LAN/Wi-Fi
   https://dashboard.factorydomain.com               https://dashboard.factorydomain.com   (same URL, same app)
        │ public DNS                                        │ factory DNS (router or node) → node LAN IP
        ▼                                                   │
 ┌─────────────────────────────┐                            │
 │ Tunnel edge (TLS, WAF,      │   CLOUD (V1 = commodity    │
 │ rate limits)                │   services only, no        │
 └──────────────▲──────────────┘   control plane)           │
                │ outbound-only tunnel, started by the node │
════════════════│══════════ factory internet ══════════════│════════════════════════════════
 ┌──────────────┴──────────── FACTORY NODE (on-prem server) ▼───────────────────────────────┐
 │ cloudflared ─▶ Caddy remote listener ─┐        Caddy LAN listener :443 (real cert, DNS-01) │
 │                                       └──▶ core-api ◀──┘   network = remote | lan (by listener)
 │                                            · serves the web app (PWA) + REST API           │
 │                                            · command bus · auth/RBAC · audit · outbox      │
 │                                            · agent runtime · LLM gateway                   │
 │                                       core-worker (same code): jobs · PDF · e-invoice · alerts
 │                                            │                     │                  │       │
 │                                       PostgreSQL            docai (Python, opt.)  llm (opt.)│
 │                                       single source of truth OCR · extraction ·   local    │
 │                                       /data/blobs (files)    solver              runtime  │
 │                                       backup agent ──────────────────────────────┐        │
 └──────────────────────────────────────────────────────────────────────────────────┼────────┘
        heartbeat (outbound) ▼                                    encrypted backups ▼ (outbound)
 External uptime monitor → alerts to owner + us          Object storage (India region, object lock)
 Optional, policy-gated: cloud LLM API             Optional: GSP/ASP APIs (e-invoice, e-way bill)
```

### B.1 Topology
- **Factory node (on-prem)** holds the single source of truth. It runs `core-api`, `core-worker`, `postgres`, `caddy`, `cloudflared` and `backup`, and optionally `docai` and `llm`. **It serves the web app itself** on both access paths, with no separately hosted frontend (Round 2 §3).
- **Cloud in Factory V1** is only commodity services: DNS, the tunnel edge, encrypted backup storage, an external uptime monitor, and optionally a cloud LLM API and GSP/ASP APIs. **None of them is needed for LAN operation.**
- **SaaS Later:** a control plane (tenant registry, enrollment, fleet updates, billing) and cloud-hosted nodes for factories without suitable hardware. A cloud-hosted node is the same image running in the cloud. Round 2 §4 sets out this boundary and the seams V1 keeps open for it.

### B.2 The core is a modular monolith
There is one codebase with two entrypoints: an API process and a worker process. Modules talk to each other in-process through public interfaces. An invariant that spans modules commits in a single database transaction. We split out a service only when there is a measured reason, and today there are none.

### B.3 Example flow: "Create an invoice for ABC Industries for 500 units"
1. The chat UI sends `POST /api/v1/ai/sessions/{id}/messages` with the user's session cookie.
2. The agent runtime sends the conversation and **only the tools this user is permitted to use** to the LLM gateway.
3. The model calls `search_parties({query: "ABC Industries", role: "customer"})` and gets one match. It then resolves "units" through `search_items` or `list_open_sales_orders`. If anything is ambiguous, it asks a clarifying question. It never invents IDs.
4. The model calls `prepare_sales_invoice`, which runs the command `sales.invoice.createDraft` through the command bus. The bus validates with Zod, authorizes **as the user**, applies business rules (credit limit, stock, price list), has the **GST engine compute totals deterministically**, persists the draft and writes an audit event (`actor=user, via=ai_session`).
5. The UI renders an **action card from the persisted draft**. The figures come from the database, not the model. The model's text is commentary only.
6. The user clicks **Issue**. The browser calls `POST /api/v1/sales-invoices/{id}/issue` with an idempotency key. This is a human action, not a model action.
7. One transaction then assigns the gapless number, snapshots party and item details, posts the journal, records the stock movement (unless a dispatch already did), writes the audit row and adds the outbox event `SalesInvoiceIssued`.
8. The worker consumes the outbox event. It renders the PDF (stored and hashed), requests the e-invoice IRN if applicable (queued if offline) and sends notifications.
9. The user sees a confirmation with the invoice number, total and PDF link.

### B.4 Client experience principles
- **Office screens are keyboard-first.** Accountants are used to Tally's speed, so invoice and voucher entry must work without a mouse.
- **Floor screens are touch-first**, with big targets, minimal typing, photos and pick lists. Voice input can come later.
- The UI uses `en-IN` formatting (lakh/crore grouping), shows times in IST and prints amounts in words on documents.
- Translatable strings are externalized from day one, even if v1 ships only in English.

---

## C. Domain model

### C.1 Bounded contexts

| Context | Main aggregates and entities | Notes |
|---|---|---|
| Platform | Tenant, Company (legal entity with GSTIN, state, PAN and fiscal year), Location (plant, office or warehouse), Setting, NumberSeries | Multiple GSTINs and plants from day one |
| Identity and access | User, Credential, Session, Device, Role, Permission, RoleAssignment (scoped), ServiceAccount | A user is not the same thing as an employee. |
| Parties | Party (roles: customer, supplier, job worker, transporter), GST registrations, Address, Contact, BankAccount, credit terms | Customers and suppliers share one table, because MSMEs often buy from and sell to the same firm. |
| Catalog | Item (raw material, component, WIP, finished good, consumable, spare or service), UoM, UoM conversion, HSN/SAC, TaxRate (effective-dated), PriceList, SupplierItemAlias | |
| Inventory | Warehouse and bin, StockMovement (the ledger), StockBalance (derived), Batch/Lot, Transfer, Adjustment, PhysicalCount | Valuation method is decision S9. |
| Procurement | PurchaseOrder, GoodsReceipt (GRN), PurchaseInvoice, DebitNote and PurchaseReturn, job-work challan | Three-way match of PO, GRN and invoice |
| Sales | Quotation (later), SalesOrder, DeliveryChallan/Dispatch, SalesInvoice, CreditNote, e-invoice and e-way bill records | |
| Production | BOM (versioned), Routing/Operation (later), WorkOrder, MaterialIssue, ProductionEntry (good, reject and scrap per shift, machine and operator), DowntimeEvent | Feeds a simplified OEE (availability, performance, quality). |
| Assets and maintenance | Machine, MeterReading, MaintenanceTicket, PMPlan, Checklist, SparePartUsage | |
| Quality | InspectionPlan, Inspection (incoming, in-process, final), NonConformance, ReasonCode | |
| Workforce | Employee (permanent, contract or trainee, paid daily, monthly or piece-rate), Department, Skill, Shift, Roster, AttendanceRecord, Allocation | Payroll is deferred (S13). |
| Finance | Account (chart of accounts), JournalEntry and JournalLine, Payment/Receipt, BillAllocation, Expense, BankAccount, FiscalYear and PeriodLock | Double-entry from the start |
| Documents | Document, DocumentVersion, DocumentLink, ExtractionJob, ExtractionProposal, ReviewDecision | |
| Collaboration | **V1:** Notification, Announcement, Comment (entity thread), Mention, Task. **Later:** Channel, direct message, group chat, attachments, search, AI understanding. | One conversation/message model serves both (E.6). |
| Analytics | KPI definitions, Alert, Exception, daily snapshots, activity feed | Owns no business logic. It consumes each module's insights contract (E.5). |
| AI | AgentSession, AgentTurn, ToolInvocation, PendingAction, ModelConfig, EvalRun | |
| Audit and system | AuditEvent, OutboxEvent, IdempotencyKey, Job | |

### C.2 Core flows
> **Illustrative only.** The flows and lifecycles in C.2 and C.3 are generic patterns for manufacturing businesses. They show the *shape* of the model. The factory's actual workflows come from discovery (Round 2 §11) and replace these before any module is built.
```
Procure-to-pay  PurchaseOrder ─▶ GoodsReceipt (GRN) ─▶ Inspection ─▶ PurchaseInvoice ─▶ Payment
                      └──────────── three-way match ───────────────────────┘
Order-to-cash   SalesOrder ─▶ WorkOrder(s) ─▶ ProductionEntries ─▶ Dispatch ─▶ SalesInvoice ─▶ Receipt
Make            BOM(version) ─▶ WorkOrder ─▶ MaterialIssue (RM→WIP) ─▶ ProductionReceipt (WIP→FG) + scrap/rejects
Maintain        Machine ─▶ Ticket / PM plan ─▶ spare-part issue (stock) ─▶ downtime record (production)
People          Employee ─▶ Shift/Roster ─▶ Attendance ─▶ Allocation (machine/work order) ─▶ ProductionEntry
Every step      ─▶ Journal posting (where financial) · StockMovement (where physical) · AuditEvent (always)
```

### C.3 Lifecycles (explicit state machines in domain code, changed only by commands)
- **SalesInvoice**: `DRAFT → ISSUED → CANCELLED`. It also carries `einvoice_status` (`NOT_APPLICABLE | PENDING | REGISTERED | FAILED | CANCELLED`). Payment status (unpaid, partial or paid) is **derived** from allocations, never edited.
- **PurchaseOrder**: `DRAFT → PENDING_APPROVAL → APPROVED → PARTIALLY_RECEIVED → RECEIVED → CLOSED`, plus `CANCELLED`.
- **WorkOrder**: `DRAFT → RELEASED → IN_PROGRESS → COMPLETED → CLOSED`.
- **MaintenanceTicket**: `OPEN → ASSIGNED → IN_PROGRESS → RESOLVED → VERIFIED`, plus `REOPENED`.
- **ExtractionProposal**: `QUEUED → EXTRACTED → NEEDS_REVIEW → APPROVED | REJECTED`. Approval creates a *draft* document.

### C.4 Modeling rules
- **Issued documents snapshot everything printed on them**: party name, address, GSTIN, item description, HSN and rates. Editing master data never rewrites history.
- **Quantities carry their UoM** and conversions are explicit per item (for example pcs → kg). Document lines record the billing quantity plus an optional alternate quantity and net weight.
- **Business dates are `date` values in IST. Event times are `timestamptz` in UTC.**
- An employee can exist without a login, such as most workers. A user can exist without an employee record, such as the external CA.

---

## D. Database architecture

### D.1 Conventions

| Topic | Rule |
|---|---|
| Schemas | One Postgres schema per module: `platform`, `identity`, `party`, `catalog`, `inventory`, `purchase`, `sales`, `production`, `maintenance`, `quality`, `workforce`, `finance`, `docs`, `collab`, `ai`, `audit` and `system`. |
| Keys | `uuid` primary keys holding UUIDv7 values. The application generates them, so this works on any Postgres major. They are time-ordered, clients can generate them offline, and they stay globally unique, so merging tenants later is safe. Human-readable numbers such as `INV/26-27/00042` live in separate unique columns. |
| Numeric types | Money is `NUMERIC(18,2)`, rates are `NUMERIC(18,4)`, quantities are `NUMERIC(18,3)` and tax percentages are `NUMERIC(6,3)`. |
| Time | `timestamptz` for events and `date` for business dates. Display uses `Asia/Kolkata`. |
| Enums | `text` with a `CHECK` constraint, or lookup tables. Postgres enums are painful to evolve. |
| Concurrency | Mutable aggregates carry a `version` column for optimistic locking. Sequences and stock balances use `SELECT … FOR UPDATE`. |
| Standard columns | `created_at`, `created_by`, `updated_at` and `updated_by`, plus `company_id` on all company-scoped data. |
| Deletion | No soft-delete flags scattered across tables. Masters are archived with a `status`. Transactions are cancelled or reversed. Only drafts may be hard-deleted. |

### D.2 Integrity enforced in the database, not only in code
- **Foreign keys everywhere**, including across module schemas. Integrity matters more than purity here.
- **CHECK constraints** cover positive quantities, debit XOR credit, valid states and GSTIN format.
- **Unique constraints** include `(company_id, doc_type, series_code, fiscal_year, number)`. `(supplier_gstin, supplier_invoice_no, fiscal_year)` catches duplicate bills.
- A **deferred constraint trigger** checks that every journal entry balances (Σ debit = Σ credit).
- **Immutability triggers** reject UPDATE and DELETE on the financial columns of issued documents and on all ledger tables.
- **Exclusion constraints** are used where they fit naturally. For example, a machine can't have overlapping allocations: `EXCLUDE USING gist (machine_id WITH =, period WITH &&)`.
- **Database roles:**
  - `ferp_migrator` runs DDL.
  - `ferp_app` does DML but has **no UPDATE or DELETE** on `audit.*`, `finance.journal_lines` and `inventory.stock_movements`.
  - `ferp_reporting` is read-only on reporting views. Analytics and the AI's read tools use it.

### D.3 Ledger-style tables (sketch)
```sql
-- Gapless numbering: one row per company × doc type × series × fiscal year,
-- locked FOR UPDATE inside the issuing transaction.
create table system.number_series (
  id           uuid primary key,        -- UUIDv7, generated by the application
  company_id   uuid not null references platform.companies(id),
  doc_type     text not null,          -- 'SALES_INVOICE', 'CREDIT_NOTE', ...
  series_code  text not null,          -- 'DEFAULT', 'EXPORT', ...
  fiscal_year  text not null,          -- '2026-27'
  format       text not null,          -- '{prefix}/{fy_short}/{seq:5}', validated against the GST numbering rule set [VERIFY R-02]
  next_value   bigint not null default 1,
  unique (company_id, doc_type, series_code, fiscal_year)
);

-- Append-only audit trail, written in the same transaction as the change it records.
create table audit.events (
  id             uuid primary key,      -- UUIDv7, generated by the application
  occurred_at    timestamptz not null default now(),
  actor_user_id  uuid,                 -- the accountable human
  actor_kind     text not null check (actor_kind in ('user','ai_agent','system','integration')),
  ai_session_id  uuid,                 -- set when the command arrived via the copilot
  request_id     text not null,
  command        text not null,        -- 'sales.invoice.issue'
  entity_type    text not null,
  entity_id      uuid not null,
  before         jsonb,
  after          jsonb,
  prev_hash      bytea,
  hash           bytea not null        -- hash chain for tamper evidence (serialized via advisory lock)
);
```

### D.4 Tenancy
- **Each tenant gets its own database.** A factory node holds exactly one tenant's database, and each cloud-hosted tenant also gets its own. This means:
  - No `tenant_id` columns.
  - No risk of cross-tenant queries.
  - Backup, restore and export are trivial per tenant.
  - The code is identical on-prem and in the cloud.
- `company_id` (the legal entity) partitions finance and documents within a tenant.
- **SaaS Later:** the control plane will have its own small database for tenants, nodes, releases and subscriptions. Factory V1 has no control plane.
- The trade-off is that a release must migrate hundreds of databases. That is fine up to the low thousands of tenants with a migration orchestrator. Shared schema with row-level security is still possible later for a "lite" SaaS tier.
- Round 2 §4.3 evaluates this choice at 1, 10, 100 and 1,000 factories, sets the triggers for revisiting it, and lists the V1 seams that keep it changeable.

### D.5 Search and reporting
- `pg_trgm` and full-text search provide fuzzy lookup of parties, items and machines. This is essential for AI entity resolution and OCR matching, for example "Sharma Ind." → the right party.
- Reporting uses SQL views and materialized views refreshed by jobs, plus daily snapshot tables for trends (stock value, receivables, production). No data warehouse until the data shows we need one.
- `pgvector` comes in only if semantic search over documents or messages is approved later.

### D.6 Migrations
- Migrations are forward-only, numbered plain SQL. Core runs them at startup in maintenance mode. Postgres DDL is transactional, so a failed migration rolls back cleanly.
- Every release takes an automatic backup snapshot before migrating. CI applies migrations both to an empty database and to the previous release's schema with seed data.

---

## E. Module architecture

### E.1 Repository layout
```
factory-erp/
├─ apps/
│  ├─ core/            # Fastify API + worker entrypoints (one codebase, two processes)
│  ├─ web/             # React PWA
│  ├─ docai/           # Python sidecar: OCR, layout, extraction, allocation solver
│  └─ (control-plane/) # SaaS Later only — not created in Factory V1
├─ packages/
│  ├─ contracts/       # Zod schemas: commands, queries, DTOs, error codes (shared by core, web, AI tools)
│  ├─ money/           # Money / Qty / Rate value types (decimal.js)
│  ├─ gst/             # pure GST + invoice calculation engine — zero I/O, exhaustively tested
│  └─ ui/              # shared UI components
├─ db/migrations/      # plain SQL
├─ deploy/             # compose files, Caddyfile, installer CLI, runbooks
└─ docs/               # architecture, ADRs, runbooks, domain glossary
```

### E.2 Inside a module
```
apps/core/src/modules/sales/
├─ domain/        # pure: entities, value objects, state machines, rules — no I/O, no framework imports
├─ application/   # commands & queries: validate → authorize → load → domain → persist → audit → outbox
├─ infra/         # Kysely repositories, external adapters (e-invoice provider, …)
├─ http/          # thin route adapters
├─ tools/         # AI tool metadata for this module's commands/queries (thin)
└─ index.ts       # the module's public API — the only file other modules may import
```
`apps/core/src/platform/` holds the cross-cutting infrastructure: command bus, auth, RBAC, audit, outbox, jobs, database, config and logging.

### E.3 Module rules (enforced by `apps/core/src/architecture.test.ts`)
**As built (Slice 0)** — a small test over the source, not a dependency-analysis tool:
- **A module writes only the tables it owns** (`TABLE_OWNERS`, one owner per table; every table in the schema must have one). Writes happen on the transaction the command bus (or an outbox handler) provides; modules do not open their own.
- **Other modules are reached only through their `index.ts`**, and there are no dependency cycles between modules.
- **Invariants that span modules commit in one transaction** through the owning module's public functions — for example, issuing an invoice calls the finance module to post the customer ledger, and the PDF handler calls the documents module to record the PDF. Side effects that may lag, such as PDFs, notifications, e-invoices and sync, go through the **outbox**; commands may not render PDFs or write blobs.
- **Reads may cross modules** (queries and views join freely, read-only). Query files never write, and every query runs in a read-only snapshot.
- **Platform and `db/` never depend on business modules.** Business modules never import AI code; AI code reaches business data only through the buses and module APIs, never the database.
- Not adopted: a separate `domain/` vs `infra/` folder inside each module. Pure rules live in their own files (for example `sales/credit-notes/rules.ts`), which has been enough so far.

**Intended layering** (each layer may use only the layers below it; modules not built yet in italics):
  1. platform
  2. parties · catalog · finance (customer ledger) · documents · identity · company
  3. *inventory*
  4. sales · receivables · *purchase · production · maintenance · quality · workforce · collaboration*
  5. analytics · operations
  6. *ai*

### E.4 The command bus is the spine
Every mutation is registered exactly once:
```ts
export const issueSalesInvoice = defineCommand({
  name: 'sales.invoice.issue',
  input: z.object({ invoiceId: Uuid, expectedVersion: z.number().int() }),
  permission: 'sales.invoice.issue',
  ai: { exposed: true, tier: 'CONFIRM' },   // a human must click; the model cannot execute it
  handler: async (ctx, input) => { /* domain logic inside one transaction */ },
});
```
The bus wraps every handler in the same steps:
1. Schema validation
2. Auth context
3. Authorization (RBAC, scope and policy)
4. Idempotency check
5. Database transaction
6. Audit write
7. Outbox event
8. Structured log

HTTP routes and AI tools are generated adapters over this registry. That gives two guarantees: **the AI can never do anything the API can't, and it can never skip a check the API performs.** Queries (reads) have a parallel registry with the same authorization path.

### E.5 Dashboard and analytics contract ("the dashboard comes out of the system")
The dashboard holds no data and no business logic. Each business module implements one **insights contract**, and the `analytics` module only composes, snapshots and renders what modules expose.

```ts
// Implemented by each business module, in modules/<m>/insights.ts
interface ModuleInsights {
  kpis(ctx, period): KpiValue[];            // registered KPI ids only; value + unit + comparison + drill-down query
  alerts(ctx): Alert[];                     // rule-based, deduplicated, acknowledgeable
  trends(ctx, kpiId, range, grain): Series; // read from daily snapshot tables, not recomputed
  recentActivity(ctx, limit): ActivityItem[]; // derived from audit/domain events
  exceptions(ctx): ExceptionItem[];         // items needing a human: owner, age, link, reason
}
```

| Element | Rule |
|---|---|
| **KPI registry** | Every KPI is declared once with an id, a plain-language definition, an owning module, a source view or query, a unit, a grain, the permission needed and optional thresholds. **A KPI with no backing query over real tables cannot be registered.** Each KPI has a test against seeded data. |
| **Alerts** | Scheduled evaluators turn rules into persisted alert records (deduplicated by rule and entity), which feed notifications. Examples: stock below reorder level, receivable overdue, machine down for more than X hours. |
| **Trends** | A daily job writes `analytics.kpi_snapshots(kpi_id, company_id, scope, date, value)`. Historical values stay stable even if master data changes later. |
| **Recent activity** | Derived from audit and domain events and filtered by the viewer's permissions. |
| **Exceptions inbox** | One inbox across modules: e-invoices pending an IRN, offline entries rejected on sync, unreviewed bill extractions, overdue POs, failed backups. This is the operational heart of the dashboard. |
| **Dashboards** | A dashboard is a configuration: role-based layouts of widgets that reference registered KPI, alert, trend and exception ids. A widget is hidden if its module isn't enabled or the user lacks permission. Empty states say "no data yet". **There is no mock data and no placeholder KPIs.** |
| **AI** | The copilot reads the same registry through READ tools (`get_kpi`, `list_alerts`, `list_exceptions`), so the dashboard and the copilot always report the same numbers. |
| **Access** | Analytics reads use the read-only `ferp_reporting` database role. |

### E.6 Communication architecture: V1 now, a full system later
A single model keeps later chat features from needing a data migration:

```
conversations(id, kind, context_entity_type?, context_entity_id?, audience?)  -- V1 kinds: 'entity_thread', 'announcement'
messages(id, conversation_id, author_id, body, mentions[], document_refs[], created_at, edited_at)
tasks(id, title, assignee_id, due_on, status, context_entity_type?, context_entity_id?, source: manual|rule|ai_draft)
notifications(id, recipient_id, kind, payload, read_at)  -- delivered via outbox to in-app / web push / email / WhatsApp adapters
```

| | Factory V1 | Later |
|---|---|---|
| Notifications | In-app inbox and web push, with per-user preferences. Email and WhatsApp adapters when needed. | Quiet hours, digests |
| Announcements | Owner or admin to all staff, a department or a role, with optional read receipts | |
| Comments | Threaded discussion on any entity (PO, invoice, machine, work order) | |
| Mentions | @user and @department inside comments, which create notifications | |
| Tasks | Assignee, due date, status, linked entity. Created by hand, by rules, or as AI drafts that a human confirms. | |
| Channels, DMs, group chat | **Not built.** These become new `kind` values plus a `conversation_members` table, reusing messages, mentions and notifications. | Yes |
| Attachments | References to the Documents module only, with no separate file store | Richer previews |
| Search | Not needed in V1 | Postgres full-text search over messages, filtered by permission |
| AI understanding | Not in V1 | READ tools over messages with permission filtering. Messages are untrusted input (G.3 rule 5). |
| Realtime | Polling | WebSocket |

Build versus integrate for later chat is still open. Embedding a self-hostable open-source chat server is an option (Round 2 §10.5). The V1 model doesn't rule either option out.

---

## F. API architecture
- **Style and contract:** REST with JSON over HTTPS under `/api/v1`. The OpenAPI 3.1 spec is generated from `packages/contracts`, and the web client is generated from that spec.
- **Command endpoints:** resources are read through normal REST, and **every state transition has an explicit command endpoint**. Statuses are never changed through a generic PATCH.
  - `GET /sales-invoices?status=ISSUED&party=…&cursor=…`
  - `POST /sales-invoices` creates a draft. `PATCH /sales-invoices/{id}` works on drafts only.
  - `POST /sales-invoices/{id}/issue` · `POST /sales-invoices/{id}/cancel` · `POST /sales-invoices/{id}/credit-notes` (draft) · `POST /credit-notes/{id}/issue` (implemented, ADR 0002)
  - `POST /purchase-orders/{id}/submit` · `/approve` · `/reject`
  - `POST /documents` (upload) · `POST /documents/{id}/extract` · `POST /extractions/{id}/approve`
- **Idempotency:** every non-GET request requires an `Idempotency-Key` header. It protects against offline replays, AI retries and double clicks. Keys are stored with their response for 7 days.
- **Optimistic concurrency:** updates and transitions require `If-Match: <version>`, and a conflict returns `409`.
- **Errors:** RFC 9457 `application/problem+json` with stable machine codes such as `CREDIT_LIMIT_EXCEEDED` and `PERIOD_LOCKED`. The copilot explains failures from these codes.
- **Lists and exports:** cursor pagination, one consistent grammar for filters and sorting, and server-side CSV/XLSX export for reports.
- **Realtime:** in V1, clients poll lightweight "changes since" endpoints for notifications and dashboard tiles. A WebSocket arrives with chat (E.6). Either way, clients refetch over REST, so data has one canonical shape.
- **Integrations:** scoped service-account tokens for biometric attendance devices, the Tally bridge and e-invoice provider callbacks. Outbound webhooks come later.
- **Rate limits** apply per user and per IP. They are stricter on auth endpoints and on remote (tunnel) traffic.

---

## G. AI architecture

### G.1 Components
```
user ─▶ Agent runtime (in core) ─▶ LLM gateway ─▶ local runtime (Ollama / vLLM)
            │       ▲                        └──▶ cloud provider (only where policy allows)
            │       └── structured JSON results
            ▼
      Tool registry ─▶ Command / Query bus  (same validation, RBAC, audit as HTTP)
```
- **LLM gateway:** one interface over local and cloud models. It routes by task, data sensitivity and availability, and it enforces timeouts, token budgets and redaction. It logs every request and response locally. **As built (Slice 0):** the interfaces (`AiGateway`, `ProviderAdapter`) and the pure, property-tested routing policy live in `packages/ai`; every query declares the `dataClass` of its result and credential fields are marked RESTRICTED in the contracts. No provider adapter exists yet. Business modules may not import AI code, and AI code may not import the database — `apps/core/src/architecture.test.ts` enforces both (docs/ROADMAP.md §5).
- **Tool registry:** generated from the command and query registries, with JSON Schema from Zod plus descriptions and examples. For each request it is **filtered to the tools the current user may use**. It could later be exposed over MCP for external agents.
- **Agent runtime:** a small, explicit loop with a maximum number of steps, tool calls and wall time. We own this code and use no orchestration framework.
- **Action cards:** the UI renders consequential results from persisted drafts, never from model text.

### G.2 Risk tiers per tool
| Tier | Behavior | Examples |
|---|---|---|
| READ | Runs immediately, limited by the user's permissions and scopes | today's production, outstanding payments, stock-out forecast |
| DRAFT | Runs, but only creates drafts or proposals. Nothing takes effect until a human acts. | prepare a PO, prepare an invoice, propose an allocation, draft a message |
| CONFIRM | The model **cannot execute it**. The UI shows an action card, and a human click calls the real endpoint. | issue an invoice, issue a credit note, cancel an invoice (owner decision 2026-10-07, ADR 0002), approve a PO, record a payment, send a department message, create a maintenance ticket (one tap) |
| FORBIDDEN | Not exposed to AI at all | deleting or reversing posted ledger entries, changing roles or permissions, editing salaries or bank details, period close, settings |

The OWNER can tighten tiers. Loosening is limited to exceptions defined in code.

### G.3 Rules the runtime enforces
1. **The model acts as the user.** It never has more permissions than the user, and the audit trail records both the user and the AI session.
2. **No invented IDs.** Entities are resolved through search tools. If a search is ambiguous, the model asks a clarifying question and offers the options.
3. **No numbers from the model's own arithmetic.** Totals, taxes, balances and forecasts come from tools. Answers that quote figures cite the tool result, and the UI can show the underlying table.
4. **No free-form SQL in v1.** Analytics questions go through typed query tools over reporting views. A restricted, read-only text-to-SQL "analyst mode" may come later.
5. **Untrusted content stays data.** OCR text, messages and supplier documents are never treated as instructions. They never sit in a context that can trigger an action without a human.
6. **Everything is logged.** Every session, prompt, tool call with its arguments and result, model ID and latency is kept for audit and evaluation.

### G.4 Your examples, mapped
| Request | Tools, in order | Tier |
|---|---|---|
| "Create a PO for 500 kg of stainless steel from ABC Metals" | `search_parties(supplier)` → `search_items("stainless steel")` → ask which grade if ambiguous → `get_last_purchase_price` → `prepare_purchase_order` | DRAFT, then a human submits. Approval thresholds apply. |
| "Show me today's production" | `get_production_summary(date)` | READ |
| "Why did production fall yesterday?" | `get_production_variance(date, baseline=7d)` → `get_downtime_events` → `get_attendance_summary` → `get_quality_rejects` → `get_material_shortages` | READ. The narrative cites the figures. |
| "Create an invoice for Sharma Industries" | `search_parties(customer)` → `list_uninvoiced_dispatches` or ask for the items → `prepare_sales_invoice` | DRAFT, then CONFIRM to issue |
| "Which materials will run out this week?" | `get_stockout_forecast(horizon=7d)`, computed deterministically as on-hand + open POs − planned consumption | READ |
| "Show outstanding payments" | `get_receivables_ageing` / `get_payables_ageing` | READ |
| "Assign today's workforce" | `propose_allocation(date)`, which runs the solver | DRAFT, then the supervisor confirms |
| "Create a maintenance ticket for Machine 3" | `search_machines("Machine 3")` → `prepare_maintenance_ticket` | CONFIRM (one tap) |
| "Send a message to the production department" | `draft_message(department)` | CONFIRM |

### G.5 What should *not* be an LLM
- **Workforce allocation** is a constraint-solving problem: skills, shift, attendance, machine requirements, maximum hours and fairness. It uses a solver such as OR-Tools CP-SAT in the Python sidecar. The LLM gathers preferences and explains the result.
- **Stock-out forecasts, reorder points, receivables ageing and production variance** are SQL and arithmetic.
- **Invoice totals and tax** come from the GST engine.
- **"AI workflow execution"** means scheduled jobs and rules that create *drafts for approval*, for example "every Monday, draft POs for items below reorder level". We won't build a general BPMN engine.

### G.6 Document AI pipeline (invoice and bill ingestion)
```
upload (web, phone camera; later email/WhatsApp)
 → store original immutably (SHA-256; exact-duplicate detection)
 → classify: tax invoice / bill of supply / delivery challan / e-way bill / handwritten bill / other
 → extract
     · digital PDF with text layer → parse text directly (no OCR needed)
     · e-invoice → decode the IRP-signed QR (payload fields per current e-invoice spec [VERIFY R-06]) — a deterministic anchor
     · photo/scan → preprocess (deskew, perspective, denoise) → OCR + layout
                  → LLM/VLM structured extraction into a strict schema with per-field confidence and source boxes
 → validate deterministically
     · GSTIN format + check digit [VERIFY R-09]; state codes consistent with CGST+SGST vs IGST [VERIFY R-05]
     · Σ lines = subtotal; qty × rate = amount; tax rate exists in the rate master for that date
     · duplicate check: (supplier GSTIN, invoice no, fiscal year)
     · match supplier (GSTIN exact → name fuzzy), items (learned supplier-item aliases), PO/GRN (three-way match)
 → ExtractionProposal (fields + confidence + validation findings)
 → human review: image left, fields right, problems highlighted, keyboard-fast correction
 → approve → creates a DRAFT purchase invoice via the normal command (same validation as manual entry)
 → corrections feed supplier/item alias memory and grow the evaluation set
```
- **v1 policy:** a human reviews **every** extraction. Auto-approval is a later, opt-in policy per supplier. It unlocks only after measured accuracy on our own evaluation set passes an agreed threshold, and it stays capped by amount limits.
- **Handwritten bills:** accuracy from local models will be clearly lower, so these are always reviewed. A cloud vision fallback is used only if approved (S6).
- **Isolation:** the extraction step has **no tool access** and can only return JSON. This contains prompt injection hidden in documents.

### G.7 Evaluation
- **Gold set:** built from the factory's real documents, with field-level ground truth. The target is 200+ purchase bills (including handwritten ones) and 50+ sales invoices.
- **Copilot eval set:** 150+ utterances mapped to the expected tool calls and arguments, plus adversarial prompts for permission escalation and injection. It covers English and whichever regional language the floor uses.
- **Release gate:** both sets run in CI on every prompt or model change. A model upgrade must show no regression.

---

## H. Local inference architecture

> Round 2 §9 turns this section into a **hardware-adaptive** design: capability detection, per-capability qualification by benchmark, and a fixed order of local, then cloud (only if policy allows), then no AI. The ERP is complete without AI.

### H.1 Hardware tiers
| Tier | Hardware | Runs locally | Does not run locally |
|---|---|---|---|
| 0 — Core only | Mini PC or existing PC with 4+ cores, 16 GB RAM and an NVMe SSD | Everything except interactive AI. CPU OCR runs as slow background jobs. | Chat copilot and VLM extraction. These go to the cloud if approved and are disabled otherwise. |
| 1 — CPU / Apple-silicon AI | 32 GB+ RAM workstation, or an Apple-silicon Mac mini | Small instruction models for the copilot (slow-ish), CPU OCR and the solver | Larger models and fast VLM extraction |
| 2 — GPU AI | NVIDIA GPU with 16–24 GB VRAM | Mid-size models for the copilot and VLM extraction at interactive speed | Frontier-quality reasoning |

**What to expect:** on CPU-only machines, small models answer slowly and use tools less reliably. So local AI is **optional and swappable**. It gets benchmarked on the real machine (Phase 0A and later, Round 2 §9.4), and cloud fallback is a policy decision (S6), not an architectural one.

### H.2 Runtime and isolation
- `llm` and `docai` run as separate containers with CPU and memory limits, so inference can never starve Postgres or the API.
- Batch AI work (OCR, extraction) goes through the transactional outbox with concurrency 1 on small hardware (ADR 0001; there is no pg-boss). Interactive chat takes priority over batch OCR.
- Models are pinned by digest. Upgrading a model is a release, and it must pass the eval suite.
- **Specific models are chosen at implementation time** by benchmarking open-weight models with tool calling and Indic-language support against our eval sets. The field changes too fast to pick now.

### H.3 Routing policy in the gateway
The gateway picks a provider from task × data class × availability.
- **Data classes:**
  - PUBLIC
  - INTERNAL
  - CONFIDENTIAL: financials, salaries and customer data
  - RESTRICTED: credentials and bank details, which are never sent to any model
- **Default:** CONFIDENTIAL data stays local. Cloud is used only for the task and data combinations the OWNER enables, with identifiers redacted where possible.
- **If no permitted provider is available**, the AI feature degrades with a clear message. Core workflows are unaffected.

---

## I. Authentication and RBAC

### I.1 Authentication
- **The factory node is the identity provider for its users**, so login works without internet.
- **Credentials and sessions:**
  - Passwords are hashed with argon2id.
  - Sessions live server-side in Postgres. The cookie is `__Host-`-prefixed, Secure, HttpOnly and SameSite, revocation is immediate and CSRF protection is on.
  - Users log in with a username or mobile number.
  - TOTP two-factor is **mandatory** for OWNER, ADMIN and ACCOUNTANT, and for **every** remote (tunnel) session.
- **Shop-floor kiosk mode:** a registered tablet plus a per-worker PIN or badge QR, limited to floor permissions (attendance, production entry and tickets).
- **Network-aware policy:** roles can be marked LAN-only (for example WORKER and SUPERVISOR). Remote access is opt-in per role.
- **Device registry:** admins can see and revoke sessions per device, for lost phones.
- **No SMS OTP in v1.** It needs internet, and commercial SMS in India comes with sender and template registration rules [VERIFY R-22]. We can revisit it later with WhatsApp or SMS providers.
- **Kiosk mode** is built in V1 only if discovery shows workers will use shared floor devices (Round 2 §10.4).
- **SaaS later:** the control plane may offer SSO/OIDC. The node still keeps local credentials so offline login keeps working.

### I.2 Authorization model
- **Permissions** are defined in code, such as `sales.invoice.issue` and `hr.salary.view`. There is one per command and query, plus field-level read permissions.
- **Roles** are bundles of permissions that each tenant can edit. Seeded defaults:
  - OWNER, ADMIN, ACCOUNTANT
  - PRODUCTION_MANAGER, PURCHASE_MANAGER, HR
  - SUPERVISOR, WORKER
  - EXTERNAL_CA: read-only finance and exports
  - GATE/SECURITY: inward and outward register
- **Scopes:** a role is granted *within* a company, location or department, for example SUPERVISOR of Line 2 at Plant A.
- **Policies** are code configured by data:
  - approval thresholds, for example a PO above ₹X needs the OWNER
  - maker-checker (creator ≠ approver) for payments and changes to supplier bank details
  - period locks
  - field masking for salaries, cost prices, margins and bank details
- **One `authorize(ctx, permission, resource)` path** serves the command and query bus, for HTTP and AI alike.
- **CI generates a permission-matrix test** covering every command against every seeded role, so any permission change appears as a reviewable diff.

---

## J. Offline and synchronization

> Round 2 §8 is the authoritative offline boundary and outage matrix: internet, server, phone, cloud, power and LAN failures. The table below is the summary.

| Failure | What happens | Design |
|---|---|---|
| Factory internet down | LAN users are unaffected. Remote users can't connect. Anything that needs the cloud waits in a queue: e-invoice IRN, e-way bill, GSTIN verification, cloud AI, outbound messages and off-site backups. | Outbox with retries. The UI shows "pending external" states. Local WAL retention is sized for multi-day outages, with disk alerts. |
| Node down (power or hardware) | Everyone is affected. | UPS, BIOS "power on after AC loss" and auto-start. A heartbeat alerts the owner within minutes. Restoring to spare hardware or a cloud node from point-in-time backup is documented. Proposed targets: RPO ≤ 5 min and RTO ≤ 4 h (S16). A warm standby is optional later. |
| Phone or tablet on patchy Wi-Fi | Selected floor workflows keep working. | PWA offline outbox (J.2) |

### J.1 Why one writer instead of multi-master sync
These invariants can't be merged after the fact:
- invoice numbers must be gapless and consecutive
- stock can't be issued twice
- credit limits and approvals must be checked against current state

One authoritative node per tenant removes that whole class of correctness bugs. Availability comes from engineering power, backups and a standby, not from distributed writes.

### J.2 Client offline outbox (PWA)
- **Scope:** only workflows designed for it: attendance, production entries, downtime logs, quality checks, maintenance tickets, photo capture and message drafts.
- **Queueing:** clients generate UUIDv7 IDs and idempotency keys. Commands queue in IndexedDB and replay in order once the node is reachable.
- **Rejections:** the server validates replays as usual. A rejected command returns to the user as "needs attention" with the reason. Nothing is merged silently.
- **Reference data** (items, machines, employees and shifts) is cached read-only with version stamps.
- **Financial documents** (invoices, payments and POs) are online-only against the node. On the LAN the node is effectively always reachable.

### J.3 Cloud and node
- **Ingress:** an outbound tunnel. No inbound ports are opened, and it works behind CGNAT.
- **Backups:** continuous WAL archiving, periodic full backups and file snapshots. Everything is encrypted before it leaves the node.
- **Later, optionally:** a cloud read replica so reports and receivables stay readable while the factory is offline.
- **LAN HTTPS:** the node gets a real certificate (DNS-01) for **the same hostname used remotely**. Inside the factory, that hostname resolves to the node's LAN IP (split-horizon DNS, Round 2 §3). This is needed because PWAs, service workers and the camera API require a secure context. Discovery checks the router and DNS feasibility on site.

---

## K. File and document architecture
- **Storage:** a `BlobStore` interface with a local filesystem implementation on the node (`/data/blobs/ab/cd/<sha256>`) and an S3-compatible one for cloud nodes. Content addressing gives deduplication and integrity checks for free.
- **Metadata** lives in `docs.documents`: filename, sniffed MIME type, size, SHA-256, uploader, source, classification and retention class. `docs.document_links` links documents to any entity, many to many.
- **Versioning:** a new upload creates a new version, and the old version is kept.
- **Generated documents** such as invoice PDFs are stored once, and their hash is recorded on the issuing record. Reprints use the stored file and are never silently regenerated.
- **Upload hygiene:**
  - size limits
  - MIME type sniffed from content, not trusted from the extension
  - images re-encoded with EXIF stripped
  - parsers run only inside the sandboxed sidecar container
  - thumbnails generated by a worker
- **Access:** files are served only through the API, after an authorization check on the linked entity. Share links are signed and expire.
- **Retention:** GST, income-tax and company law each require keeping accounts and records for several years. Periods are configurable data per retention class [VERIFY R-15]. Retention classes block deletion of financial documents within the configured window.
- **Backup:** restic backs files up alongside the database. Restore drills restore both and verify hashes.

---

## L. Invoice architecture

### L.1 Components
1. **GST engine** (`packages/gst`): pure, deterministic and versioned.
   - **Input:** lines, header discounts and charges, supplier state, place of supply, document type, rounding policy and a snapshot of tax rates.
   - **Output:** per-line taxable value and tax components, an HSN and rate summary, totals, round-off, and the amount in words in the Indian numbering system.
   - The web client uses the same engine for live preview. The server always recomputes, and client values are never trusted.
2. **Invoice service** (`sales` module): drafts, validation, issue, cancel, credit and debit notes, snapshots, numbering and posting.
3. **Numbering:**
   - There is one series per company, document type and fiscal year (April–March).
   - The format is configurable, for example `INV/26-27/00042`. It is validated at configuration time against the GST invoice-numbering rule set, which covers maximum length, allowed characters and uniqueness per fiscal year [VERIFY R-02]. The constraints are rule data, not constants.
   - **The number is assigned when the invoice is issued**, inside the issuing transaction and under a row lock. That makes numbering gapless and consecutive, and drafts never consume a number.
4. **Rendering:** a typed React template is rendered to HTML, then Chromium prints the PDF.
   - Each company configures its logo, signature image, bank details, terms, declarations, colors and which fields to show.
   - Templates are versioned. The issued invoice records the template version and the PDF hash.
   - Copy labels are printed as the rule set requires, for example Original for Recipient, Duplicate for Transporter and Triplicate for Supplier [VERIFY R-02].
5. **Compliance adapters** (where applicable, S8): e-invoice (IRN and signed QR through a GSP/ASP provider) and e-way bill. If the internet is down at issue time:
   - the invoice is issued locally with `einvoice_status = PENDING`
   - it can't be printed as final until the IRN arrives
   - IRP cancellation windows are respected
6. **Distribution:** download, print, email, and a WhatsApp share link that is signed and expires.

### L.2 Calculation rules (to be signed off by your CA)
- **Per line:** `gross = qty × rate`, then discounts give `taxable`. Each tax component is computed per line and rounded to the paisa with ROUND_HALF_UP.
  - Intra-state: CGST = SGST = rate ÷ 2.
  - Inter-state, SEZ and export: IGST.
- **Place of supply** defaults to the ship-to state. Overriding it is a permissioned, audited action. The supplier state comes from the company GSTIN.
- **Freight and packing charges** on the invoice are taxed as part of the supply, at the rate the CA-approved policy sets.
- **Grand total** is rounded to the rupee with an explicit `round_off` line. The policy is configurable.
- **Line-wise versus rate-wise tax summation** gives paisa-level differences. We pick one, document it and lock it per engine version.
- **Tax rates are effective-dated master data per HSN/SAC** [VERIFY R-01]. GST rates do change, including large restructurings, so each document uses the rate in force on its date and never a "current" rate. Which current rates to load is verified against official notifications, not taken from this document. HSN digit requirements depend on turnover band [VERIFY R-08].
- **Issued invoices are frozen.** They persist every computed value plus `calc_engine_version`, and displaying them never recomputes anything.

### L.3 Edge cases designed for explicitly
- Bill of supply (exempt goods or composition scheme)
- Reverse charge
- SEZ and export under LUT
- B2C versus B2B
- Billing by weight versus count (`qty`, `uom`, `alt_qty`, `net_weight`)
- Partial dispatches
- Returns via credit note (implemented — ADR 0002)
- Cancellation versus credit note (implemented — ADR 0002: cancel only what nothing has settled; otherwise credit)
- Multiple GSTINs
- Invoices against advances (later)
- TDS/TCS (later, driven by the CA)

---

## M. Accounting architecture
- **Double-entry ledger from day one**, because adding it later would mean a rewrite.
  - `finance.journal_entries` holds the date, company, voucher type, source document and narration.
  - `finance.journal_lines` holds the account, party, debit and credit.
  - Every entry must balance, enforced by a deferred constraint. The ledger is append-only, and corrections are reversals.
- **Posting rules** map business documents to journal lines. For example, a sales invoice posts Dr customer, Cr sales, Cr output CGST/SGST/IGST, ± round-off. The rules are versioned data per company, and posting happens in the same transaction as the business document.
- **Chart of accounts:** a seeded template for Indian MSMEs that can be edited. Every account maps to a Tally ledger name for export.
- **Sub-ledgers:** receivables and payables with **bill-wise allocation**, meaning payments are matched to specific invoices, which is how Indian accountants work. Ageing and credit limits are included.
- **Periods:** the fiscal year runs April–March. Periods can be locked, and back-dated postings need a permission and are flagged.
- **GST:** input and output tax ledgers and a GSTR-1 data export. GSTR-2B reconciliation comes later. It is high-value because it catches suppliers who haven't filed and protects input tax credit.
- **Expenses:** expense vouchers with receipts (OCR-assisted) and petty cash.
- **Bank:** receipts and payments. Bank statement import and reconciliation come later.
- **Coexisting with Tally (recommended for v1):** Factory ERP is where sales, purchases, receipts and payments are entered. Vouchers and masters are exported to Tally as XML, so the CA keeps filing from the books they know. Replacing Tally as the books of record is a later decision, made after a clean parallel close (S7).
- **Compliance:** company law requires accounting software used by companies to keep an audit trail (edit log) that can't be disabled. Applicability depends on the entity type, and the exact obligations must be confirmed [VERIFY R-16]. The audit design in D.3 is meant to meet it by construction.
- **Validation gate:** no calculation, posting rule or report in this section is production-ready until it has passed the CA validation pipeline in Round 2 §7.
- **Decided (R2-D4):** V1 builds immutable vouchers, customer and supplier balances, and Tally export. Tally stays the official books, and the full general ledger is deferred. Posting rules will derive it from the vouchers later.

---

## N. Testing strategy

| Layer | What we test | Tools | Gate |
|---|---|---|---|
| Pure domain | GST engine, rounding, place of supply, numbering formats, state machines, stock valuation and allocation constraints | Vitest with table-driven golden cases **signed off by the CA** through the pipeline in Round 2 §7. fast-check properties, for example Σ components + round-off = grand total, CGST = SGST, and every journal balances. | 100% branch coverage on `packages/gst` and finance posting |
| Integration | Commands end to end against real Postgres: constraints, triggers, concurrency (parallel issues get consecutive numbers), audit rows, idempotent replays and permission denials | Vitest with Testcontainers | Every command has happy-path, authorization and concurrency/idempotency tests. |
| Authorization | A generated matrix of every command against every seeded role | Vitest | The diff is reviewed on every change. |
| API contract | OpenAPI conformance and problem codes | Generated tests | CI |
| End to end | Critical journeys: login → create and issue an invoice → PDF; PO → GRN → stock; bill upload → review → draft purchase invoice; offline attendance replay | Playwright, desktop and mobile viewports | Before each release |
| AI | Tool-selection eval, extraction eval, and red-teaming for injection and escalation | Our own harness | No regression against the current release |
| Migrations and backups | Migrate from empty and from the previous release. Restore last night's backup into a scratch node automatically and verify checksums. | CI plus a scheduled job on the node | Weekly on the node. Blocks releases in CI. |
| Performance | Realistic load on Tier-0 hardware, for example 50 concurrent users, 10k items and 100k invoices | k6 | p95 targets agreed in Phase 0B |
| Security | Dependency audit, SAST, secret scanning and container scanning | GitHub-native tools, Trivy | CI |
| Reality | **A parallel run** in production: each phase runs alongside the existing system until the numbers reconcile. | Reconciliation reports | Phase exit |

---

## O. Deployment architecture

### O.1 Factory node
- **Recommended hardware:** a dedicated small server, not a shared office PC, with:
  - Ubuntu Server LTS and full-disk encryption
  - wired Ethernet
  - an online UPS that sends a shutdown signal
  - BIOS set to power on after AC loss
  - a second disk or NAS for a local backup copy
  - physical security
- **Compose services:** `caddy`, `core-api`, `core-worker`, `postgres`, `backup`, `cloudflared`, and optionally `docai` and `llm`.
- **`factoryerp` CLI:** `install`, `status`, `upgrade`, `backup-now`, `restore` and `support-bundle`.
- **If the existing Windows PC must be used (S4):** WSL2 with Docker works but is fragile, because of sleep, forced updates and people using the machine. Treat it as temporary.

### O.2 Releases and updates
- CI builds versioned, multi-architecture images pinned by digest, plus a release manifest. Image signing is added before SaaS.
- **Factory V1:** we run `factoryerp upgrade` over audited remote admin access (Round 2 §3.4) in an after-hours window agreed with the OWNER. The node pulls images, so no inbound access is needed.
- **SaaS Later:** the control plane orchestrates staged rollouts across the fleet.
- **Upgrade steps:** maintenance mode → backup snapshot → pull images → migrate → health checks → reopen.
  - If a health check fails, the containers roll back.
  - If a migration fails, it has already rolled back thanks to transactional DDL.
- **Release channels:** `dev` for developer machines, `staging` for a cloud VM running a node with anonymized data, and `stable` for the factory.

### O.3 Observability
- **Logs:** structured JSON (pino) carrying the request ID, user ID and command, rotated locally.
- **Health and metrics:** health endpoints plus node metrics (disk, CPU temperature, memory, database size, WAL archive lag, backup age and job-queue depth).
- **Heartbeat to an external uptime monitor** in V1 (no control plane). The monitor raises an alert when the heartbeat stops. Node-local checks push their own alerts to the owner, the admin and us by push, email or WhatsApp when:
  - the node goes offline
  - disk use passes 80%
  - a backup fails or goes stale
  - archive lag builds up
  - logins keep failing

### O.4 SaaS environments (later)
The control plane runs on a managed cloud in an India region. Cloud-hosted nodes run as separate containers, each with its own database, using the same images as on-prem.

---

## P. Security model

| Threat | Controls |
|---|---|
| Ransomware on the factory network | Server isolated from office PCs (separate VLAN, or at least no SMB shares), no inbound ports, full-disk encryption, and **immutable off-site backups (object lock)** with restore drills |
| Stolen or phished remote credentials | TOTP for privileged roles and every remote session, rate limiting, lockout, login alerts, session and device revocation, and LAN-only roles. **As built:** per-IP rate limit, per-username backoff (also for unknown usernames), every attempt recorded and refusals of known users audited, sessions revoked on deactivation and password reset. TOTP is still to come. |
| A compromised or buggy application process | **As built:** the server connects as a least-privilege runtime role: no DDL, no `TRUNCATE`, no trigger changes, no `session_replication_role`, and no update or delete on append-only tables. Migrations and backups use a separate owner connection the production server never holds. A privilege test guards against drift. |
| Insider fraud (edited invoices, fake suppliers, changed bank details) | Posted documents are immutable. Payments and supplier bank-detail changes need maker-checker. The audit log is hash-chained, and high-risk events alert the owner. |
| Over-broad access to salaries, costs and customers | Fine-grained permissions, scopes, field masking and permission-matrix tests |
| AI misuse and prompt injection | The AI acts as the user, within risk tiers and behind human confirmation. Untrusted content is isolated from tool calling, there is no SQL access, and the AI audit trail is complete. |
| Data leaving the premises | Data classes and gateway policy, opt-in cloud AI, backups encrypted client-side, and storage in an India region |
| Physical theft of the server | Disk encryption. **Decision needed:** a TPM-bound key allows unattended reboot after power cuts, while manual unlock is safer but needs a person on site. |
| Malicious uploads | MIME sniffing, size limits, re-encoding and sandboxed parsers |
| Supply chain | Lockfiles, minimal dependencies, reviewed dependency-update PRs, image scanning and signed releases |
| TLS termination at the tunnel provider | In v1, Cloudflare decrypts traffic at its edge. If that is unacceptable, a self-hosted relay with TLS passthrough is the alternative (S5). |

- **Secrets** are encrypted at rest on the node (sops/age or systemd credentials). They never go into images or git.
- **Backup encryption keys** are escrowed offline with the OWNER. If those keys are lost, the backups are lost too.
- **Personal data:** employee and customer personal data falls under India's DPDP Act, 2023. Data classes, field masking, retention and access logging are designed in now rather than retrofitted.

---

## Q. Development phases

Each phase ships to the real factory and is in daily use before the next phase starts. **The dashboard comes out of the system, not first:** owner dashboard tiles arrive through the insights contract (E.5) as each module starts producing real data.

**Factory V1 sequence:**
1. **Phase 0A, Discovery.** No business code is written.
2. **Phase 0B, Platform foundations.**
3. **Business modules, one at a time.** Their order and content are **decided by discovery**, not by the provisional list below.
4. **For every module with financial or tax effect:** specification from real documents → build → **CA validation gate** (Round 2 §7) → parallel run → production.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0A — Discovery** | Run the questionnaire and collect data with the files under `docs/discovery/`. Map processes on site. Keep two weeks of power and internet diaries. Survey the network and server location. Benchmark the hardware. Introduce the CA. Verify the regulatory register for the rules V1 touches. | A "Discovery Findings & V1 Scope" document is approved, and every regulatory item V1 needs has at least SOURCE_FOUND status. |
| **0B — Platform foundations** | git, the monorepo, CI, the command bus, auth, RBAC, audit, outbox, jobs, migrations, deployment, backups with a restore drill, remote access with split-horizon DNS, monitoring and alerting, the upgrade procedure, the web shell, and the insights/exception framework (with no KPIs yet) | The node runs at the factory. Users log in on the LAN and remotely. A restore drill succeeds. Simulated failures (internet cut, service killed, disk filled) raise the expected alerts. |

**Provisional business-module order (before discovery).** Discovery will re-plan this:

| Phase | Scope | Exit criteria |
|---|---|---|
| **1 — Masters, sales invoicing and receivables** | Companies, parties, items, HSN and tax rates, the GST engine, invoice issue, cancel and credit notes, PDF templates, numbering, receipts with bill-wise allocation, receivables ageing and Tally export. E-invoice and e-way bill if applicable. Owner dashboard v1 (sales and receivables). | At least 4 weeks of parallel running with zero unexplained differences from the current system, and CA sign-off |
| **2 — Purchasing, inventory and payables** | Suppliers, POs with approvals, GRN, purchase invoices, payables, the stock ledger, transfers and adjustments, stock reports, reorder alerts, and document upload and attachment | A physical stock count reconciles with the system within an agreed tolerance |
| **3 — Document AI** | Bill-ingestion pipeline with a review queue, supplier and item alias learning, and an evaluation set with a dashboard | Field accuracy measured on the gold set, and review time per bill lower than manual entry |
| **4 — Shop floor** | Machines, maintenance tickets, BOMs, work orders, material issue, production entries, downtime, employees, shifts, attendance (including biometric device import), and the mobile PWA with offline outbox | Supervisors record a full shift on their phones, and management uses the daily production report |
| **5 — Copilot v1** | READ tools across modules plus DRAFT and CONFIRM for POs, invoices, tickets and messages. Production-variance analysis and owner dashboard v2. | The copilot eval suite passes, and real users choose it for routine questions |
| **6 — Quality, preventive maintenance, allocation and tasks** | Inspections, NCRs, preventive-maintenance schedules, the allocation solver, tasks, comments on entities, and WhatsApp and email notifications | Agreed per feature |
| **7 — Full accounting (if approved)** | Trial balance, P&L and balance sheet, bank reconciliation, GSTR-2B reconciliation and expenses | A month closes in parallel with Tally and matches |
**SaaS Platform (later, separate track).** Control plane, tenant onboarding, cloud-hosted nodes, billing and fleet upgrades. **Trigger:** a second factory commits, or Factory #1 has run stably for an agreed period. The exit criterion is that a second factory is onboarded without code changes. Round 2 §4 has the boundary and the seams.

**Explicitly deferred.** We re-evaluate each of these with evidence.
- **Slack-like chat:** channels, DMs, group chat, search and AI over messages. V1 ships notifications, announcements, comments, mentions and tasks (E.6).
- **Payroll.** PF, ESI and professional tax make it complex. Export attendance to the existing payroll or the CA first.
- Native mobile apps.
- Text-to-SQL.
- The cloud read replica.
- Multi-currency.

---

## R. Risks and trade-offs

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| **Scope.** The 40-item vision is several ERP products, and the project may never reach daily use. | High / fatal | Phase gates tied to real use, an explicit deferred list, and saying no often |
| **Build vs. buy.** ERPNext and Odoo already cover much of items 1–23, including Indian GST. | Not a probability: a strategic choice | Decide consciously (S1). Our differentiation is AI-native workflows, floor UX, local-first operation and document AI. |
| GST or accounting errors create legal and financial liability | Medium / high | A pure engine, CA-signed golden tests, parallel runs, immutability and audit |
| The node is a single point of failure on a hot, dusty site with power cuts | Medium / high | Dedicated hardware, a UPS, point-in-time backups, alerting, a documented restore and an optional standby |
| Local AI is too slow or weak on affordable hardware | High / medium | AI is optional. Benchmark early. Policy-based cloud fallback. Deterministic tools carry correctness. |
| OCR accuracy on handwritten bills | High / medium | Human review every time, alias learning, measurement, and a cloud fallback if approved |
| Offline operation vs. compliance (e-invoicing needs internet) | Medium / medium | PENDING states, queues and a clear UI |
| Regulatory churn in rates, thresholds and formats | Certain / medium | Effective-dated rules as data, and a versioned engine |
| Adoption on the floor (literacy, language, phones) | High / high | Floor-first UX, regional languages and involving supervisors from discovery (Phase 0A) onward |
| A small team and bus factor | High / high | A boring stack, docs and ADRs, tests as the specification, and no exotic infrastructure |
| Dependency on the tunnel provider and its TLS termination | Low / medium | An abstracted ingress layer and a self-hosted relay option |
| Operational cost of one database per tenant at SaaS scale | Low now / medium later | A migration orchestrator. Revisit at a few hundred tenants. (Round 2 §4.3) |

Round 2 §10 has the full hostile review: failure modes, over-engineering, under-engineering, product assumptions and build-versus-buy.

---

## S. Decisions requiring your approval

| # | Decision | Recommendation |
|---|---|---|
| S1 | Build our own core, or build on ERPNext or Odoo | ✅ **Decided (Round 2): build our own core.** Study ERPNext and Odoo for domain concepts and accounting expectations only, without copying code. Scope Factory #1 aggressively. |
| S2 | Core stack: TypeScript/Node (with a Python sidecar) or Python/FastAPI | **TypeScript core.** One language across UI, API, the calculation engine and tool schemas. |
| S3 | Source of truth: on the factory node (local-primary) or in the cloud with an offline cache | ✅ **Confirmed (Round 2): the factory server is the authoritative single writer.** |
| S4 | Server: a dedicated Linux box or the existing Windows PC | **A dedicated box**: Tier 0 now, Tier 1/2 if local AI is a must-have |
| S5 | Remote access: Cloudflare Tunnel or a self-hosted WireGuard relay | **Cloudflare Tunnel for v1**, if you accept that Cloudflare terminates TLS |
| S6 | Cloud AI: allowed at all? For which tasks and data? Which provider? | **Local by default.** Opt-in cloud for (a) handwritten-bill extraction and (b) complex copilot questions, with redaction. RESTRICTED data never goes to a model. |
| S7 | Accounting: replace Tally or coexist with it | **Coexist**, exporting to Tally, until a clean parallel close |
| S8 | E-invoice and e-way bill in Phase 1 | Whether they apply depends on turnover thresholds and transaction types that must be verified [VERIFY R-06, R-07]. Discovery collects the turnover band and current practice. If they apply, we choose a GSP/ASP provider. |
| S9 | Inventory: valuation method, batch/lot tracking, negative stock | **Weighted average.** Batches only for items that need them. **No negative stock**, with an audited admin override. |
| S10 | Tenancy: a database per tenant or a shared schema | **A database per tenant**, kept for now. Round 2 §4.3 evaluates it at scale. Shared tenancy is not implemented early. |
| S11 | Chat: build our own, or use WhatsApp integration plus comments on entities | ✅ **Decided (Round 2): split.** V1 has notifications, announcements, comments, mentions and tasks. Channels, DMs, group chat, attachments, search and AI come later (E.6). |
| S12 | Initial roles, approval thresholds and LAN-only roles | Draft them together from the discovery answers (Phase 0A) |
| S13 | Is payroll in scope? | **Not before Phase 7.** Export attendance until then. |
| S14 | UI languages for v1 | **English, plus one regional language on floor screens** |
| S15 | Hosting: code (GitHub?), the cloud provider, and the India region for backups (and the control plane, SaaS Later) | GitHub, plus S3-compatible storage with object lock in an India region |
| S16 | Recovery targets | **RPO ≤ 5 min, RTO ≤ 4 h** |
| S17 | Server disk unlock: TPM-bound (survives power cuts unattended) or manual (more secure) | **TPM-bound**, with a strict physical-security checklist |

### S.1 Facts needed about the factory
1. **What it makes, and how.** Discrete parts, fabrication, assembly or process manufacturing? Make-to-order or make-to-stock? Is job work involved, meaning material sent to or received from job workers?
2. **Size.** Number of employees (permanent and contract), expected system users, invoices and purchase bills per month, active SKUs and machines.
3. **Legal.** Number of GSTINs, legal entities and plants. GST scheme (regular or composition). Turnover band. Any export or SEZ customers.
4. **Current tools.** Tally (which version), Excel, WhatsApp groups, and the biometric attendance device's make and model.
5. **Infrastructure.** Internet provider(s) and typical outages, power backup, specs of the existing PC, and Wi-Fi coverage on the floor.
6. **People.** Who will champion this internally, who will look after the server, and who the CA is.
7. **Documents.** Can we collect a sample set (sales invoices, purchase bills including handwritten ones, and challans) to use for design and for the AI evaluation set?

---

# Architecture Review — Round 2

**Date:** 2026-10-05
**Input:** the owner's review of v0.1
**Status:** approved in concept by the owner (2026-10-05). R2-D1 to D5 and D7 are decided, and D6 is pending discovery. **Current phase: 0A, Factory Discovery.** There are no ADRs, git repository, scaffolding, migrations or application code.

Where this section conflicts with sections A–S, **this section wins**.

---

## 1. Decisions confirmed

| ID | Decision | Notes |
|---|---|---|
| D-01 | **Build our own core.** We don't wrap Odoo or ERPNext. | Their domain concepts and accounting behavior are reference material only. We copy no code (they carry copyleft licenses). Scope Factory #1 aggressively. |
| D-02 | **Modular monolith** with the layering **DATABASE → BUSINESS LOGIC → APIs → AI TOOLS** | All mutations go through the command bus (E.4). HTTP and AI are both adapters over it. |
| D-03 | **The factory server is the authoritative single writer.** | No multi-master replication of business data |
| D-04 | **AI acts only through typed tools, as the user** | Risk tiers (G.2). Consequential actions need a human click. The AI never does financial arithmetic. |
| D-05 | **Deterministic financial engine with a CA validation gate** | Engine → test cases → CA validation → golden suite → production (§7) |
| D-06 | **Regulatory rules are effective-dated, versioned data with cited sources** | Nothing regulatory is hard-coded or stated as permanent (§6). |
| D-07 | **The ERP is fully functional with no AI** | Provider order: local → cloud (only if policy allows) → none (§9) |
| D-08 | **PWA offline is limited to a whitelist. No offline accounting in V1.** | §8 |
| D-09 | **Communication is split into V1 and Later** | E.6 |
| D-10 | **The dashboard comes out of the system** through a common insights contract, with no mock KPIs | E.5 |
| D-11 | **Factory V1 and SaaS Later are separate tracks.** V1 has no control plane. | §4 |
| D-12 | **Discovery comes before business implementation.** No workflow is invented. | §11, §12 |
| D-13 | **One app for both the LAN and remote paths.** LAN operation never depends on the internet. | §3. R2-D1 and R2-D2 are approved, with R2-D2 subject to the site check. |
| D-14 | **Version-agnostic architecture.** Versions are chosen at ADR time after verification. | §5 |
| D-15 | **A database per tenant is kept.** Shared tenancy is not implemented early. | §4.3 |

## 2. Decisions deferred

| Item | Deferred until | Input needed |
|---|---|---|
| SaaS control plane, subscriptions, fleet management, tenant onboarding, SSO | The SaaS track starts | A second factory commits (§4) |
| Shared or pooled tenancy | Scale triggers in §4.3 | Tenant count and economics |
| Channels, DMs, group chat, attachments, search and AI over messages | After V1 is stable | Build or integrate (§10.5) |
| Replacing Tally as the books of record (S7) | A clean parallel month-end close | Discovery of the accounting workflow, plus the CA |
| E-invoice and e-way bill scope (S8) | Discovery plus verification of R-06 and R-07 | Turnover band and current practice |
| Valuation method, batches, negative stock (S9) | Discovery plus the CA | Current practice and what the CA wants |
| Cloud AI policy and provider (S6) | After the hardware benchmark | The OWNER's policy. **The default is no cloud AI.** |
| Server hardware and AI tier (S4) | Site survey and benchmark | Discovery §M |
| OCR engine, LLM runtime and specific models | Document AI phase and hardware benchmark | Factory gold set and benchmark results |
| Workforce allocation solver | Attendance and production data exist | Discovery shows how allocation actually works (§10.4) |
| Payroll (S13) | Not in V1 | — |
| UI languages (S14), roles and thresholds (S12) | Discovery | Interviews |
| RPO/RTO (S16), disk unlock (S17) | After discovery | The OWNER's risk appetite |
| Kiosk mode, text-to-SQL, cloud read replica, warm standby, native apps, multi-currency, WebSocket, image signing | Evidence of need | — |

### 2.1 Round 2 decisions (owner, 2026-10-05)
| ID | Decision | Outcome |
|---|---|---|
| R2-D1 | Should the factory server serve the application itself on both paths? | ✅ **Approved.** No Vercel or separately hosted frontend for the application. |
| R2-D2 | One application address for LAN and remote, with local DNS on the factory LAN? | ✅ **Approved, subject to the site check** (§3.3, Discovery Pack F12). |
| R2-D3 | Core language | ✅ **Approved.** TypeScript is primary. Python is a specialist sidecar for OCR, vision and optimization. |
| R2-D4 | V1 accounting depth | ✅ **Approved (option b).** Immutable vouchers, customer and supplier balances, and Tally export. Tally stays the official books for now, and the full ledger is deferred. |
| R2-D5 | V1 simplifications in §10.2 | ✅ **Approved** |
| R2-D6 | Remote-access provider | ⏸ **Not locked.** Evaluate Cloudflare Tunnel and alternatives during discovery (Discovery Pack §5). |
| R2-D7 | Discovery questionnaire and checklist | ✅ **Approved for use**, prioritized by the [Factory Discovery Pack](discovery/factory-discovery-pack.md). |

---

## 3. Revised cloud/local topology

### 3.1 Two paths, one app
```
LOCAL   phone / PC ──▶ factory Wi-Fi/LAN ──▶ factory DNS answers LAN IP ──▶ Caddy LAN listener ──▶ core
REMOTE  phone / PC ──▶ internet ──▶ public DNS ──▶ tunnel edge ──▶ outbound tunnel ──▶ Caddy remote listener ──▶ core
                         both use  https://dashboard.factorydomain.com  — same build, same origin
```
- **The same URL, build and origin on both paths.** Cookies, the PWA install, the service worker and the IndexedDB offline queue are shared. A phone that moves from factory Wi-Fi to 4G keeps the same app and the same queue.
- **The LAN path has no internet dependency at run time.** DNS is answered locally, the TLS certificate is stored on the node, auth is local, assets are local and data is local.
- **The core sets the network context from the listener** that received the request (`lan` or `remote`). It never trusts headers for this. Remote-only policies, such as mandatory TOTP and the roles allowed remote access, use this context.
- **The cloud is never in the LAN request path.**

### 3.2 Should the frontend be hosted on Vercel?
There are three options:
- **A.** The node serves the UI and the API on both paths. *(Recommended.)*
- **B.** The static UI is hosted on Vercel for remote users, and the node serves the same UI on the LAN.
- **C.** Everyone loads the UI from Vercel, including LAN users. *(Rejected.)*

C is rejected for three reasons:
- Devices that need to load or update the app would depend on the internet.
- Browsers increasingly restrict public websites from calling private-network addresses (Chrome's private/local network access rules).
- It mixes origins.

A versus B:

| Criterion | A — the node serves the app | B — Vercel UI plus tunnel API |
|---|---|---|
| LAN works with no internet | Yes | Yes. The LAN path is option A anyway, so we maintain both. |
| Remote first-load speed | Through the tunnel. Hashed static assets can be cached at the tunnel edge, which comes close to CDN speed after the first load. | CDN speed |
| Remote experience while the factory is offline | The edge or a separate status page says "factory unreachable" | The UI loads but every call fails, so there's still no data |
| UI/API version consistency | **Always matched.** One build lives on the node. | **Risk of skew.** Vercel deploys independently of node upgrades, so it needs version pinning or per-version deploys. |
| Origins, cookies, CORS | Single origin, first-party cookies, no CORS | Cross-origin API, CORS, cross-site cookie rules and a larger CSRF surface |
| PWA and offline queue across Wi-Fi and 4G | One origin, so one install and one queue | Two origins, so two installs and two separate queues |
| Moving parts | DNS and the tunnel | DNS, the tunnel, a Vercel project, a second build pipeline and environment config |
| Supply-chain surface | Code is served from the node we control | A compromised Vercel account could serve malicious JavaScript to remote users |
| Multi-tenant later | Each node serves its own version | Per-tenant builds or a version-routing layer |
| Cost | No extra cost | Commercial use may need a paid plan (check the current terms) |

**Recommendation (R2-D1): option A.** Vercel, or any static host, helps only with things outside the application: a marketing site, documentation, a public status page and SaaS sign-up later. None of those touch factory data.

### 3.3 LAN name resolution and HTTPS
Secure-context features need HTTPS on the LAN: service workers, PWA install and the camera. Public CAs don't issue certificates for private IPs. So the LAN path needs **a real hostname that resolves locally**.

| Option | How it works | Pros | Cons |
|---|---|---|---|
| **1. Split-horizon DNS (recommended)** | Inside the factory, `dashboard.factorydomain.com` resolves to the node's LAN IP. Either the router holds a static DNS entry, or the node runs a small resolver that DHCP hands out. | Same origin everywhere. Works during internet outages. | The router has to support it, or let us change DHCP DNS. Phones with "Private DNS" set to a specific provider bypass local DNS, so a fallback is needed. |
| 2. Public record pointing to a private IP (`lan.` subdomain) | A public A record points at 192.168.x.x | No router changes | **Fails during internet outages**, because resolving it needs internet. Some routers block such answers (rebinding protection). Different origin. |
| 3. Plain HTTP by IP address | `http://192.168.x.x` | Simple | No service worker, PWA or camera API. Passwords cross Wi-Fi in clear text. |
| 4. Private certificate authority | Root certificate installed on every device | Works offline | Painful on personal phones and every new device |

**Certificate renewal:** the node renews its certificate over DNS-01 whenever it's online. Industry certificate lifetimes keep getting shorter, so renewal must be automatic, with an alert well before expiry. A very long outage could otherwise expire the certificate.

**Discovery checks:**
- router make and model
- who has admin access to the router
- whether DHCP's DNS setting can be changed
- phone Private-DNS settings on a sample of devices

### 3.4 Remote access security and support access
- **Only the remote listener sits behind the tunnel.** The database, SSH and admin ports are never exposed.
- **Remote access is limited:** only roles marked remote-allowed may use it, and TOTP is mandatory. An identity-aware proxy (such as the tunnel provider's access product) can optionally sit in front for admin roles.
- **Our support access** (upgrades and incidents) goes over SSH through the tunnel provider's access product or a mesh VPN. It uses keys plus MFA and has no public SSH port. Every session is logged, and the OWNER can revoke it at any time (R2-D6).
- **When the factory is unreachable**, remote users see a clear message, either the tunnel provider's error page (where it can be customized) or a status page hosted **elsewhere**.

### 3.5 What the cloud provides in Factory V1

| Service | Purpose | If it is down |
|---|---|---|
| DNS (public) | Remote name resolution | Remote access fails. The LAN is unaffected because it uses local DNS. |
| Tunnel edge | Remote ingress | Remote access fails. The LAN is unaffected. |
| Object storage (India region, object lock) | Off-site encrypted backups | Backups queue locally and raise an alert after a threshold. |
| External uptime monitor | Detects a node that is down or unreachable | Alerts go silent. A weekly self-test of the monitor catches this. |
| Cloud LLM API (optional, policy-gated) | AI fallback | Falls back to local AI or no AI (§9) |
| GSP/ASP APIs (if applicable) | E-invoice and e-way bill | Items queue as PENDING (§8) |
| Code hosting, CI, image registry | Build and release | No updates. No effect at run time. |

---

## 4. Factory V1 vs SaaS Later boundary

### 4.1 Boundary
| Concern | Factory V1 | SaaS Later |
|---|---|---|
| Tenancy | One tenant, one node, one database | A database per tenant across a fleet, possibly a pooled tier (§4.3) |
| Server | One local server | On-prem fleet plus cloud-hosted nodes |
| Authentication | Local accounts and TOTP | Plus SSO/OIDC through an off-the-shelf IdP. Nodes keep local login. |
| Remote access | Tunnel and split-horizon DNS (§3) | Subdomain-per-tenant routing managed by the control plane |
| Backups | pgBackRest and restic to one bucket, with tenant-scoped prefix and keys | A backup catalog, automated restore verification across the fleet |
| Monitoring | External heartbeat monitor plus node-local alert checks | A fleet health dashboard |
| Updates | `factoryerp upgrade` by us, over support access, in an agreed window, with a backup first | Staged rollouts, canaries, signed images |
| Onboarding | Manual, with a runbook and import templates | Self-serve onboarding |
| Billing and licensing | None | Subscriptions and license keys |
| Configuration | One company's configuration held as data | Per-tenant branding and feature plans |
| AI | Local, or cloud only by policy | Possibly a pooled cloud AI gateway |

**Factory V1 must-haves:**
- one factory
- one local server
- a local database
- local authentication
- local AI where the hardware qualifies
- remote access
- encrypted backups
- monitoring
- reliable updates

### 4.2 Seams V1 keeps open (cheap now, expensive to retrofit)
- **A tenant-scoped database handle.** All database access goes through a database handle resolved at the request boundary (`ctx.db`). In V1 it always returns the single pool. This is the hook for per-tenant routing, or for injecting tenant IDs, later.
- **UUIDv7 keys everywhere.** There are no sequences that span tenants, and human-readable numbers are scoped per company. Tenants can therefore be merged later without key collisions.
- **No factory-specific code branches.** Everything specific to the factory is configuration or data.
- **Expand/contract (backward-compatible) migrations from day one.** That discipline lets a mixed-version fleet run safely later.
- **Node identity lives in config.** The node ID and tenant slug go in node configuration, not in business tables.
- **Stable endpoint formats.** Health, version and metrics endpoints use formats a control plane can consume later.
- **Backups namespaced and encrypted per tenant.**
- **Configurable hostnames and domains.** Nothing is hard-coded.
- **Deliberately not done in V1:** `tenant_id` columns, row-level security, a tenant registry and billing.

### 4.3 Database per tenant at 1, 10, 100 and 1,000 factories
The key insight is that for **on-prem** tenants, the database count is not the problem. Each database lives on its own box, so the hard part is managing a **fleet of physical servers**. The database-count question applies only to **cloud-hosted** tenants.

| Factories | On-prem fleet | Cloud-hosted tenants (database per tenant) | Verdict |
|---|---|---|---|
| **1** | One box with manual runbooks | — | Trivial. Nothing to build. |
| **10** | Scripted upgrades looping over nodes, an inventory of nodes, hardware and versions, per-tenant backup prefixes and keys, one monitor check per node. Hardware variety starts to cost support time. | 10 databases on one managed Postgres instance is trivial. | Scripts and discipline cover it. Inventory and version reporting become worth automating. |
| **100** | Fleet operations become the main cost: some site has a hardware, power or network incident every week. Mixed versions in the field mean migrations and APIs must tolerate version skew. Enrollment, staged rollouts, remote diagnostics and automated restore checks are needed, and **a standard hardware specification is strongly advised.** | 100 databases on one or two clusters works. It needs connection pooling per database, a migration orchestrator with retries and reporting, and per-database monitoring. Restoring one tenant to a point in time needs tooling, because backup tools restore whole clusters. | A database per tenant still works. **The on-prem fleet** is what hurts, so a control plane is required. |
| **1,000** | An edge-appliance business: a support team, hardware logistics and automation everywhere | Databases are sharded across several clusters. Each database adds catalog, autovacuum and connection overhead. Release migrations become multi-hour orchestrated rollouts. Restore and export need per-tenant tooling, and product analytics across tenants need ETL. | Workable with tooling. For small tenants, the cost per tenant may justify a **pooled shared-schema "lite" tier**. Decide on economics. |

**Where it gets hard:** these are rules of thumb, to be re-checked with load tests at the time.
- **On-prem:** roughly 10–30 nodes without automation.
- **Cloud:** several hundred databases per cluster before sharding becomes necessary.

**Triggers to revisit:**
1. More than 10 nodes, or a second operations person → build a minimal control plane: inventory, health dashboard and scripted rollout.
2. More than about 200 cloud databases per cluster, or migrations that overrun the maintenance window → sharding and migration orchestration.
3. Many tenants below a revenue threshold → evaluate a pooled tier.

**What the later change to shared schema would involve:**
- add `tenant_id` with a default value to every table
- widen unique constraints and foreign keys to include it
- enable row-level security
- prove isolation with tests

The work is mechanical but large. UUID keys make merging tenants collision-free.

---

## 5. Technology decisions that should remain open

### 5.1 Principle
The architecture depends on **capabilities and protocols, not versions**:
- **Postgres features:** transactional DDL, exclusion constraints and `pg_trgm`, which every supported major has.
- **IDs:** UUIDv7 generated by the application.
- **AI runtimes:** OpenAI-compatible HTTP.
- **Storage:** the S3-compatible API.
- **Data contracts:** OpenAPI and JSON Schema.
- **Packaging:** containers.

### 5.2 Open decisions and what to verify before each ADR
| Component | Proposed family | Stays open until | Verify before the ADR |
|---|---|---|---|
| Server runtime | Node.js Active LTS | Phase 0B starts | LTS status and end-of-life date on the official schedule. At least 18 months of support left. All chosen libraries support it. |
| HTTP framework | Fastify | 0B | Current major. Compatibility of the Zod type provider and the cookie, rate-limit, multipart and static plugins. |
| Contracts | Zod | 0B | A release with native JSON Schema export. Compatibility with the OpenAPI generator and the Fastify provider. |
| Database | PostgreSQL | 0B | A supported major with at least 3 years of support left (official versioning policy). Compatibility with the backup tool, pg-boss, Kysely and extensions in the chosen image. |
| Database access and jobs | Kysely, SQL migrations, pg-boss | 0B | Supported Postgres versions, and whether each project is actively maintained |
| Web stack | React, Vite, TanStack and a component library | 0B spike | Performance budget on the low-end Android phones that discovery identifies |
| PDF rendering | Chromium-based or Typst | First invoicing module | The factory's real template (Indic text, pre-printed stationery) and printer types |
| Document AI sidecar | Python with FastAPI | Document AI phase | The OCR library's supported Python versions, and wheels for amd64 and arm64 |
| OCR engine | PaddleOCR, docTR, Tesseract or a vision-language model | Document AI phase | Accuracy on the factory gold set, CPU latency on the factory box, and license |
| LLM runtime | Ollama, llama.cpp server or vLLM | After the hardware benchmark | Hardware support, tool calling, OpenAI-compatible API, model pinning, license and telemetry settings |
| Models | Open-weight, with tool calling and Indic-language support | After the benchmark | Per-capability eval scores (§9) and a license allowing commercial use |
| Remote ingress and support access | Tunnel plus access product or mesh VPN | 0B (R2-D6) | Terms for commercial use, TLS-termination model and MFA support |
| Backup tooling and storage | pgBackRest or WAL-G, restic, S3-compatible storage | 0B | Support for the chosen Postgres version, an India region, object lock and a measured restore time |
| OS and container runtime | Ubuntu LTS or Debian, Docker Engine or Podman | Hardware chosen | Drivers (including GPU) and the LTS window |
| Uptime monitor | Hosted or self-hosted | 0B | Alert channels: WhatsApp, SMS, email |
| Code hosting, CI and registry | GitHub (S15) | 0B | Private registry and multi-architecture builds |

### 5.3 Verification checklist (each ADR records the results)
1. The official release and end-of-life page was checked. Record the URL and date.
2. The remaining support window covers V1's planned life.
3. There is a compatibility matrix against every adjacent component.
4. It builds and runs on **arm64 (dev) and amd64 (factory)**, proven in a CI matrix.
5. The license suits both on-prem distribution and SaaS.
6. Known critical issues and CVEs were reviewed.
7. Minor and major upgrade paths are documented.
8. Versions are pinned exactly (lockfile, image digest), with a dependency-update policy.

---

## 6. Regulatory verification requirements

### 6.1 Principles
- **v0.1 stated several regulatory facts from memory. They are retracted as facts.** They include:
  - the e-invoicing turnover threshold
  - the invoice-number length limit
  - the triplicate-copy rule
  - the September 2025 rate restructuring
  - the retention period
  - the audit-trail start date
  - SMS template registration rules
  - HSN digit rules
  - QR payload contents
  - the GSTIN check-digit rule
- Every one of these is now a **`[VERIFY R-nn]` placeholder.**
- **Rules live as effective-dated, versioned rule data.** Each rule carries its citation, `effective_from`, `effective_to`, who verified it and when, and its test cases. Code reads the rules. It never embeds thresholds.
- **No rule is used in production until it reaches `CA_CONFIRMED`.**

### 6.2 Regulatory register (every item starts UNVERIFIED)
| ID | Area | What the architecture needs to know | Used by | Where to verify (official) |
|---|---|---|---|---|
| R-01 | GST rates | Rate per HSN/SAC with effective dates, including any rate changes and restructurings in force | GST engine, rate master | CBIC rate notifications. GST Council decisions. |
| R-02 | Tax invoice particulars | Mandatory fields, invoice-number format (length, characters, uniqueness per fiscal year), number of copies for goods, signature requirements, multiple series | Invoice service, numbering, templates | CGST Act and Rules (CBIC) |
| R-03 | Other GST documents | Bill of supply, credit and debit notes, receipt and refund vouchers: contents and time limits | Sales and purchase modules | CGST Act and Rules (CBIC) |
| R-04 | Time of supply | When the invoice must be issued relative to dispatch | Invoice workflow | CGST Act (CBIC) |
| R-05 | Place of supply | Intra- vs inter-state, bill-to/ship-to, SEZ, exports | GST engine | IGST Act (CBIC) |
| R-06 | E-invoicing | Turnover threshold, exempt categories, reporting time limits, cancellation window, current schema version, QR payload and signature verification | E-invoice adapter, document AI | GST e-invoice portal and GSTN advisories. CBIC notifications. |
| R-07 | E-way bill | Thresholds (inter-state and state-specific intra-state), when it is needed (including job work), validity, Part B, cancellation | Dispatch, e-way bill adapter | E-way bill portal. State notifications. |
| R-08 | HSN/SAC digits | Digits required on invoices and in returns, by turnover band and B2B vs B2C | Item master validation, templates | CBIC notifications |
| R-09 | GSTIN | Structure, check-digit algorithm, state code list | Validation, OCR checks | GSTN/GST portal documentation |
| R-10 | Rounding | Rounding of tax amounts in law, and accepted invoice-level practice | GST engine | CGST Act (CBIC), plus the CA |
| R-11 | Reverse charge | Which of the factory's inward supplies are under reverse charge (for example freight) | Purchase posting | CBIC notifications |
| R-12 | Job work | Challans, return time limits, and the reporting form and how often it is filed | Job-work flows (if discovery finds them) | CGST Act and Rules (CBIC) |
| R-13 | Composition scheme | Implications, if the entity uses it | Invoice type | CBIC |
| R-14 | Return data formats | GSTR-1/IFF formats, GSTR-3B, GSTR-2B structure | Exports, reconciliation | GST portal and GSTN |
| R-15 | Record retention | Retention periods under GST, income tax and company law | Retention classes | CGST Act, Income-tax Act, Companies Act (official texts) |
| R-16 | Audit trail | Edit-log requirements for accounting software, and whether they apply to this entity type | Audit design | Companies Act rules (MCA). ICAI guidance. |
| R-17 | TDS/TCS | Current sections and thresholds for purchase or sale of goods and for contractor/professional payments | Purchase and sales, payments | Income Tax Department, plus the CA |
| R-18 | MSME payment timelines | Payment-period rules for registered micro and small suppliers and their tax consequences | Payables ageing alerts | MSMED Act (Ministry of MSME). Income-tax Act. |
| R-19 | Labour rules | Working hours, overtime, weekly rest, shift restrictions, contract labour, under whichever central labour codes and state rules apply now | Allocation constraints, attendance | Ministry of Labour and Employment. State labour department. |
| R-20 | Minimum wages | State rates, if wage calculation ever enters scope | Payroll (deferred) | State labour department |
| R-21 | Personal data | Obligations under the DPDP Act and Rules and their commencement timelines | Employee and customer data handling | MeitY |
| R-22 | Commercial messaging | SMS registration and template rules, and WhatsApp business messaging rules | Notifications | TRAI. Provider documentation. |
| R-23 | Exports | LUT, export invoice particulars and currency, if applicable | Export invoices | CBIC. DGFT. |
| R-24 | Electronic signing | Requirements for digitally signed invoice PDFs, if used | PDF rendering | CGST Rules. IT Act. |

**Where to look:**
- cbic-gst.gov.in for GST Acts, Rules and notifications
- gstcouncil.gov.in
- gst.gov.in and its tutorials/advisories
- the GST e-invoice portal and the e-way bill portal
- incometaxindia.gov.in
- mca.gov.in
- labour.gov.in and the state labour department
- meity.gov.in
- trai.gov.in
- msme.gov.in
- ICAI guidance

Secondary sources such as blogs and vendor articles may help locate a rule, but they are **never** the citation.

### 6.3 Verification workflow
```
UNVERIFIED → SOURCE_FOUND (official citation + retrieval date) → CA_CONFIRMED (interpretation for this factory)
           → ENCODED (effective-dated rule data) → TESTED (golden cases) → in production
```
- **Owner of the register:** our team. **Interpretation:** the CA.
- **Monitoring:** subscribe to GSTN and CBIC advisories, plus a quarterly review of the register.
- **A rule change ships as data**, not as an emergency code change: a new effective-dated version plus new golden cases.

---

## 7. CA/accounting validation requirements

### 7.1 The pipeline (mandatory for every financial or tax capability)
```
1 Rule spec ──▶ 2 Deterministic engine ──▶ 3 Test-case pack ──▶ 4 CA validation
(plain language,   (pure code, versioned,     (inputs + engine outputs,   (CA marks each case,
 worked examples    unit + property tests)     incl. real past invoices    annotates, signs
 from real docs)                               re-computed)                against engine version)
                                                                                  │
7 Production ◀──── 6 Parallel run ◀────────── 5 Golden test suite ◀──────────────┘
(capability flag    (system vs current         (signed cases frozen in repo;
 set by OWNER with   process; every difference   CI blocks any output change;
 CA sign-off ref)    explained or fixed)         a change requires re-sign-off)
```

### 7.2 What the CA validates
| Capability | What the CA validates | Evidence |
|---|---|---|
| Tax computation | Line- vs rate-wise summation, rounding, place of supply, reverse charge, exempt and nil-rated items, SEZ and export | A signed case pack |
| Document formats | Mandatory particulars, numbering series, copies, credit and debit notes | Signed specimen PDFs |
| Voucher and posting mapping | Accounts, round-off, discounts, freight and other charges (GL posting if R2-D4 picks option a) | A signed mapping table |
| Tally export | Vouchers and masters import correctly into a **copy** of their Tally company, and ledgers match | An import test report |
| Receivables and payables | Bill-wise allocation, advances, ageing | Reconciled party statements |
| GST return data | GSTR-1 data equals the invoices, including the HSN summary | A reconciliation report |
| Stock valuation (if used in the books) | Method and cost of goods sold | A signed method note |
| Opening balances and cut-over | Outstanding balances and stock at cut-over match the current books | A signed cut-over reconciliation |
| TDS/TCS (if applicable) | Applicability and computation | Signed cases |

### 7.3 Readiness is enforced in software, not just documented
| State | What the system allows |
|---|---|
| `DEVELOPMENT` | Test data only |
| `CA_REVIEW` | Generates case packs. Documents use a **TEST series** and carry a "SPECIMEN — NOT A TAX DOCUMENT" watermark. |
| `PARALLEL_RUN` | Real data alongside the existing process. Documents are still watermarked and are not given to customers. |
| `PRODUCTION` | Real numbering series and real documents. The OWNER enables it, the CA sign-off reference is recorded, and both are audited. |

Each financial capability, such as sales invoicing, purchase entry, Tally export or GST export, carries its own state.

### 7.4 Golden suite rules
- **Each case is a fixture** with an id, a description, inputs, expected outputs, the engine version, a reference to the redacted source document, the CA sign-off reference and a date.
- **Signed outputs are protected.** CI fails if any change alters a signed output. Changing one needs a new sign-off, which is recorded in the sign-off register.
- **Rule changes add cases.** A regulatory change adds new effective-dated cases. Old cases stay valid for old dates.

### 7.5 What we need from the CA
- A named contact and a paid engagement. Budget for review sessions in each financial phase.
- A copy of the Tally company for import tests.
- Recent filed-return summaries for reconciliation.
- Agreement on rounding and posting conventions.
- A turnaround commitment.

The CA validates our outputs. **The business stays legally responsible for its compliance**, so every output must be reviewable and traceable to its rule version.

---

## 8. Offline boundary

### 8.1 Principle
The factory server is the only authority. Devices can **capture** a limited set of floor facts while disconnected. They never **decide** anything financial.

### 8.2 V1 offline whitelist
| Workflow | Offline in V1 | Guardrails |
|---|---|---|
| Attendance | Yes | Records both device time and server receive time. Entries with large clock skew or late sync are flagged for supervisor approval. |
| Production entries | Yes | Recorded as reported facts. The server applies stock effects when the entry syncs. If that fails, the entry goes to the exceptions inbox, never into silent loss. |
| Downtime | Yes | Same pattern |
| Quality checks | Yes | Same pattern |
| Maintenance tickets | Yes (create and update status) | Same pattern |
| Photo capture | Yes | Compressed on the device and uploaded on reconnect, with size caps |
| Drafts | Yes, saved **on the device only** | They become server drafts on sync and are never issued offline. |
| Invoices, credit and debit notes, receipts and payments, POs, GRNs, stock transfers and adjustments, master data, approvals, user admin, AI copilot | **No** | Online against the node only. On the LAN, the node is effectively always reachable. |

### 8.3 Guardrails for offline capture
- **Offline mode needs an existing session.** New logins can't be verified offline.
- **Shift-length sessions on floor devices.** Logging out is blocked while queued entries remain.
- **Replay is safe and visible.** It runs in order with idempotency keys, so nothing duplicates. Nothing is ever merged silently: a rejection goes back to the user and the supervisor with its reason.
- **Queue loss is guarded against:**
  - the app requests persistent browser storage
  - a pending-items counter is always visible
  - the user is nudged when items stay unsynced too long
  - supervisors see which devices are holding unsynced items

### 8.4 What happens during each outage

**Internet outage** (the node and LAN are fine)
- **Works:** everything on the LAN, including invoicing, stock, reports, login, printing, and local AI if present.
- **Stops:** remote access, cloud AI (falls back to local AI or none), e-invoice IRN and e-way bill generation, online GSTIN checks, outbound email and WhatsApp, and off-site backup uploads.
- **Queues:**
  - IRN and e-way bill requests (shown as PENDING; final printing is blocked where e-invoicing applies)
  - notifications
  - backup uploads, with local WAL retained and disk alerts on
  - certificate renewal retries
- **Users see** a banner such as "Internet offline since 10:42. Remote access, e-invoicing and cloud AI paused. 7 items queued."
- **Recovery:** queues drain automatically, and anything that failed appears in the exceptions inbox.
- **Data-loss exposure:** none locally. The **off-site** recovery point grows with the outage, so a local second-disk backup covers that gap.
- **Compliance caveat:** if e-invoicing or e-way bills apply [VERIFY R-06, R-07], some dispatches may legally have to wait. In that case a **failover internet link** (an inexpensive 4G/5G router) should be a V1 requirement.

**Factory server outage** (hardware or software failure)
- **Works:** signed-in phones keep capturing whitelisted floor facts locally. Everything else falls back to the agreed paper procedure.
- **Stops:** everything else for everyone, on the LAN and remotely.
- **Users see** "Server unreachable — 12 entries saved on this phone". Remote users see the status page.
- **Alerting:** the external monitor alerts the owner and us within minutes.
- **Recovery:**
  1. Auto-restart, or a manual restart.
  2. If the hardware is dead, restore the latest point-in-time backup to spare hardware or a temporary cloud VM, following the runbook within the agreed RTO (S16).
  3. Phones replay their queues against the same hostname.
- **Data-loss exposure:** transactions after the last archived WAL, **only if the disk is lost**. That window is the RPO.
- **Business continuity:** a pre-agreed manual procedure with paper registers and a **reserved manual invoice series** for outages. Its validity is confirmed with the CA [VERIFY R-02]. Entries are backfilled later and flagged as such.

**A client phone offline** (no coverage)
- **Works on that phone:** the whitelisted workflows and cached read-only reference data.
- **Doesn't work:** everything else, new logins and live data.
- **Sync:** on reconnect, through **either** factory Wi-Fi or mobile data, because both use the same origin. The server validates every entry.
- **Data-loss exposure:** entries exist only on the phone until they sync, so a lost or reset phone loses them. The guardrails in §8.3 reduce this risk.

**Cloud outage**
- **Tunnel or edge provider down:** remote access fails, and the LAN is unaffected. The status page must be hosted with a different provider.
- **Object storage down:** backups queue locally, with an alert once the backup is older than the threshold.
- **Cloud LLM down:** falls back to local AI or none.
- **Uptime monitor down:** alerts go silent. The weekly monitor self-test catches this.
- **GST systems or the GSP/ASP down:** e-invoice and e-way bill items stay PENDING, the same as during an internet outage.
- **Code hosting or registry down:** no updates are possible. Nothing changes at run time.
- **No cloud outage affects LAN operation.**

**Power outage**
- **Shorter than the UPS runtime:** the node, the network switch, the router **and the Wi-Fi access points** are all on the UPS, so the LAN keeps working. If the access points aren't on the UPS, phones lose access even though the server is still up.
- **Longer than the UPS runtime:** the UPS signals the node, which shuts down gracefully at a set battery level. Phones fall back to the offline whitelist.
- **Generator switch-over:** an online UPS and surge protection are recommended because of brownouts and spikes.
- **Restore:**
  1. BIOS powers the machine on when AC returns.
  2. The OS boots, containers auto-start and health checks pass.
  3. A "node back" alert goes out.
  4. Phones replay their queues.
- **Data-loss exposure:** none after a graceful shutdown. After an abrupt power loss, Postgres crash recovery preserves committed transactions. The real risk from repeated hard power loss is disk damage, which is why the UPS, a journaling filesystem and backups matter.

**LAN or Wi-Fi failure** (the server is fine)
- **Affected area:** devices in that area lose LAN access.
- **Phones on mobile data:** because both paths share one hostname, they can reach the node through the tunnel if the internet is up. They are still subject to remote-access policy.
- **Open question:** should floor roles be allowed remote access for whitelisted workflows only? (S12)

---

## 9. Hardware-adaptive AI architecture

### 9.1 Principle
**Every AI feature speeds up a manual path that already exists and works.** The ERP is complete with AI switched off. AI earns its place per capability, per machine, through measurement.

### 9.2 Provider selection
```
for each request: capability C, data class D
  candidates = providers registered for C, kept only if
      policy.allows(C, D, provider)     # OWNER-configured; default = local only
      provider.healthy()                # runtime up; model loadable within memory budget
      provider.qualified(C)             # passed C's eval threshold on THIS hardware (benchmark record)
  choose first by preference: local → cloud
  none left → AI_UNAVAILABLE → UI shows the manual path (always present)
```

### 9.3 Capabilities and their fallbacks without AI
| Capability | Local (if qualified) | Cloud (if policy permits) | Without AI (always available) |
|---|---|---|---|
| Copilot questions (READ tools) | Small model with tool calling | Cloud model | Search, filters, reports and dashboards, which render the **same tool outputs** |
| Copilot drafting (DRAFT tools) | Same | Same | Forms with smart defaults: last price, last quantity, open orders |
| "Why did production fall?" | LLM narrates the variance tools' output | Same | A deterministic variance report showing the same numbers as a table |
| Digital PDF bills | Optional field mapping | Same | Text-layer parsing and rules, then the review screen |
| Printed photos and scans | CPU OCR plus a local LLM or vision model (slow but acceptable as a batch job) | Cloud vision model | Manual entry beside the image, keeping the deterministic checks: QR decode, GSTIN validation, duplicate check, supplier match |
| Handwritten bills | Rarely qualifies | Cloud vision model | Manual entry beside the image |
| Workforce allocation | Not an LLM. A constraint solver on CPU. | — | Manual allocation board |
| Semantic search, voice input | Later | Later | Normal search |

### 9.4 Capability detection and qualification
- **Detection:** at install time and after hardware changes, the node records CPU cores, RAM, GPU (vendor and memory) and free disk.
- **`factoryerp ai benchmark`:** for each installed model and capability, it measures:
  - time to first token
  - tokens per second
  - peak memory
  - accuracy on that capability's eval subset (tool-selection cases, extraction gold set)

  The results become **qualification records**.
- **Qualification:** a model qualifies for a capability only above agreed accuracy and latency thresholds. A model that is installed but unqualified is **not used**, because a slow, wrong copilot is worse than none.

### 9.5 Resource governance
- **AI never degrades the ERP.** AI runtimes run under hard CPU and memory caps.
- **Memory budget:** the AI cap equals total RAM minus Postgres, the core, the OS and headroom. A model that doesn't fit is never loaded.
- **Idle unloading:** models unload when idle.
- **Priorities:** batch OCR yields to interactive work during business hours. The Postgres process is protected from the out-of-memory killer.

### 9.6 Policy and UX
- **OWNER policy** is set per capability: local only, cloud allowed, or off. It **defaults to local only, or off where no local model qualifies.**
- **Cloud audit:** every cloud call records the capability, the fields sent and the provider. Bank details and credentials are never sent (RESTRICTED class).
- **UX:** every AI result shows whether it came from a local or cloud model. When AI is unavailable, the UI says so in one line and opens the manual path. AI never blocks a workflow.

### 9.7 To be measured on the real server later
- Copilot tool-selection accuracy and latency.
- OCR accuracy and time per page on the factory's own documents.
- Concurrent load: Postgres plus the API plus AI during business hours.
- Power draw and temperature under sustained AI load.

---

## 10. Hostile architecture review

### 10.1 Things that could go wrong
| # | Failure | How it happens | Mitigation |
|---|---|---|---|
| 1 | **Nobody on the floor uses it** | Paper and WhatsApp stay easier, so the data is incomplete and dashboards and AI work on garbage | Design entry screens around the existing paper forms. Have supervisors enter data first. Treat **data completeness** as a KPI. Involve users from discovery onward. |
| 2 | **The server dies and the restore was never practised** | Disk failure, surge, heat, dust or someone unplugging it leads to days of downtime | Monthly restore drills, disk-health alerts, a spare-hardware plan, a runbook, and RPO/RTO targets |
| 3 | **A tax or numbering error surfaces months later** | An edge case (rounding, place of supply, credit notes) slips through, forcing re-issues, possible penalties and lost trust | The CA pipeline (§7), parallel runs, effective-dated rules |
| 4 | **Data migration is wrong at cut-over** | Opening balances, GSTINs or stock are imported incorrectly, the system starts wrong and never regains trust | Treat migration as a first-class work item with dry runs and a CA-signed cut-over reconciliation (§10.3) |
| 5 | **Remote access exposes too much** | A misconfigured tunnel publishes an admin or database port, or a weak password on a remote-allowed role is exploited | Only the remote listener is published, TOTP is mandatory remotely, an external scan runs after setup, and remote roles are allow-listed |
| 6 | **Backups that can't be decrypted** | The encryption key lived only on the server that died | Keys escrowed with the OWNER offline. Drills restore using the escrowed key. |
| 7 | **Silent backup failure fills the disk** | Expired credentials or a stuck WAL archive cause disk growth until Postgres stops | Alerts on backup age, archive lag and disk use |
| 8 | **Date and time bugs** | UTC-vs-IST or fiscal-year-boundary errors give an invoice dated 31 March the wrong FY or number | `date` type for business dates, IST boundary tests, NTP, clock-skew flags on offline entries |
| 9 | **Local AI takes down Postgres** | Loading a model triggers the out-of-memory killer during billing hours | Hard memory caps, a memory budget, Postgres protected from the OOM killer (§9.5) |
| 10 | **Confirmation fatigue** | The copilot drafts the wrong party, item grade or unit (kg vs tonnes), and a busy user clicks Confirm | Action cards highlight resolved entities and anomalies against history. Typed confirmation for high values. Credit-note path. |
| 11 | **Supplier bank-detail fraud** | A bill with changed bank details leads to payment to a fraudster | Bank details come from the master only and never from OCR. Maker-checker. Owner alert on change. |
| 12 | **A regulatory change lands mid-period** | A rate or threshold changes and the rule data isn't updated in time | Advisory monitoring, effective-dated rules, quarterly register review |
| 13 | **Split-horizon DNS doesn't hold** | Router limits or Private DNS settings route LAN phones through the internet, and during an outage the LAN app fails | Site check in discovery, node-hosted resolver, replace the router if needed, documented fallback |
| 14 | **The bus factor** | The one engineer who knows the node is unavailable during an incident | Runbooks, a boring stack, ADRs, a second trained person, a support-access procedure |
| 15 | **A bad update breaks a shift** | A migration or bug ships into working hours | Upgrades only after hours, a backup first, staging on an anonymized copy of production data, a tested rollback |

### 10.2 What we are over-engineering for Factory #1
| # | Item | Why it is too much right now | Recommendation | Status |
|---|---|---|---|---|
| 1 | Control plane and fleet tooling | One node | Use runbooks and scripts | **Applied in v0.2** |
| 2 | WebSocket realtime | V1 has no chat, and dashboards tolerate a 30–60 second refresh | Polling, with WebSocket later alongside chat | **Applied in v0.2** |
| 3 | A **full general ledger and posting-rule engine** in V1 while Tally stays the books of record | It would run two sets of books. Immutable source vouchers let the GL be derived later by deterministic posting, so deferring it is **not** a rewrite. This corrects the v0.1 claim that it would be. | V1 builds immutable vouchers, party sub-ledgers (bill-wise), the tax breakdown and Tally export. The GL comes when replacing Tally is decided. | **Proposed (R2-D4)** |
| 4 | A hash-chained audit log | Serializes every audited write. Append-only storage plus restricted grants plus off-site backups give most of the value. | Append-only audit plus a **daily digest hash** stored off-site with the backups | Proposed (R2-D5) |
| 5 | RBAC scopes (company, location, department) and broad field masking from day one | About ten office users and one plant | Roles and permissions, plus explicit masks for salary, cost and bank fields. Keep the scope columns but build no UI until a second plant or department needs it. | Proposed (R2-D5) |
| 6 | Multi-company, multi-GSTIN and multi-plant UI | Probably a single GSTIN | Keep `company_id`. Build the UI only if discovery shows more than one entity. | Proposed (R2-D5) |
| 7 | An LLM gateway with a data-class routing matrix and redaction | Cloud AI is off by default | A per-capability policy (local, cloud or off) plus logging. Data classes come once cloud AI is actually enabled. | Proposed (R2-D5) |
| 8 | Kiosk mode and a device registry | Unknown whether workers will use shared devices | Build only if discovery confirms it. The session list stays because it is cheap. | Proposed (R2-D5) |
| 9 | Python sidecar, several runtimes and hardware tiers inside the foundations | The AI phases come later | No `docai` until the Document AI phase. One runtime, chosen after the benchmark. | **Applied in v0.2** |
| 10 | Image signing and staged rollouts | One node | Pin images by digest now and sign them before SaaS | **Applied in v0.2** |

### 10.3 What we may be under-engineering
| # | Gap | Why it matters | Action |
|---|---|---|---|
| 1 | **Data migration and cut-over** | The first impression and trust depend on correct opening data | Import templates, validation reports, dry runs and a CA-signed cut-over for each module |
| 2 | **Support and operations model** | Someone has to answer at 9 pm when billing is down | Named responders, a support-access procedure, runbooks, spare hardware, an incident log, and service terms agreed with the owner |
| 3 | **The factory network** | The architecture assumes a working LAN | Site survey: Wi-Fi on the floor (metal sheds), access points and switches on the UPS, router able to do local DNS, server isolated, a **failover internet link** |
| 4 | **Printing** | Indian factories print invoices in multiple copies, challans, gate passes and labels, sometimes on dot-matrix pre-printed stationery or thermal label printers | A printing design after discovery. Label printers probably need a small print agent, because browser printing can't send raw label commands. |
| 5 | **Master-data quality** | Duplicate or inconsistently named parties and items break OCR matching, AI entity resolution and reports | Dedupe tools, naming conventions, approval for new master records, cleansing during migration |
| 6 | **Physical identification** | Typing machine and material names on a phone is slow and error-prone | QR or barcode labels on machines (scan to raise a ticket), material and batch labels, work-order travellers |
| 7 | **Excel in and out everywhere** | Owners and CAs work in Excel | Every list and report exportable, plus bulk import templates for master data |
| 8 | **Performance on low-end Android phones and poor Wi-Fi** | A heavy PWA fails exactly where it's needed | A performance budget, a lean bundle, image compression before upload, testing on the factory's real phones |
| 9 | **Office PC security** | Malware on the accountant's PC can steal a LAN session, and TOTP only protects remote sessions | Step-up re-authentication for sensitive actions, shorter sessions for finance roles, endpoint hygiene guidance |
| 10 | **Clock and attendance integrity** | Device clock skew, buddy punching, backdating | Two timestamps, skew flags, supervisor approval paths, keeping the biometric device as the attendance source |

### 10.4 Product assumptions to validate at the factory
| # | Assumption | If it's false |
|---|---|---|
| 1 | Phones are **allowed** and practical on the floor (safety, gloves, dust, noise), and supervisors or workers have smartphones | Floor capture moves to fixed terminals or tablets, or a supervisor desk, and the PWA priorities change |
| 2 | Supervisors will record production per shift in the system, and output can be counted per machine or shift | The production module design changes, for example to batch or weight-based recording, or to end-of-shift entry from registers |
| 3 | **Internet is unreliable enough to justify local-first**, rather than power being the real problem | If the internet is reliable and power isn't, cloud hosting with a 4G-backed LAN might be cheaper. Measure with two-week diaries. |
| 4 | The owner wants a **conversational copilot** | A daily WhatsApp or PDF summary plus the exceptions inbox may deliver more value first |
| 5 | **Workforce allocation is a real daily decision** with real constraints | If operators are fixed per machine, "AI allocation" has no problem to solve, so deprioritize it |
| 6 | Purchase-bill **volume and mix** make OCR beat manual entry | If there are few bills or most are already digital PDFs or e-invoices, document AI drops in priority |
| 7 | The CA will engage, and Tally is the current system of record | §7 needs a different validation partner, and the export target changes |
| 8 | **Invoicing is the biggest pain** | Start where the pain actually is: receivables collection, stock visibility or production tracking |
| 9 | The site can host a server reliably (space, heat, dust, power, someone on site) | A cloud-hosted node or a sealed appliance becomes the better option |

### 10.5 Where an existing product, API or service beats building
| Need | Use | Why | Caveat |
|---|---|---|---|
| Remote ingress and support access | A tunnel service with an access product, or a mesh VPN | No open ports, works behind CGNAT, built-in MFA | Vendor dependency and TLS termination (R2-D6) |
| E-invoice, e-way bill, GSTIN verification, GSTR-2B | Licensed GSP/ASP APIs | They absorb regulatory and schema churn | Cost per call and lock-in, so keep an adapter interface |
| Books of record and statutory reports | **Tally**, kept and integrated through its import/export interfaces | The CA already knows it | Integration fragility, so test imports against a copy |
| Payroll and statutory deductions | Existing payroll software or the CA's service | Legal complexity | We export attendance to it |
| Notifications | WhatsApp Business Platform through a provider, an email service, standard Web Push | Channel compliance is handled for us | Template approval and per-message cost |
| Backups | pgBackRest or WAL-G, plus restic and object storage | Proven tools, so we never write backup code | Run restore drills anyway |
| Monitoring | A hosted heartbeat/uptime service, or a small self-hosted one | Working on day one | One more account to manage |
| Ad-hoc analytics for power users | An open-source BI tool on the read-only reporting role | Avoids building a report builder | Check the license if it's ever embedded in SaaS |
| Handwriting and difficult documents | Cloud document AI or a vision-model API, where policy allows | Much better than local options on handwriting | Data leaves the premises, and it costs money |
| Attendance capture | **The existing biometric devices**, integrated | Already trusted and paid for | Vendor protocols vary, so it's a discovery item |
| Chat (later) | WhatsApp (the status quo) or an integrated self-hostable open-source chat server | Building channels and DMs is expensive and doesn't differentiate us | Integration and SSO work |
| SSO for SaaS (later) | An off-the-shelf identity provider | Security-critical and commodity | Nodes keep local login |
| PDF rendering | A packaged headless-Chromium document service | No need to manage the browser ourselves | One more container |

### 10.6 Strategic tensions you should resolve explicitly
1. **"Local AI" + "modest hardware" + "AI-native."** On entry-level hardware, an AI-native experience will mostly come from cloud models or not at all. When these conflict, which promise wins? *My suggestion:* data stays on-premises by default, cloud AI is an explicit opt-in per capability, and a "local AI box" is offered as a priced upgrade.
2. **"Local-first" + "low operating cost."** Each factory needs a server, a UPS, network fixes and support, so a cloud-hosted node is cheaper to run. Local-first pays for itself only where outages are real. Validate with assumption 3.
3. **"AI workforce allocation" as a differentiator.** It is mainly a data-capture and constraint-solving problem. With no reliable attendance, skills and machine-requirement data, there's nothing to allocate. So it comes **after** attendance and production data exist, and only if assumption 5 holds.

---

## 11. Factory discovery questionnaire
The full questionnaire is in **[`docs/discovery/factory-discovery-questionnaire.md`](discovery/factory-discovery-questionnaire.md)**. It is a separate file so it can be printed and filled in on site.

**Structure:**
- An interview plan saying who to interview, in what order, and how to record answers as told, observed or documented.
- Sixteen sections:
  - A: Company and legal
  - B: Products and process
  - C: Materials and inventory
  - D: Machines and maintenance
  - E: Production planning and recording
  - F: Workforce, shifts and attendance
  - G: Sales and customers
  - H: Purchasing and suppliers
  - I: Accounting and finance
  - J: Quality
  - K: Communication and tasks
  - L: Management reporting
  - M: IT, network, power and devices
  - N: Security and data access
  - O: AI expectations
  - P: Data, migration and cut-over
- A closing section for success criteria and pain-point ranking.
- Every question has an ID (for example `G-07`), so findings can cite it.
- The questionnaire **asks rather than assumes.** No workflow in this document is treated as fact until discovery confirms it.

## 12. Required documents and data collection checklist
The full checklist is in **[`docs/discovery/data-collection-checklist.md`](discovery/data-collection-checklist.md)**. It covers:
- legal registrations
- sales and purchase documents, with target sample sizes for the AI gold set
- inventory, production, maintenance and workforce records
- accounting exports from Tally
- quality records
- IT and site survey items
- two-week power and internet diaries

**Data-handling rules (mandatory):**
- Get the owner's written consent before collecting.
- Redact Aadhaar numbers, bank account numbers and individual salaries.
- Store originals **encrypted and outside this repository**. They are never committed to git.
- Label every sample with its source and date.
- Using documents for AI evaluation needs explicit permission. Sending any of them to a cloud AI service for benchmarking needs separate permission.

## 13. Recommended next step
1. **The owner reviews this round** and answers R2-D1 to R2-D7 (§2.1).
2. **Run discovery** with the questionnaire and checklist: about 2 days on site, plus 2 weeks of power and internet diaries and a network and server-location survey. Introduce the CA.
3. **We produce "Discovery Findings & V1 Scope"**, containing:
   - process maps
   - confirmed workflows
   - the V1 module cut and order
   - a revised phase plan
   - which regulatory items V1 depends on
   - the hardware recommendation
4. **Only then record ADRs.** Version-sensitive ADRs are verified at that time (§5.3).
5. **Only after the ADRs are approved:** Phase 0B (platform foundations).

**This review ends here. Nothing will be scaffolded, migrated or implemented until you approve.**
