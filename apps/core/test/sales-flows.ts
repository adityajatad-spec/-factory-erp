import type {
  CreditNoteDto,
  CreditNoteLineInput,
  InvoiceDto,
  PartyDto,
  ReceiptDto,
  ReceivablesSummaryDto,
} from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import { sql } from 'kysely';
import { recordReceipt } from '../src/modules/receivables/commands';
import { getReceivablesSummary } from '../src/modules/receivables/summary';
import { cancelInvoice } from '../src/modules/sales/cancel-command';
import { createCreditNoteDraft, issueCreditNote } from '../src/modules/sales/credit-notes/commands';
import { getCreditNote } from '../src/modules/sales/credit-notes/queries';
import { createInvoiceDraft } from '../src/modules/sales/draft-commands';
import { issueInvoice } from '../src/modules/sales/issue-command';
import { getInvoice } from '../src/modules/sales/queries';
import type { AuthenticatedActor } from '../src/platform/actor';
import type { Fixture } from './fixtures';
import type { TestEnv } from './test-db';

/**
 * Business-level helpers for sales-correction tests. Everything goes through the real command
 * and query buses (validation, RBAC, transactions, audit), exactly like the HTTP API.
 *
 * Handy amounts (widget @ 18 % GST, intra-state, rounded to the rupee):
 *   1 × ₹8,474.58 → taxable 8,474.58 + CGST 762.71 + SGST 762.71 = ₹10,000.00
 *   1 × ₹1,694.92 → taxable 1,694.92 + CGST 152.54 + SGST 152.54 = ₹2,000.00
 */
export function salesFlows(env: () => TestEnv, fx: () => Fixture, today: string) {
  const cmd = () => env().services.commands;
  const qry = () => env().services.queries;
  const accountant = () => fx().actors.accountant;

  async function issued(
    unitRate: string,
    opts: { date?: string; customer?: PartyDto; quantity?: string; withCarton?: boolean } = {},
  ): Promise<InvoiceDto> {
    const lines = [{ itemId: fx().items.widget.id, quantity: opts.quantity ?? '1', unitRate }];
    if (opts.withCarton)
      lines.push({ itemId: fx().items.carton.id, quantity: '10', unitRate: '50' });
    const draft = await cmd().execute(
      createInvoiceDraft,
      {
        customerId: (opts.customer ?? fx().customers.intra).id,
        invoiceDate: opts.date ?? today,
        lines,
      },
      accountant(),
    );
    return cmd().execute(
      issueInvoice,
      { invoiceId: draft.id, expectedVersion: draft.version },
      accountant(),
    );
  }

  const invoice = (id: string, actor: AuthenticatedActor = accountant()) =>
    qry().execute(getInvoice, { invoiceId: id }, actor);
  const creditNote = (id: string) =>
    qry().execute(getCreditNote, { creditNoteId: id }, accountant());

  function draftCredit(
    inv: InvoiceDto,
    lines: CreditNoteLineInput[],
    opts: {
      actor?: AuthenticatedActor;
      customerId?: string;
      date?: string;
      reasonCode?: 'SALES_RETURN' | 'POST_SALE_DISCOUNT' | 'PRICE_CORRECTION';
    } = {},
  ): Promise<CreditNoteDto> {
    return cmd().execute(
      createCreditNoteDraft,
      {
        invoiceId: inv.id,
        customerId: opts.customerId ?? inv.customerId,
        creditNoteDate: opts.date ?? today,
        reasonCode: opts.reasonCode ?? 'SALES_RETURN',
        reason: 'Goods returned by the customer (test)',
        lines,
      },
      opts.actor ?? accountant(),
    );
  }

  function issueCredit(
    cn: CreditNoteDto,
    opts: { actor?: AuthenticatedActor; key?: string } = {},
  ): Promise<CreditNoteDto> {
    return cmd().execute(
      issueCreditNote,
      { creditNoteId: cn.id, expectedVersion: cn.version },
      opts.actor ?? accountant(),
      opts.key ? { idempotencyKey: opts.key } : {},
    );
  }

  /** Draft + issue in one go. */
  async function credit(
    inv: InvoiceDto,
    lines: CreditNoteLineInput[],
    opts: { date?: string } = {},
  ): Promise<CreditNoteDto> {
    return issueCredit(await draftCredit(inv, lines, opts));
  }

  function receipt(
    amount: string,
    allocations: Array<{ invoiceId: string; amount: string }> = [],
    customerId = fx().customers.intra.id,
  ): Promise<ReceiptDto> {
    return cmd().execute(
      recordReceipt,
      {
        customerId,
        receiptDate: today,
        amount,
        paymentMode: 'BANK_TRANSFER',
        reference: 'UTR-TEST',
        allocations,
      },
      accountant(),
    );
  }

  function cancel(
    inv: InvoiceDto,
    opts: { actor?: AuthenticatedActor; reason?: string; version?: number; key?: string } = {},
  ): Promise<InvoiceDto> {
    return cmd().execute(
      cancelInvoice,
      {
        invoiceId: inv.id,
        expectedVersion: opts.version ?? inv.version,
        reason: opts.reason ?? 'Raised in error (test)',
      },
      opts.actor ?? accountant(),
      opts.key ? { idempotencyKey: opts.key } : {},
    );
  }

  const summary = (): Promise<ReceivablesSummaryDto> =>
    qry().execute(getReceivablesSummary, {}, accountant());

  /** Customer balance straight from the append-only party ledger. */
  async function ledgerBalance(partyId: string): Promise<string> {
    const r = await env()
      .services.db.selectFrom('finance.partyLedgerEntries')
      .select(sql<string>`coalesce(sum(debit - credit), 0)::numeric(18,2)::text`.as('v'))
      .where('partyId', '=', partyId)
      .executeTakeFirstOrThrow();
    return r.v;
  }

  const ledgerOf = (sourceId: string) =>
    env()
      .services.db.selectFrom('finance.partyLedgerEntries')
      .selectAll()
      .where('sourceId', '=', sourceId)
      .orderBy('createdAt')
      .execute();

  const count = async (
    table: 'sales.creditNotes' | 'finance.partyLedgerEntries' | 'audit.events',
  ): Promise<number> =>
    Number(
      (
        await env()
          .services.db.selectFrom(table)
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );

  const money = (s: string) => Money.of(s).toString();

  return {
    issued,
    invoice,
    creditNote,
    draftCredit,
    issueCredit,
    credit,
    receipt,
    cancel,
    summary,
    ledgerBalance,
    ledgerOf,
    count,
    money,
  };
}
