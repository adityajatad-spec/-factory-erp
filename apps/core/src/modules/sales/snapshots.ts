import { z } from 'zod';
import type { DbExecutor } from '../../db/database';
import { BusinessRuleError, NotFoundError } from '../../platform/errors';

/** Everything about the seller that is printed on an invoice, frozen at issue time. */
export const SellerSnapshot = z.object({
  legalName: z.string(),
  tradeName: z.string().nullable(),
  gstin: z.string().nullable(),
  stateCode: z.string(),
  stateName: z.string(),
  addressLines: z.array(z.string()),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  bankDetails: z
    .object({
      bankName: z.string(),
      accountName: z.string(),
      accountNumber: z.string(),
      ifsc: z.string(),
      branch: z.string().optional(),
    })
    .nullable(),
  invoiceTerms: z.string().nullable(),
  financeReadiness: z.string(),
  isDemo: z.boolean(),
});
export type SellerSnapshot = z.infer<typeof SellerSnapshot>;

export const CustomerSnapshot = z.object({
  partyId: z.string(),
  code: z.string(),
  name: z.string(),
  gstin: z.string().nullable(),
  stateCode: z.string(),
  stateName: z.string(),
  addressLines: z.array(z.string()),
  phone: z.string().nullable(),
  email: z.string().nullable(),
});
export type CustomerSnapshot = z.infer<typeof CustomerSnapshot>;

const lines = (...parts: Array<string | null | undefined>) =>
  parts.filter((p): p is string => !!p && p.trim() !== '');

export async function loadSeller(db: DbExecutor, companyId: string) {
  const c = await db
    .selectFrom('platform.companies as c')
    .innerJoin('platform.states as s', 's.code', 'c.stateCode')
    .selectAll('c')
    .select('s.name as stateName')
    .where('c.id', '=', companyId)
    .executeTakeFirst();
  if (!c) throw new NotFoundError('Company');
  const bank = SellerSnapshot.shape.bankDetails.safeParse(c.bankDetails);
  const snapshot: SellerSnapshot = {
    legalName: c.legalName,
    tradeName: c.tradeName,
    gstin: c.gstin,
    stateCode: c.stateCode,
    stateName: c.stateName,
    addressLines: lines(c.addressLine1, c.addressLine2, `${c.city} ${c.postalCode}`),
    phone: c.phone,
    email: c.email,
    bankDetails: bank.success ? bank.data : null,
    invoiceTerms: c.invoiceTerms,
    financeReadiness: c.financeReadiness,
    isDemo: c.isDemo,
  };
  return { company: c, snapshot };
}

/** Load a customer that may be invoiced: same company, active, flagged as a customer. */
export async function loadInvoiceableCustomer(db: DbExecutor, companyId: string, partyId: string) {
  const p = await db
    .selectFrom('party.parties as p')
    .innerJoin('platform.states as s', 's.code', 'p.stateCode')
    .selectAll('p')
    .select('s.name as stateName')
    .where('p.companyId', '=', companyId)
    .where('p.id', '=', partyId)
    .executeTakeFirst();
  if (!p) throw new NotFoundError('Customer');
  if (p.status !== 'ACTIVE')
    throw new BusinessRuleError('CUSTOMER_ARCHIVED', `${p.name} is archived`);
  if (!p.isCustomer)
    throw new BusinessRuleError('NOT_A_CUSTOMER', `${p.name} is not set up as a customer`);
  const snapshot: CustomerSnapshot = {
    partyId: p.id,
    code: p.code,
    name: p.name,
    gstin: p.gstin,
    stateCode: p.stateCode,
    stateName: p.stateName,
    addressLines: lines(p.addressLine1, p.addressLine2, lines(p.city, p.postalCode).join(' ')),
    phone: p.phone,
    email: p.email,
  };
  return { party: p, snapshot };
}
