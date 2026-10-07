# ADR 0002 — Sales correction path: invoice cancellation and credit notes

- **Status:** Accepted, implemented 2026-10-07 (migration `0006_sales_corrections.sql`).
- **Context:** Issued invoices are immutable, ledgers are append-only and balances are derived (ARCHITECTURE §M, R2-D4). Mistakes and returns still have to be correctable. Factory discovery is deferred, so these are engineering decisions on synthetic data. Every tax rule below is a **CA validation point**, not confirmed policy.

## Decisions

### 1. Cancellation is a state transition plus a reversing entry — never an edit or a delete

- `ISSUED → CANCELLED` happens only through the `sales.invoice.cancel` command. It needs `expectedVersion` and a reason (3–500 characters).
- The invoice keeps its number, values, line snapshots and PDF forever. The PDF is not regenerated; the UI labels it "as issued".
- `cancelled_at`, `cancelled_by` and `cancellation_reason` are written **once**, by that transition only:
  - A CHECK constraint makes them mandatory exactly when the status is `CANCELLED`.
  - The `guard_invoice_update` trigger rejects any later change (FO002), any other status transition, and cancelling a draft. Drafts are deleted, not cancelled.
- The customer balance is corrected with a **new** `INVOICE_CANCELLATION` credit equal to the invoice's original debit. The original `SALES_INVOICE` debit stays.
- The unique `(source_type, source_id, entry_type)` key makes a second reversal impossible.

### 2. Only an invoice that nothing has settled can be cancelled

- If payments are allocated (`INVOICE_HAS_PAYMENTS`) or credit notes are issued (`INVOICE_HAS_CREDIT_NOTES`), cancellation is rejected.
- Allowing it would need receipt un-allocation or a refund. Those are separate accounting decisions that are **not modelled**, and none is invented here.
- **Enforcement:**
  - The command checks under the settlement lock (§6).
  - The update trigger re-checks with a fresh snapshot.
  - The FO003 allocation check rejects payments to a cancelled invoice.
- Draft credit notes may exist against a cancelled invoice, but they can no longer be issued.

### 3. A credit note is its own document, not a negative invoice

- **Storage:** `sales.credit_notes` and `sales.credit_note_lines`.
- **Lifecycle:** `DRAFT → ISSUED`. Once issued, it is immutable (FO002 triggers, mirroring invoices): content, lines and the PDF reference (set once). Only drafts can be deleted.
- **Numbering:** issuing assigns `CN/<FY>/<nnnnn>` from the **existing** `system.number_series` (doc type `CREDIT_NOTE`, prefix `companies.credit_note_prefix`, default `CN`).
  - Gapless, consecutive and date-ordered per financial year, exactly like invoices and receipts. No parallel implementation.
  - Number length stays configurable data [VERIFY R-02/R-03].
- **Stored with the note:** the engine version and every computed value, plus snapshots of seller and customer, exactly like invoices.

### 4. One credit note credits exactly one issued invoice, line by line

- **Composite foreign key:** `(invoice_id, customer_id, company_id) → sales.invoices (id, customer_id, company_id)` makes a cross-customer or cross-company credit note impossible, even with raw SQL.
- **Explicit customer:** the API also requires the customer explicitly (`CUSTOMER_MISMATCH` otherwise). This guards against a person, or later the AI, picking the wrong invoice.
- **Fixed invoice:** the invoice of a draft can never change. Delete the draft and start again.
- **Line model:** each line credits one invoice line as quantity × unit rate.
  - The invoice line's own discount % and GST rate apply, priced by the **same GST engine** with the invoice's supplier state, place of supply and stored rounding policy.
  - For a return, use the invoiced rate. For a price reduction, use the reduction per unit.
  - Crediting every line in full reproduces the invoice totals exactly.
- **Deferred:** credit notes not linked to an invoice, or spanning several invoices.

### 5. Caps: nothing can be over-credited, and outstanding never goes negative

| Rule | Code |
|---|---|
| Per line: quantity ≤ invoiced quantity | `EXCEEDS_LINE_QUANTITY` |
| Per line: unit rate ≤ invoiced unit rate | `EXCEEDS_LINE_RATE` |
| Per invoice line: Σ credited taxable value (all issued credit notes) ≤ invoiced taxable value | `EXCEEDS_LINE_CREDITABLE` |
| Credit note total ≤ invoice outstanding (grand total − payments − earlier credit notes) | `EXCEEDS_INVOICE_OUTSTANDING` |
| Credit note total > ₹0, and no line crediting ₹0 | `CREDIT_NOTE_ZERO` |
| Not dated before the invoice; not in the future at issue | `CREDIT_NOTE_BEFORE_INVOICE`, `CREDIT_NOTE_DATE_IN_FUTURE` |

- **When rules are checked:**
  - Requests are validated whole, with every problem reported.
  - Drafts are checked when saved, for early feedback.
  - Issue re-checks everything on the locked state.
- **Consequence:** a credit note **after full payment** is rejected until refund or on-account handling is decided (see the CA points below).

### 6. One settlement invariant, enforced twice

For every issued invoice: **Σ allocations + Σ issued credit notes ≤ grand total**.

- **Application:** everything that changes an invoice's settlement — allocating a payment, issuing a credit note, cancelling — first takes `lockInvoicesForSettlement`.
  - That is a row lock in id order, so there are no deadlocks.
  - Paid and credited amounts are read **after** the lock.
  - Lock order is always document → invoice → number series, so there are no cycles.
- **Database (deferred, at COMMIT):**
  - `finance.check_allocation` (FO003) now counts credit notes.
  - The new `sales.check_credit_note` (FO004) re-checks invoice status, date, line caps and the invariant.
- **Proven by a mutation test:** with the settlement lock removed from credit-note issue, the forced-interleaving test fails, because a credit note was issued on stale amounts.

### 7. Settlement stays derived

- Outstanding = grand total − Σ allocations − Σ issued credit notes. Nothing is stored or editable.
- `finance.invoice_balances` gains `credited_amount`, appended so existing columns keep their positions.
- Payment status adds **CREDITED**: nothing is outstanding and no money was received.
- Cancelled invoices have no payment status and no outstanding.
- Customer summaries split the ledger into net invoiced, credited and received. Balance = invoiced − credited − received = Σ outstanding − Σ unallocated. This is tested for every customer.

### 8. Permissions and AI tiers

| Command | Permission | AI tier |
|---|---|---|
| `sales.invoice.cancel` | `sales.invoice.cancel` | CONFIRM |
| `sales.creditNote.createDraft` / `updateDraft` | `sales.credit_note.draft` | DRAFT |
| `sales.creditNote.deleteDraft` | `sales.credit_note.draft` | CONFIRM |
| `sales.creditNote.issue` | `sales.credit_note.issue` | CONFIRM |
| `sales.creditNotes.list` / `get` (queries) | `sales.invoice.read` | READ |

- The new permissions go to OWNER, ADMIN and ACCOUNTANT. The reviewed role snapshot was updated.
- **Change to ARCHITECTURE G.2.** G.2 listed "cancelling or reversing posted documents" as FORBIDDEN. On the owner's instruction (2026-10-07), invoice cancellation is **CONFIRM**: the AI may at most propose it, and only a human can execute it. The command bus already rejects every non-DRAFT command from an AI actor, so the AI cannot execute it either way. Deleting or reversing ledger entries directly stays FORBIDDEN; no such command exists.

### 9. Dashboard definitions

- "Today's sales" and "Invoices issued this month" exclude cancelled invoices and are gross of credit notes.
- "**Net** sales this financial year" = invoices − credit notes issued in the financial year (by credit-note date).
- Receivables KPIs come from the ledger and the derived balances, so cancellations and credit notes are reflected automatically.

### 10. PDFs

- **One template for both documents:** the same pure HTML template and the same locked-down headless Chrome renderer, with JavaScript off and the network blocked. The document `kind` selects the title (TAX INVOICE / CREDIT NOTE), the original-invoice reference and reason, and the watermark ("SPECIMEN — NOT A VALID CREDIT NOTE" until finance readiness is PRODUCTION).
- **No payment details on credit notes:** they omit bank details and sale terms.
- **Generation:** the outbox topic `sales.credit_note.issued` creates a hash-verified `docs.documents` row (`SALES_CREDIT_NOTE_PDF`), attaches it once and audits it as `system`.
- **Shutdown safety:** Playwright's own signal handlers are disabled, so a graceful shutdown finishes in-flight PDF jobs before closing the browser.

### 11. Naming

- **Rename:** the product is **Factory ERP** (2026-10-07), which removes the "operating system" ambiguity. That covers the UI, PDFs, docs, package scope `@factory-erp/*`, logs, Docker project `factory-erp` and the database/user `factoryerp`.
- **Deliberately kept:**
  - SQLSTATE codes `FO001`–`FO004`, which are stable machine identifiers.
  - The header comment of the already-applied migration 0001, because applied migrations are checksummed and immutable.
  - The old `FactoryOS-Discovery/` ignore rule, kept for safety.

## CA validation points raised by this work (all UNVERIFIED)

1. **[VERIFY R-03] Credit notes:**
   - the grounds on which a GST credit note may be issued (our reason codes are a starting list)
   - the time limit for issuing it
   - its mandatory particulars and copies
   - the conditions for post-sale discounts
2. **[VERIFY R-03/R-06] Cancellation:**
   - whether, and until when, an issued tax invoice may be cancelled rather than credited
   - how it is reported in GSTR-1
   - IRN cancellation windows, if e-invoicing applies

   No time window is enforced yet.
3. **Rounding:**
   - Each credit note is rounded to the rupee under the invoice's policy, so several partial credit notes can leave up to about ₹1 residue against the invoice total. Overshoot is rejected, and a remainder stays outstanding.
   - Per-component tax on split credits can differ by a paisa from the original line.
4. **Credit after payment:** whether such credit becomes a refund, an on-account customer credit or an advance, and its GST and ledger treatment. Until then it is rejected.
5. **Stock:** whether returns or cancellations move stock. Invoices do not move stock in V1, so nothing is reversed.

## Consequences

- **Every correction is a new record:** history is reconstructable from the immutable invoice, the credit notes, the ledger entries and the audit trail. The invoice history shows each credit note and the cancellation reason.
- **Not built:** refunds, receipt reversal or un-allocation, credit notes after full payment, unlinked or multi-invoice credit notes, and debit notes. Each needs an accounting decision first.
- **E2E runs:** browser E2E now runs on a throwaway database (`factoryerp_e2e`) with its own data directory, against the production build. The development database is never touched.
