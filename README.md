# Factory ERP

An AI-native ERP for Indian MSME factories: sales, purchasing, inventory, production, workforce, accounting and GST, with a local-first deployment and an AI copilot that acts **only** through typed, permission-checked commands.

> **Status: early prototype.**
>
> - The Phase 0 foundation and the first end-to-end vertical slice are built.
> - **All data is synthetic demo data.** Factory discovery is deferred (see [`docs/discovery/README.md`](docs/discovery/README.md)).
> - GST rates are labelled `DEMO_UNVERIFIED`.
> - Invoice PDFs carry a **SPECIMEN** watermark until a chartered accountant has validated the calculations ([architecture, Round 2 §7](docs/ARCHITECTURE.md)).

## What works today

**The full vertical slice:** sign in → see the demo company → search or create customers and items → draft a sales invoice → deterministic GST calculation → issue it → invoice PDF → audit trail → dashboard.

**The sales-to-cash loop:** issued invoice → customer receipt → bill-wise allocation (full, partial, one receipt across several invoices) → derived outstanding and payment status → receivables ageing.

- Receipts and allocations are **append-only**.
- Outstanding is always **derived** as grand total − Σ allocations, never stored or edited.
- **Overpayment rule:** money that isn't allocated stays on account as a customer credit. It can be allocated later, and is never silently capped.
- Allocation is protected by row locks, plus a deferred SQL check at commit.

**The sales correction path** ([ADR 0002](docs/adr/0002-sales-correction-path.md)): issued invoices are never edited or deleted — they are corrected by a new record.

- **Invoice cancellation:** `ISSUED → CANCELLED` with a mandatory reason, recorded once (who, when, why). The invoice keeps its number, values and PDF. A reversing entry clears the customer balance. Only invoices with no payments and no credit notes can be cancelled — refunds and un-allocation are not modelled yet.
- **Credit notes:** a separate document (`DRAFT → ISSUED`, then immutable) against one issued invoice of the same customer, with its own gapless `CN/<FY>/<n>` series. Lines credit invoice lines (returns at the invoiced rate, or price reductions per unit) through the same GST engine, inheriting the invoice's tax position. Partial and full credits are supported. It can never credit more than a line's taxable value or the invoice's outstanding amount.
- **Derived settlement:** outstanding = grand total − payments − credit notes. Payment status adds `CREDITED`. Receivables, ageing and dashboard KPIs exclude cancelled invoices and net out credit notes.
- **Defence in depth:** one settlement lock serialises payments, credit notes and cancellation on an invoice, and deferred SQL checks re-verify every rule at commit (FO003/FO004).
- **Credit-note PDFs** are generated from the same template and renderer, watermarked SPECIMEN, and hash-verified.

- **Authentication and RBAC**
  - argon2id passwords and server-side sessions in `HttpOnly`/`SameSite=Lax` cookies.
  - Eight seeded roles with code-defined permissions.
  - The UI hides what a role cannot do, and the server enforces it independently.
- **Command bus:** every mutation runs validate → authenticate → authorize → idempotency → transaction → domain rules → persist → audit → outbox. HTTP routes are thin adapters. The future AI copilot will use the same bus, and AI-tier rules are enforced already: the AI can prepare drafts but can never issue an invoice.
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
- purchasing, production, workforce, maintenance, quality and full accounting
- document AI and the AI copilot
- the control plane and SaaS features

The sidebar only shows modules that work.

## Quick start

Prerequisites: **Node 24 (≥ 24.7)**, **pnpm** (`corepack enable`), **Docker**, and Google Chrome or Chromium (for PDFs).

```bash
cp .env.example .env        # local dev settings
pnpm install
pnpm db:up                  # PostgreSQL 18 in Docker (bound to 127.0.0.1 only)
pnpm db:seed                # migrate + load demo data (+ generate demo PDFs)
pnpm dev                    # API on :3000, web on http://127.0.0.1:5173
```

**Demo users:**

- Usernames: `owner`, `admin`, `accountant`, `production`, `purchase`, `hrmanager`, `supervisor`, `worker`.
- Password: `factory-demo` (override with `DEMO_PASSWORD`).
- Try `accountant` for the full invoicing flow, and `worker` to see permission filtering.

**Production-style run** (one origin, the core serves the web app):

```bash
pnpm build
cd apps/core && WEB_DIST_DIR=../web/dist node --env-file=../../.env dist/main.js   # http://127.0.0.1:3000
```

## Commands

| Command                                       | What it does                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm verify`                                 | Format check, lint, typecheck, then every test. Run before pushing.                                                                                          |
| `pnpm test:unit` / `pnpm test:integration`    | Unit tests, or integration tests against real PostgreSQL. Each test file gets its own database cloned from a migrated template.                              |
| `pnpm --filter @factory-erp/web e2e`          | After `pnpm build`: all browser journeys (smoke, receivables, corrections) on a throwaway database with fresh demo data. Your dev database is never touched. |
| `pnpm --filter @factory-erp/web e2e:journeys` | The same journeys against an app you are already running (`BASE_URL`, default `:3000`).                                                                      |
| `pnpm db:migrate`                             | Apply forward-only SQL migrations. They also run automatically at startup.                                                                                   |
| `pnpm db:codegen`                             | Regenerate Kysely types from the database (`--verify` in CI).                                                                                                |
| `pnpm db:seed -- --reset`                     | **Dev only:** drop everything and rebuild the demo dataset.                                                                                                  |

## Repository layout

```
apps/core          Fastify API: platform (command bus, auth, audit, outbox), modules, seed
apps/web           React + Vite web app (served by the core in production)
packages/money     Money / Qty / Rate / Percent (decimal.js) and Indian formatting
packages/gst       Pure GST invoice engine and Indian financial year
packages/contracts Zod schemas, DTO types and permission codes shared by API, web and AI tools
db/migrations      Plain SQL migrations — the database schema is the source of truth
docs/              Architecture, ADRs, deferred factory-discovery material
```

## Engineering rules (enforced, not aspirational)

- **No floats for money.** Values are exact decimal strings end to end. Lint rules ban `parseFloat`/`Math.round` in the financial packages.
- **The database defends invariants:** CHECK constraints, foreign keys, triggers that keep ledgers and audit append-only, immutable issued documents, and non-overlapping effective-dated GST rates.
- **No business logic in routes.** Every mutation goes through the command bus and every read through the query bus.
- **Strict TypeScript** (`noUncheckedIndexedAccess`, `erasableSyntaxOnly`) with type-aware ESLint. Avoid `any`.
- **Regulatory values** (tax rates, number formats, thresholds) are data tagged `[VERIFY R-nn]`, never constants presented as fact.

## Open CA / regulatory validation points

Nothing here is production tax-ready. GST rates are demo data, and invoice and credit-note PDFs stay watermarked SPECIMEN until a chartered accountant validates them. Open points include:

- line-level rounding and rupee rounding of grand totals
- credit-note grounds, particulars and time limits [VERIFY R-03]
- whether and when an issued invoice may be cancelled rather than credited [VERIFY R-03/R-06]
- the treatment of advances and of credits after payment

The full list is in [ADR 0002](docs/adr/0002-sales-correction-path.md) and the regulatory register in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and [`docs/adr/`](docs/adr/) for recorded decisions.
