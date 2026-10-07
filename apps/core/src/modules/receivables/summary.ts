import {
  PERMISSIONS,
  type AgeingAmounts,
  type AgeingBucketKey,
  type CustomerReceivableDto,
  type ReceivablesSummaryDto,
} from '@factory-erp/contracts';
import { Money } from '@factory-erp/money';
import { z } from 'zod';
import { businessDate } from '../../platform/clock';
import { defineQuery } from '../../platform/queries';
import { ageingBucketOf, emptyAgeing } from './domain';
import { allocatedSql } from './receipt-dto';
import { openInvoicesOf } from './queries';

interface Acc {
  invoiced: Money;
  credited: Money;
  received: Money;
  unallocated: Money;
  outstanding: Money;
  openCount: number;
  ageing: Record<AgeingBucketKey, Money>;
}

const newAcc = (): Acc => ({
  invoiced: Money.zero(),
  credited: Money.zero(),
  received: Money.zero(),
  unallocated: Money.zero(),
  outstanding: Money.zero(),
  openCount: 0,
  ageing: emptyAgeing(),
});

const balanceOf = (a: Acc) => a.invoiced.minus(a.credited).minus(a.received);

const ageingStrings = (a: Record<AgeingBucketKey, Money>): AgeingAmounts => ({
  d0_30: a.d0_30.toString(),
  d31_60: a.d31_60.toString(),
  d61_90: a.d61_90.toString(),
  d90_plus: a.d90_plus.toString(),
});

/**
 * Customer receivables: balances from the party ledger, bill-wise outstanding and ageing from
 * invoice allocations and credit notes, and unallocated (on-account) receipt money. Reconciles
 * by construction (with no opening balances):
 *   balance = Σ outstanding − Σ unallocated
 * because cancelled invoices are reversed in the ledger and can carry no payments or credits.
 */
export const getReceivablesSummary = defineQuery({
  name: 'finance.receivables.summary',
  description:
    'Receivables per customer: balance, outstanding invoices, unallocated receipts and ageing buckets.',
  input: z.object({}),
  permission: PERMISSIONS.receivablesRead,
  ai: { tier: 'READ' },
  handler: async ({ db, companyId, now }): Promise<ReceivablesSummaryDto> => {
    const asOf = businessDate(now);
    const byCustomer = new Map<string, Acc>();
    const acc = (id: string) => {
      let a = byCustomer.get(id);
      if (!a) byCustomer.set(id, (a = newAcc()));
      return a;
    };

    const ledger = await db
      .selectFrom('finance.partyLedgerEntries')
      .select([
        'partyId',
        'entryType',
        (eb) => eb.fn.sum<string>('debit').as('debit'),
        (eb) => eb.fn.sum<string>('credit').as('credit'),
      ])
      .where('companyId', '=', companyId)
      .groupBy(['partyId', 'entryType'])
      .execute();
    for (const l of ledger) {
      const a = acc(l.partyId);
      const net = Money.of(l.debit).minus(Money.of(l.credit)); // what this entry type adds to the balance
      switch (l.entryType) {
        case 'RECEIPT':
          a.received = a.received.minus(net);
          break;
        case 'CREDIT_NOTE':
          a.credited = a.credited.minus(net);
          break;
        default: // invoices, their cancellations and opening balances
          a.invoiced = a.invoiced.plus(net);
      }
    }

    const receipts = await db
      .selectFrom('finance.receipts as r')
      .select(['r.customerId', 'r.amount'])
      .select(allocatedSql.as('allocated'))
      .where('r.companyId', '=', companyId)
      .execute();
    for (const r of receipts) {
      const a = acc(r.customerId);
      a.unallocated = a.unallocated.plus(Money.of(r.amount).minus(Money.of(r.allocated)));
    }

    for (const inv of await openInvoicesOf(db, companyId, null, asOf)) {
      const a = acc(inv.customerId);
      const outstanding = Money.of(inv.outstandingAmount);
      a.outstanding = a.outstanding.plus(outstanding);
      a.openCount++;
      const bucket = ageingBucketOf(inv.ageDays);
      a.ageing[bucket] = a.ageing[bucket].plus(outstanding);
    }

    const ids = [...byCustomer.keys()];
    const parties = ids.length
      ? await db
          .selectFrom('party.parties')
          .select(['id', 'code', 'name', 'isCustomer'])
          .where('companyId', '=', companyId)
          .where('id', 'in', ids)
          .execute()
      : [];

    const total = newAcc();
    const customers: CustomerReceivableDto[] = parties
      .filter((p) => p.isCustomer)
      .map((p) => {
        const a = byCustomer.get(p.id) ?? newAcc();
        total.invoiced = total.invoiced.plus(a.invoiced);
        total.credited = total.credited.plus(a.credited);
        total.received = total.received.plus(a.received);
        total.unallocated = total.unallocated.plus(a.unallocated);
        total.outstanding = total.outstanding.plus(a.outstanding);
        total.openCount += a.openCount;
        for (const k of Object.keys(a.ageing) as AgeingBucketKey[]) {
          total.ageing[k] = total.ageing[k].plus(a.ageing[k]);
        }
        return {
          customerId: p.id,
          code: p.code,
          name: p.name,
          invoicedAmount: a.invoiced.toString(),
          creditedAmount: a.credited.toString(),
          receivedAmount: a.received.toString(),
          balance: balanceOf(a).toString(),
          outstandingAmount: a.outstanding.toString(),
          unallocatedAmount: a.unallocated.toString(),
          openInvoiceCount: a.openCount,
          ageing: ageingStrings(a.ageing),
        };
      })
      .sort(
        (x, y) => Money.of(y.balance).compare(Money.of(x.balance)) || x.name.localeCompare(y.name),
      );

    return {
      asOf,
      totals: {
        invoicedAmount: total.invoiced.toString(),
        creditedAmount: total.credited.toString(),
        receivedAmount: total.received.toString(),
        balance: balanceOf(total).toString(),
        outstandingAmount: total.outstanding.toString(),
        unallocatedAmount: total.unallocated.toString(),
        openInvoiceCount: total.openCount,
        ageing: ageingStrings(total.ageing),
      },
      customers,
    };
  },
});
