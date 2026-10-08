import {
  ListInvoicesQuery,
  PERMISSIONS,
  Uuid,
  type InvoiceDto,
  type InvoiceListItemDto,
} from '@factory-erp/contracts';
import { z } from 'zod';
import { defineQuery } from '../../platform/queries';
import { loadInvoiceDto, selectInvoiceList, toInvoiceListItem } from './invoice-dto';
import { paymentStatusPredicate } from './settlement';

export const listInvoices = defineQuery({
  name: 'sales.invoices.list',
  description:
    'List sales invoices, newest first, filtered by status, payment status, customer or number.',
  input: ListInvoicesQuery,
  permission: PERMISSIONS.salesInvoiceRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  examples: [
    { description: 'Unpaid invoices', input: { paymentStatus: 'UNPAID' } },
    { description: 'Invoices mentioning Sharma', input: { q: 'Sharma', limit: 20 } },
  ],
  handler: async ({ db, companyId }, input): Promise<InvoiceListItemDto[]> => {
    let q = selectInvoiceList(db, companyId);
    if (input.status) q = q.where('inv.status', '=', input.status);
    if (input.customerId) q = q.where('inv.customerId', '=', input.customerId);
    if (input.paymentStatus) q = q.where(paymentStatusPredicate(input.paymentStatus));
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
      q = q.where((eb) =>
        eb.or([eb('inv.invoiceNumber', 'ilike', like), eb('p.name', 'ilike', like)]),
      );
    }
    const rows = await q
      .orderBy('inv.invoiceDate', 'desc')
      .orderBy('inv.createdAt', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map(toInvoiceListItem);
  },
});

export const getInvoice = defineQuery({
  name: 'sales.invoices.get',
  description: 'Get a sales invoice with lines and computed GST.',
  input: z.object({ invoiceId: Uuid }),
  permission: PERMISSIONS.salesInvoiceRead,
  ai: { tier: 'READ' },
  dataClass: 'CONFIDENTIAL',
  handler: async ({ db, companyId }, input): Promise<InvoiceDto> =>
    loadInvoiceDto(db, companyId, input.invoiceId),
});
