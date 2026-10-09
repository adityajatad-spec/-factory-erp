import {
  ListSupplierPaymentsQuery,
  OpenPayablesQuery,
  PERMISSIONS,
  Uuid,
  type OpenPayableDto,
  type PayableAmounts,
  type PayablesSummaryDto,
  type SupplierPaymentDto,
  type SupplierPaymentListItemDto,
} from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import { sql } from 'kysely';
import { z } from 'zod';
import type { DbExecutor } from '../../db/database';
import { addDays, businessDate, daysBetween } from '../../platform/clock';
import { defineQuery } from '../../platform/queries';
import { outstandingOfPurchase, purchasePaidSql } from '../purchasing';
import {
  allocatedSql,
  loadSupplierPaymentDto,
  selectSupplierPayments,
  toSupplierPaymentListItem,
} from './dto';

/** "This week": due in the next 7 days, today included. */
export const DUE_SOON_DAYS = 7;

export const listSupplierPayments = defineQuery({
  name: 'finance.supplierPayments.list',
  description:
    'List supplier payments, newest first: pending approval, approved (with what is still on account) or rejected.',
  input: ListSupplierPaymentsQuery,
  permission: PERMISSIONS.payablesRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  examples: [
    {
      description: 'Supplier payments waiting for approval',
      input: { status: 'PENDING_APPROVAL' },
    },
    { description: 'What has been paid to suppliers', input: { status: 'APPROVED' } },
  ],
  handler: async ({ db, companyId }, input): Promise<SupplierPaymentListItemDto[]> => {
    let q = selectSupplierPayments(db, companyId);
    if (input.supplierId) q = q.where('sp.supplierId', '=', input.supplierId);
    if (input.status) q = q.where('sp.status', '=', input.status);
    if (input.onlyUnallocated) {
      q = q
        .where('sp.status', '=', 'APPROVED')
        .where(sql<boolean>`${allocatedSql}::numeric < ${sql.ref('sp.amount')}`);
    }
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
      q = q.where((eb) =>
        eb.or([
          eb('sp.paymentNumber', 'ilike', like),
          eb('p.name', 'ilike', like),
          eb('sp.reference', 'ilike', like),
        ]),
      );
    }
    const rows = await q
      .orderBy('sp.paymentDate', 'desc')
      .orderBy('sp.requestedAt', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map(toSupplierPaymentListItem);
  },
});

export const getSupplierPayment = defineQuery({
  name: 'finance.supplierPayments.get',
  description:
    'One supplier payment with who requested and approved it, the bills it settles and what is left on account.',
  input: z.object({ paymentId: Uuid }),
  permission: PERMISSIONS.payablesRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  handler: ({ db, companyId }, input): Promise<SupplierPaymentDto> =>
    loadSupplierPaymentDto(db, companyId, input.paymentId),
});

/** Posted bills that still have money owed, by due date (oldest first). */
export async function openPayablesOf(
  db: DbExecutor,
  companyId: string,
  asOf: string,
  filter: { supplierId?: string; overdue?: boolean; dueWithinDays?: number } = {},
): Promise<OpenPayableDto[]> {
  let q = db
    .selectFrom('purchase.invoices as pi')
    .innerJoin('party.parties as p', 'p.id', 'pi.supplierId')
    .select([
      'pi.id',
      'pi.invoiceNumber',
      'pi.supplierInvoiceNumber',
      'pi.supplierId',
      'p.name as supplierName',
      'pi.invoiceDate',
      'pi.dueDate',
      'pi.grandTotal',
    ])
    .select(purchasePaidSql.as('paidAmount'))
    .where('pi.companyId', '=', companyId)
    .where('pi.status', '=', 'POSTED')
    .where(sql<boolean>`${sql.ref('pi.grandTotal')} > ${purchasePaidSql}::numeric`);
  if (filter.supplierId) q = q.where('pi.supplierId', '=', filter.supplierId);
  if (filter.overdue) q = q.where('pi.dueDate', '<', asOf);
  if (filter.dueWithinDays !== undefined) {
    q = q
      .where('pi.dueDate', '>=', asOf)
      .where('pi.dueDate', '<', addDays(asOf, filter.dueWithinDays));
  }
  const rows = await q.orderBy('pi.dueDate').orderBy('pi.invoiceNumber').execute();
  return rows.map((r) => {
    const late = daysBetween(r.dueDate, asOf);
    return {
      purchaseInvoiceId: r.id,
      invoiceNumber: r.invoiceNumber ?? '',
      supplierInvoiceNumber: r.supplierInvoiceNumber,
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      invoiceDate: r.invoiceDate,
      dueDate: r.dueDate,
      grandTotal: r.grandTotal,
      paidAmount: r.paidAmount,
      outstandingAmount: outstandingOfPurchase(r.grandTotal, r.paidAmount),
      daysOverdue: Math.max(0, late),
      isOverdue: late > 0,
    };
  });
}

export const listOpenPayables = defineQuery({
  name: 'finance.payables.openInvoices',
  description:
    'Supplier bills that are not fully paid, by due date: optionally only overdue ones, or those due in the next N days.',
  input: OpenPayablesQuery,
  permission: PERMISSIONS.payablesRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  examples: [
    { description: 'Show unpaid supplier invoices', input: {} },
    { description: 'Which supplier bills are overdue?', input: { overdue: 'true' } },
    { description: 'What is due to suppliers this week?', input: { dueWithinDays: 7 } },
  ],
  handler: async ({ db, companyId, now }, input): Promise<OpenPayableDto[]> =>
    openPayablesOf(db, companyId, businessDate(now), input),
});

interface Acc {
  billed: Money;
  paid: Money;
  outstanding: Money;
  unallocated: Money;
  overdue: Money;
  dueSoon: Money;
  pending: Money;
  openCount: number;
  overdueCount: number;
}

const newAcc = (): Acc => ({
  billed: Money.zero(),
  paid: Money.zero(),
  outstanding: Money.zero(),
  unallocated: Money.zero(),
  overdue: Money.zero(),
  dueSoon: Money.zero(),
  pending: Money.zero(),
  openCount: 0,
  overdueCount: 0,
});

const amountsOf = (a: Acc): PayableAmounts => ({
  billedAmount: a.billed.toString(),
  paidAmount: a.paid.toString(),
  balance: a.billed.minus(a.paid).toString(),
  outstandingAmount: a.outstanding.toString(),
  unallocatedAmount: a.unallocated.toString(),
  overdueAmount: a.overdue.toString(),
  dueThisWeekAmount: a.dueSoon.toString(),
  pendingApprovalAmount: a.pending.toString(),
  openInvoiceCount: a.openCount,
  overdueInvoiceCount: a.overdueCount,
});

function addInto(total: Acc, a: Acc) {
  total.billed = total.billed.plus(a.billed);
  total.paid = total.paid.plus(a.paid);
  total.outstanding = total.outstanding.plus(a.outstanding);
  total.unallocated = total.unallocated.plus(a.unallocated);
  total.overdue = total.overdue.plus(a.overdue);
  total.dueSoon = total.dueSoon.plus(a.dueSoon);
  total.pending = total.pending.plus(a.pending);
  total.openCount += a.openCount;
  total.overdueCount += a.overdueCount;
}

/**
 * What we owe suppliers: the balance from the payable ledger, bill-wise outstanding, overdue
 * and due-this-week from posted bills and allocations, and approved money still on account.
 * Reconciles by construction: balance = Σ outstanding − Σ unallocated (no opening balances
 * yet), because every posted bill is a ledger credit and every approved payment a debit.
 */
export const getPayablesSummary = defineQuery({
  name: 'finance.payables.summary',
  description:
    'Payables per supplier: how much we owe, what is overdue or due this week, what has been paid and what is on account.',
  input: z.object({}),
  permission: PERMISSIONS.payablesRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  examples: [{ description: 'How much do we owe each supplier?', input: {} }],
  handler: async ({ db, companyId, now }): Promise<PayablesSummaryDto> => {
    const asOf = businessDate(now);
    const bySupplier = new Map<string, Acc>();
    const acc = (id: string) => {
      let a = bySupplier.get(id);
      if (!a) bySupplier.set(id, (a = newAcc()));
      return a;
    };

    const ledger = await db
      .selectFrom('finance.payableLedgerEntries')
      .select([
        'partyId',
        (eb) => eb.fn.sum<string>('debit').as('debit'),
        (eb) => eb.fn.sum<string>('credit').as('credit'),
      ])
      .where('companyId', '=', companyId)
      .groupBy('partyId')
      .execute();
    for (const l of ledger) {
      const a = acc(l.partyId);
      a.billed = a.billed.plus(Money.of(l.credit));
      a.paid = a.paid.plus(Money.of(l.debit));
    }

    const payments = await db
      .selectFrom('finance.supplierPayments as sp')
      .select(['sp.supplierId', 'sp.status', 'sp.amount'])
      .select(allocatedSql.as('allocated'))
      .where('sp.companyId', '=', companyId)
      .where('sp.status', 'in', ['APPROVED', 'PENDING_APPROVAL'])
      .execute();
    for (const p of payments) {
      const a = acc(p.supplierId);
      if (p.status === 'APPROVED') {
        a.unallocated = a.unallocated.plus(Money.of(p.amount).minus(Money.of(p.allocated)));
      } else {
        a.pending = a.pending.plus(Money.of(p.amount));
      }
    }

    const soonEnd = addDays(asOf, DUE_SOON_DAYS);
    for (const bill of await openPayablesOf(db, companyId, asOf)) {
      const a = acc(bill.supplierId);
      const outstanding = Money.of(bill.outstandingAmount);
      a.outstanding = a.outstanding.plus(outstanding);
      a.openCount++;
      if (bill.isOverdue) {
        a.overdue = a.overdue.plus(outstanding);
        a.overdueCount++;
      } else if (bill.dueDate < soonEnd) {
        a.dueSoon = a.dueSoon.plus(outstanding);
      }
    }

    const ids = [...bySupplier.keys()];
    const parties = ids.length
      ? await db
          .selectFrom('party.parties')
          .select(['id', 'code', 'name'])
          .where('companyId', '=', companyId)
          .where('id', 'in', ids)
          .execute()
      : [];

    const total = newAcc();
    const suppliers = parties
      .map((p) => {
        const a = bySupplier.get(p.id) ?? newAcc();
        addInto(total, a);
        return { supplierId: p.id, code: p.code, name: p.name, ...amountsOf(a) };
      })
      .sort(
        (x, y) => Money.of(y.balance).compare(Money.of(x.balance)) || x.name.localeCompare(y.name),
      );

    return { asOf, totals: amountsOf(total), suppliers };
  },
});
