import {
  ListCreditNotesQuery,
  PERMISSIONS,
  Uuid,
  type CreditNoteDto,
  type CreditNoteListItemDto,
} from '@factory-erp/contracts';
import { z } from 'zod';
import { defineQuery } from '../../../platform/queries';
import { loadCreditNoteDto, selectCreditNoteList, toCreditNoteListItem } from './dto';

// Credit notes are sales documents: whoever may read invoices may read their credit notes.
export const listCreditNotes = defineQuery({
  name: 'sales.creditNotes.list',
  description:
    'List credit notes, newest first, filtered by status, customer, invoice, or number/customer search.',
  input: ListCreditNotesQuery,
  permission: PERMISSIONS.salesInvoiceRead,
  ai: { tier: 'READ' },
  handler: async ({ db, companyId }, input): Promise<CreditNoteListItemDto[]> => {
    let q = selectCreditNoteList(db, companyId);
    if (input.status) q = q.where('cn.status', '=', input.status);
    if (input.customerId) q = q.where('cn.customerId', '=', input.customerId);
    if (input.invoiceId) q = q.where('cn.invoiceId', '=', input.invoiceId);
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
      q = q.where((eb) =>
        eb.or([
          eb('cn.creditNoteNumber', 'ilike', like),
          eb('inv.invoiceNumber', 'ilike', like),
          eb('p.name', 'ilike', like),
        ]),
      );
    }
    const rows = await q
      .orderBy('cn.creditNoteDate', 'desc')
      .orderBy('cn.createdAt', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map(toCreditNoteListItem);
  },
});

export const getCreditNote = defineQuery({
  name: 'sales.creditNotes.get',
  description: 'Get a credit note with its lines, computed GST and the invoice it credits.',
  input: z.object({ creditNoteId: Uuid }),
  permission: PERMISSIONS.salesInvoiceRead,
  ai: { tier: 'READ' },
  handler: async ({ db, companyId }, input): Promise<CreditNoteDto> =>
    loadCreditNoteDto(db, companyId, input.creditNoteId),
});
