import type {
  BankAccountDto,
  CreditNoteDto,
  InvoiceDto,
  PurchaseInvoiceDto,
  PurchaseOrderDto,
  ReceiptDto,
  SupplierPaymentDto,
} from '@factory-erp/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAiAgent, createFixture, TEST_PASSWORD, type Fixture } from '../test/fixtures';
import { salesFlows } from '../test/sales-flows';
import { createTestEnv, type TestEnv } from '../test/test-db';
import type { AuthenticatedActor } from './platform/actor';
import { AppError, ForbiddenError, NotFoundError } from './platform/errors';
import type { PdfRenderer } from './platform/pdf';
import { buildRegistry } from './registry';

/**
 * Multi-company isolation harness (Slice 0). Two companies live in one database. For EVERY
 * registered command and query, company B's owner (who holds every permission) tries to read
 * or change company A's data using A's real identifiers. Nothing may succeed, nothing of A may
 * leak into a response or an error, and afterwards A's rows must be byte-for-byte unchanged.
 *
 * A new command or query without a case here fails the suite: isolation is decided when a
 * definition is added, not discovered later. The same attempts also run through the AI actor,
 * so future AI tools — generated from the same registry — inherit the coverage.
 */
const TODAY = '2026-10-05';
const renderer: PdfRenderer = {
  render: (html) => Promise.resolve(Buffer.from(`%PDF-1.4 isolation ${html.length}`)),
  close: () => Promise.resolve(),
};

let env: TestEnv;
let A: Fixture;
let B: Fixture;
/** Company A's records, created through the normal command bus. */
let a: {
  draft: InvoiceDto;
  unpaid: InvoiceDto;
  credited: InvoiceDto;
  cnDraft: CreditNoteDto;
  cnIssued: CreditNoteDto;
  openReceipt: ReceiptDto;
  documentId: string;
  outboxEventId: string;
  warehouseId: string;
  draftPo: PurchaseOrderDto;
  approvedPo: PurchaseOrderDto;
  receivingPo: PurchaseOrderDto;
  grnId: string;
  draftBill: PurchaseInvoiceDto;
  postedBill: PurchaseInvoiceDto;
  pendingPayment: SupplierPaymentDto;
  approvedPayment: SupplierPaymentDto;
  pendingBank: BankAccountDto;
};
let bReceipt: ReceiptDto;
let bPayment: SupplierPaymentDto;
let aIds: Set<string>;
let aFingerprint: string;

const flowsA = salesFlows(
  () => env,
  () => A,
  TODAY,
);
const flowsB = salesFlows(
  () => env,
  () => B,
  TODAY,
);

/** Every primary key that belongs to company A. */
async function idsOfCompany(companyId: string): Promise<Set<string>> {
  const { rows } = await sql<{ id: string }>`
    select id::text from party.parties where company_id = ${companyId}
    union all select id::text from catalog.items where company_id = ${companyId}
    union all select id::text from sales.invoices where company_id = ${companyId}
    union all select id::text from sales.credit_notes where company_id = ${companyId}
    union all select id::text from finance.receipts where company_id = ${companyId}
    union all select id::text from finance.receipt_allocations where company_id = ${companyId}
    union all select id::text from finance.party_ledger_entries where company_id = ${companyId}
    union all select id::text from docs.documents where company_id = ${companyId}
    union all select user_id::text from identity.user_roles where company_id = ${companyId}
    union all select id::text from audit.events where company_id = ${companyId}
    union all select id::text from inventory.warehouses where company_id = ${companyId}
    union all select id::text from inventory.stock_movements where company_id = ${companyId}
    union all select id::text from purchase.orders where company_id = ${companyId}
    union all select id::text from purchase.goods_receipts where company_id = ${companyId}
    union all select id::text from purchase.invoices where company_id = ${companyId}
    union all select id::text from finance.payable_ledger_entries where company_id = ${companyId}
    union all select id::text from finance.supplier_payments where company_id = ${companyId}
    union all select id::text from finance.supplier_payment_allocations where company_id = ${companyId}
    union all select id::text from party.bank_accounts where company_id = ${companyId}`.execute(
    env.ownerDb,
  );
  return new Set(rows.map((r) => r.id));
}

/** A digest of every row company A owns (and of the lines under its documents). */
async function fingerprint(companyId: string): Promise<string> {
  const { rows } = await sql<{ digest: string }>`
    select md5(string_agg(x, '|' order by x)) as digest from (
      select 'party' || t::text as x from party.parties t where company_id = ${companyId}
      union all select 'item' || t::text from catalog.items t where company_id = ${companyId}
      union all select 'inv' || t::text from sales.invoices t where company_id = ${companyId}
      union all select 'line' || l::text from sales.invoice_lines l join sales.invoices i on i.id = l.invoice_id where i.company_id = ${companyId}
      union all select 'cn' || t::text from sales.credit_notes t where company_id = ${companyId}
      union all select 'cnl' || l::text from sales.credit_note_lines l join sales.credit_notes c on c.id = l.credit_note_id where c.company_id = ${companyId}
      union all select 'rcpt' || t::text from finance.receipts t where company_id = ${companyId}
      union all select 'alloc' || t::text from finance.receipt_allocations t where company_id = ${companyId}
      union all select 'ledger' || t::text from finance.party_ledger_entries t where company_id = ${companyId}
      union all select 'doc' || t::text from docs.documents t where company_id = ${companyId}
      union all select 'series' || t::text from system.number_series t where company_id = ${companyId}
      union all select 'outbox' || t::text from system.outbox_events t where company_id = ${companyId}
      union all select 'wh' || t::text from inventory.warehouses t where company_id = ${companyId}
      union all select 'stock' || t::text from inventory.stock_movements t where company_id = ${companyId}
      union all select 'po' || t::text from purchase.orders t where company_id = ${companyId}
      union all select 'grn' || t::text from purchase.goods_receipts t where company_id = ${companyId}
      union all select 'grnl' || l::text from purchase.goods_receipt_lines l join purchase.goods_receipts g on g.id = l.grn_id where g.company_id = ${companyId}
      union all select 'pol' || l::text from purchase.order_lines l join purchase.orders o on o.id = l.order_id where o.company_id = ${companyId}
      union all select 'pi' || t::text from purchase.invoices t where company_id = ${companyId}
      union all select 'pil' || l::text from purchase.invoice_lines l join purchase.invoices i on i.id = l.invoice_id where i.company_id = ${companyId}
      union all select 'payable' || t::text from finance.payable_ledger_entries t where company_id = ${companyId}
      union all select 'spay' || t::text from finance.supplier_payments t where company_id = ${companyId}
      union all select 'spalloc' || t::text from finance.supplier_payment_allocations t where company_id = ${companyId}
      union all select 'bank' || t::text from party.bank_accounts t where company_id = ${companyId}
      union all select 'aipolicy' || t::text from ai.policy_versions t where company_id = ${companyId}
      union all select 'audit' || t.id::text from audit.events t where company_id = ${companyId}
    ) rows`.execute(env.ownerDb);
  return rows[0]?.digest ?? '';
}

beforeAll(async () => {
  env = await createTestEnv({ clock: `${TODAY}T09:30:00Z`, pdfRenderer: renderer });
  A = await createFixture(env.services, { tag: 'alpha' });
  B = await createFixture(env.services, { tag: 'bravo' });

  const f = flowsA;
  const acct = A.actors.accountant;
  const cmd = env.services.commands;
  const issuedForCredit = await f.issued('8474.58');
  await f.receipt('1000.00', [{ invoiceId: issuedForCredit.id, amount: '1000.00' }]);
  const cnIssued = await f.credit(issuedForCredit, [
    { invoiceLineNo: 1, quantity: '1', unitRate: '100' },
  ]);
  const cnDraft = await f.draftCredit(issuedForCredit, [
    { invoiceLineNo: 1, quantity: '1', unitRate: '50' },
  ]);
  const unpaid = await f.issued('500');
  const { createInvoiceDraft } = await import('./modules/sales');
  const draft = await cmd.execute(
    createInvoiceDraft,
    {
      customerId: A.customers.intra.id,
      invoiceDate: TODAY,
      lines: [{ itemId: A.items.widget.id, quantity: '2', unitRate: '10' }],
    },
    acct,
  );
  const openReceipt = await f.receipt('250.00');
  await env.services.outbox.runOnce(50);
  const credited = await f.invoice(issuedForCredit.id);
  const { adjustStock } = await import('./modules/inventory');
  const purchasing = await import('./modules/purchasing');
  const poBody = () => ({
    supplierId: A.suppliers.local.id,
    warehouseId: A.warehouse.id,
    poDate: TODAY,
    lines: [{ itemId: A.items.rawMaterial.id, quantity: '10', unitRate: '50' }],
  });
  const draftPo = await cmd.execute(purchasing.createPurchaseOrderDraft, poBody(), A.actors.owner);
  const toApprove = await cmd.execute(
    purchasing.createPurchaseOrderDraft,
    poBody(),
    A.actors.owner,
  );
  const approvedPo = await cmd.execute(
    purchasing.approvePurchaseOrder,
    { orderId: toApprove.id, expectedVersion: toApprove.version },
    A.actors.owner,
  );
  const toReceive = await cmd.execute(
    purchasing.createPurchaseOrderDraft,
    poBody(),
    A.actors.owner,
  );
  await cmd.execute(
    purchasing.approvePurchaseOrder,
    { orderId: toReceive.id, expectedVersion: toReceive.version },
    A.actors.owner,
  );
  const grn = await cmd.execute(
    purchasing.recordGoodsReceipt,
    {
      orderId: toReceive.id,
      receiptDate: TODAY,
      lines: [{ orderLineNo: 1, acceptedQuantity: '4' }],
    },
    A.actors.owner,
  );
  const billBody = (orderId: string | null, supplierInvoiceNumber: string) => ({
    supplierId: A.suppliers.local.id,
    orderId,
    supplierInvoiceNumber,
    invoiceDate: TODAY,
    supplierStatedTotal: '236.00',
    lines: [
      {
        itemId: A.items.rawMaterial.id,
        orderLineNo: orderId ? 1 : null,
        quantity: '4',
        unitRate: '50',
      },
    ],
  });
  const draftBill = await cmd.execute(
    purchasing.createPurchaseInvoiceDraft,
    billBody(toReceive.id, 'ALPHA-BILL-1'),
    A.actors.owner,
  );
  const toPost = await cmd.execute(
    purchasing.createPurchaseInvoiceDraft,
    billBody(null, 'ALPHA-BILL-2'),
    A.actors.owner,
  );
  const postedBill = await cmd.execute(
    purchasing.postPurchaseInvoice,
    { invoiceId: toPost.id, expectedVersion: toPost.version },
    A.actors.owner,
  );
  const payables = await import('./modules/payables');
  const paymentBody = (supplierId: string) => ({
    supplierId,
    paymentDate: TODAY,
    amount: '50.00',
    paymentMode: 'BANK_TRANSFER' as const,
  });
  const pendingPayment = await cmd.execute(
    payables.requestSupplierPayment,
    paymentBody(A.suppliers.local.id),
    A.actors.accountant,
  );
  const toApprovePayment = await cmd.execute(
    payables.requestSupplierPayment,
    paymentBody(A.suppliers.local.id),
    A.actors.accountant,
  );
  const approvedPayment = await cmd.execute(
    payables.approveSupplierPayment,
    { paymentId: toApprovePayment.id, expectedVersion: toApprovePayment.version },
    A.actors.owner,
  );
  const { setAiPolicy } = await import('./modules/copilot');
  await cmd.execute(
    setAiPolicy,
    {
      expectedVersion: 0,
      aiEnabled: true,
      tasks: {
        'copilot.answer': {
          maxDataClass: 'CONFIDENTIAL',
          approvedModels: [{ modelId: 'ollama:alpha-model', p95LatencyMs: 1000 }],
          fallback: false,
        },
      },
      reason: 'alpha policy',
    },
    A.actors.owner,
  );
  const { proposeBankAccount } = await import('./modules/parties');
  const pendingBank = await cmd.execute(
    proposeBankAccount,
    {
      partyId: A.suppliers.local.id,
      accountHolderName: 'Alpha supplier',
      accountNumber: '123456789012',
      ifsc: 'HDFC0001234',
      changeReason: 'isolation setup',
    },
    A.actors.accountant,
  );
  const warehouse = A.warehouse;
  await cmd.execute(
    adjustStock,
    {
      warehouseId: warehouse.id,
      adjustmentDate: TODAY,
      reason: 'opening count alpha',
      lines: [{ itemId: A.items.rawMaterial.id, quantity: '100' }],
    },
    A.actors.owner,
  );
  a = {
    draft,
    unpaid: await f.invoice(unpaid.id),
    credited,
    cnDraft,
    cnIssued,
    openReceipt,
    documentId: credited.pdfDocumentId ?? '',
    warehouseId: warehouse.id,
    draftPo,
    approvedPo,
    receivingPo: toReceive,
    grnId: grn.id,
    draftBill,
    postedBill,
    pendingPayment,
    approvedPayment,
    pendingBank,
    // A failed background job of A's, the kind an administrator would retry.
    outboxEventId: (
      await env.ownerDb
        .insertInto('system.outboxEvents')
        .values({
          id: crypto.randomUUID(),
          companyId: A.companyId,
          topic: 'test.failed',
          aggregateType: 'sales.invoice',
          aggregateId: credited.id,
          payload: '{}',
          status: 'FAILED',
          attempts: 8,
          failedAt: new Date(),
          lastError: 'renderer unavailable',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id,
  };
  expect(a.documentId).not.toBe('');

  // Company B has its own ordinary business, so "B sees only B" is a real test.
  await flowsB.issued('1694.92');
  bReceipt = await flowsB.receipt('300.00');
  const bRequested = await env.services.commands.execute(
    payables.requestSupplierPayment,
    paymentBody(B.suppliers.local.id),
    B.actors.accountant,
  );
  bPayment = await env.services.commands.execute(
    payables.approveSupplierPayment,
    { paymentId: bRequested.id, expectedVersion: bRequested.version },
    B.actors.owner,
  );

  aIds = await idsOfCompany(A.companyId);
  aFingerprint = await fingerprint(A.companyId);
});

afterAll(async () => env.destroy());

type Expect = 'not-found' | 'rejected' | 'no-leak' | 'allowed';
interface Case {
  expect: Expect;
  input: () => unknown;
}

const line = () => ({ itemId: B.items.widget.id, quantity: '1', unitRate: '10' });
const creditBody = () => ({
  creditNoteDate: TODAY,
  reasonCode: 'POST_SALE_DISCOUNT' as const,
  reason: 'isolation attempt',
  lines: [{ invoiceLineNo: 1, quantity: '1', unitRate: '1' }],
});

/** For every registered command: how company B tries to touch company A. */
const COMMAND_CASES: Record<string, Case[]> = {
  'parties.create': [
    {
      expect: 'allowed', // codes are per company: B may reuse A's party code
      input: () => ({
        code: 'C-SHARED',
        name: 'Shared code bravo',
        isCustomer: true,
        isSupplier: false,
        stateCode: '27',
      }),
    },
  ],
  'items.create': [
    {
      expect: 'allowed',
      input: () => ({
        code: 'SHARED-1',
        name: 'Shared item bravo',
        itemType: 'FINISHED_GOOD',
        uom: 'NOS',
        hsnCode: '7326',
      }),
    },
  ],
  'parties.update': [
    {
      expect: 'rejected',
      input: () => ({
        partyId: A.customers.intra.id,
        expectedVersion: A.customers.intra.version,
        name: 'Renamed by bravo',
        isCustomer: true,
        isSupplier: false,
        stateCode: '27',
      }),
    },
  ],
  'parties.archive': [
    {
      expect: 'rejected',
      input: () => ({ partyId: A.customers.inter.id, expectedVersion: A.customers.inter.version }),
    },
  ],
  'parties.reactivate': [
    {
      expect: 'rejected',
      input: () => ({ partyId: A.customers.inter.id, expectedVersion: A.customers.inter.version }),
    },
  ],
  'items.update': [
    {
      expect: 'rejected',
      input: () => ({
        itemId: A.items.widget.id,
        expectedVersion: A.items.widget.version,
        name: 'Renamed by bravo',
        itemType: 'FINISHED_GOOD',
        uom: 'NOS',
        hsnCode: '7326',
      }),
    },
  ],
  'items.archive': [
    {
      expect: 'rejected',
      input: () => ({
        itemId: A.items.rawMaterial.id,
        expectedVersion: A.items.rawMaterial.version,
      }),
    },
  ],
  'items.reactivate': [
    {
      expect: 'rejected',
      input: () => ({
        itemId: A.items.rawMaterial.id,
        expectedVersion: A.items.rawMaterial.version,
      }),
    },
  ],
  'identity.user.create': [
    {
      expect: 'allowed', // usernames are one namespace per database (one tenant)
      input: () => ({
        username: 'new-bravo',
        displayName: 'New bravo',
        roles: ['WORKER'],
        initialPassword: 'a long first password',
      }),
    },
  ],
  'identity.user.setRoles': [
    {
      expect: 'rejected',
      input: () => ({ userId: A.actors.worker.user.id, expectedVersion: 1, roles: ['OWNER'] }),
    },
  ],
  'identity.user.deactivate': [
    { expect: 'rejected', input: () => ({ userId: A.actors.owner.user.id, expectedVersion: 1 }) },
  ],
  'identity.user.reactivate': [
    { expect: 'rejected', input: () => ({ userId: A.actors.worker.user.id, expectedVersion: 1 }) },
  ],
  'identity.user.resetPassword': [
    {
      expect: 'rejected',
      input: () => ({
        userId: A.actors.owner.user.id,
        expectedVersion: 1,
        temporaryPassword: 'taken over by bravo',
      }),
    },
  ],
  'identity.password.change': [
    {
      expect: 'allowed', // only ever your own account; there is no other user to name
      input: () => ({ currentPassword: TEST_PASSWORD, newPassword: 'a brand new passphrase' }),
    },
  ],
  'operations.outbox.retry': [{ expect: 'rejected', input: () => ({ eventId: a.outboxEventId }) }],
  'inventory.warehouse.create': [
    { expect: 'allowed', input: () => ({ code: 'MAIN', name: 'Main bravo' }) }, // codes are per company
  ],
  'inventory.stock.adjust': [
    {
      expect: 'rejected',
      input: () => ({
        warehouseId: a.warehouseId,
        adjustmentDate: TODAY,
        reason: 'isolation attempt',
        lines: [{ itemId: A.items.rawMaterial.id, quantity: '-10' }],
      }),
    },
    {
      expect: 'rejected',
      input: () => ({
        warehouseId: a.warehouseId,
        adjustmentDate: TODAY,
        reason: 'isolation attempt',
        lines: [{ itemId: B.items.rawMaterial.id, quantity: '10' }],
      }),
    },
  ],
  'purchase.order.createDraft': [
    {
      expect: 'rejected',
      input: () => ({
        supplierId: A.suppliers.local.id,
        warehouseId: B.warehouse.id,
        poDate: TODAY,
        lines: [{ itemId: B.items.rawMaterial.id, quantity: '1', unitRate: '1' }],
      }),
    },
    {
      expect: 'rejected',
      input: () => ({
        supplierId: B.suppliers.local.id,
        warehouseId: a.warehouseId,
        poDate: TODAY,
        lines: [{ itemId: B.items.rawMaterial.id, quantity: '1', unitRate: '1' }],
      }),
    },
    {
      expect: 'rejected',
      input: () => ({
        supplierId: B.suppliers.local.id,
        warehouseId: B.warehouse.id,
        poDate: TODAY,
        lines: [{ itemId: A.items.rawMaterial.id, quantity: '1', unitRate: '1' }],
      }),
    },
  ],
  'purchase.order.updateDraft': [
    {
      expect: 'rejected',
      input: () => ({
        orderId: a.draftPo.id,
        expectedVersion: a.draftPo.version,
        supplierId: B.suppliers.local.id,
        warehouseId: B.warehouse.id,
        poDate: TODAY,
        lines: [{ itemId: B.items.rawMaterial.id, quantity: '1', unitRate: '1' }],
      }),
    },
  ],
  'purchase.order.deleteDraft': [
    {
      expect: 'rejected',
      input: () => ({ orderId: a.draftPo.id, expectedVersion: a.draftPo.version }),
    },
  ],
  'purchase.order.approve': [
    {
      expect: 'rejected',
      input: () => ({ orderId: a.draftPo.id, expectedVersion: a.draftPo.version }),
    },
  ],
  'purchase.order.cancel': [
    {
      expect: 'rejected',
      input: () => ({
        orderId: a.approvedPo.id,
        expectedVersion: a.approvedPo.version,
        reason: 'isolation attempt',
      }),
    },
  ],
  'purchase.order.close': [
    {
      expect: 'rejected',
      input: () => ({
        orderId: a.approvedPo.id,
        expectedVersion: a.approvedPo.version,
        reason: 'isolation attempt',
      }),
    },
  ],
  'purchase.grn.record': [
    {
      expect: 'rejected',
      input: () => ({
        orderId: a.receivingPo.id,
        receiptDate: TODAY,
        lines: [{ orderLineNo: 1, acceptedQuantity: '1' }],
      }),
    },
  ],
  'purchase.invoice.createDraft': [
    {
      expect: 'rejected',
      input: () => ({
        supplierId: A.suppliers.local.id,
        orderId: null,
        supplierInvoiceNumber: 'BRAVO-1',
        invoiceDate: TODAY,
        supplierStatedTotal: '59.00',
        lines: [{ itemId: B.items.rawMaterial.id, quantity: '1', unitRate: '50' }],
      }),
    },
    {
      expect: 'rejected',
      input: () => ({
        supplierId: B.suppliers.local.id,
        orderId: a.receivingPo.id,
        supplierInvoiceNumber: 'BRAVO-2',
        invoiceDate: TODAY,
        supplierStatedTotal: '59.00',
        lines: [{ itemId: B.items.rawMaterial.id, orderLineNo: 1, quantity: '1', unitRate: '50' }],
      }),
    },
    {
      expect: 'rejected',
      input: () => ({
        supplierId: B.suppliers.local.id,
        orderId: null,
        supplierInvoiceNumber: 'BRAVO-3',
        invoiceDate: TODAY,
        supplierStatedTotal: '59.00',
        lines: [{ itemId: A.items.rawMaterial.id, quantity: '1', unitRate: '50' }],
      }),
    },
  ],
  'purchase.invoice.updateDraft': [
    {
      expect: 'rejected',
      input: () => ({
        invoiceId: a.draftBill.id,
        expectedVersion: a.draftBill.version,
        supplierId: B.suppliers.local.id,
        orderId: null,
        supplierInvoiceNumber: 'BRAVO-4',
        invoiceDate: TODAY,
        supplierStatedTotal: '59.00',
        lines: [{ itemId: B.items.rawMaterial.id, quantity: '1', unitRate: '50' }],
      }),
    },
  ],
  'purchase.invoice.deleteDraft': [
    {
      expect: 'rejected',
      input: () => ({ invoiceId: a.draftBill.id, expectedVersion: a.draftBill.version }),
    },
  ],
  'purchase.invoice.post': [
    {
      expect: 'rejected',
      input: () => ({ invoiceId: a.draftBill.id, expectedVersion: a.draftBill.version }),
    },
  ],
  'ai.policy.set': [
    {
      // The company always comes from the session: B's owner can only ever version B's policy
      // (A's rows are covered by the fingerprint check).
      expect: 'allowed',
      input: () => ({
        expectedVersion: 0,
        aiEnabled: true,
        tasks: {},
        reason: 'bravo policy',
      }),
    },
  ],
  'parties.bankAccount.propose': [
    {
      expect: 'rejected',
      input: () => ({
        partyId: A.suppliers.local.id,
        accountHolderName: 'Bravo fraud',
        accountNumber: '999999999999',
        ifsc: 'ICIC0000001',
        changeReason: 'isolation attempt',
      }),
    },
  ],
  'parties.bankAccount.approve': [
    {
      expect: 'rejected',
      input: () => ({ bankAccountId: a.pendingBank.id, expectedVersion: a.pendingBank.version }),
    },
  ],
  'parties.bankAccount.reject': [
    {
      expect: 'rejected',
      input: () => ({
        bankAccountId: a.pendingBank.id,
        expectedVersion: a.pendingBank.version,
        reason: 'isolation attempt',
      }),
    },
  ],
  'finance.supplierPayment.request': [
    {
      expect: 'rejected',
      input: () => ({
        supplierId: A.suppliers.local.id,
        paymentDate: TODAY,
        amount: '10.00',
        paymentMode: 'CASH',
      }),
    },
    {
      expect: 'rejected',
      input: () => ({
        supplierId: B.suppliers.local.id,
        paymentDate: TODAY,
        amount: '10.00',
        paymentMode: 'CASH',
        allocations: [{ purchaseInvoiceId: a.postedBill.id, amount: '10.00' }],
      }),
    },
  ],
  'finance.supplierPayment.approve': [
    {
      expect: 'rejected',
      input: () => ({ paymentId: a.pendingPayment.id, expectedVersion: a.pendingPayment.version }),
    },
  ],
  'finance.supplierPayment.reject': [
    {
      expect: 'rejected',
      input: () => ({
        paymentId: a.pendingPayment.id,
        expectedVersion: a.pendingPayment.version,
        reason: 'isolation attempt',
      }),
    },
  ],
  'finance.supplierPayment.allocate': [
    {
      expect: 'rejected',
      input: () => ({
        paymentId: a.approvedPayment.id,
        allocations: [{ purchaseInvoiceId: a.postedBill.id, amount: '10.00' }],
      }),
    },
    {
      expect: 'rejected',
      input: () => ({
        paymentId: bPayment.id,
        allocations: [{ purchaseInvoiceId: a.postedBill.id, amount: '10.00' }],
      }),
    },
  ],
  'sales.invoice.createDraft': [
    {
      expect: 'rejected',
      input: () => ({ customerId: A.customers.intra.id, invoiceDate: TODAY, lines: [line()] }),
    },
    {
      expect: 'rejected',
      input: () => ({
        customerId: B.customers.intra.id,
        invoiceDate: TODAY,
        lines: [{ itemId: A.items.widget.id, quantity: '1', unitRate: '10' }],
      }),
    },
  ],
  'sales.invoice.updateDraft': [
    {
      expect: 'rejected',
      input: () => ({
        invoiceId: a.draft.id,
        expectedVersion: a.draft.version,
        customerId: B.customers.intra.id,
        invoiceDate: TODAY,
        lines: [line()],
      }),
    },
  ],
  'sales.invoice.deleteDraft': [
    {
      expect: 'rejected',
      input: () => ({ invoiceId: a.draft.id, expectedVersion: a.draft.version }),
    },
  ],
  'sales.invoice.issue': [
    {
      expect: 'rejected',
      input: () => ({ invoiceId: a.draft.id, expectedVersion: a.draft.version }),
    },
  ],
  'sales.invoice.cancel': [
    {
      expect: 'rejected',
      input: () => ({
        invoiceId: a.unpaid.id,
        expectedVersion: a.unpaid.version,
        reason: 'isolation attempt',
      }),
    },
  ],
  'sales.creditNote.createDraft': [
    {
      expect: 'rejected',
      input: () => ({
        ...creditBody(),
        invoiceId: a.credited.id,
        customerId: a.credited.customerId,
      }),
    },
    {
      expect: 'rejected',
      input: () => ({
        ...creditBody(),
        invoiceId: a.credited.id,
        customerId: B.customers.intra.id,
      }),
    },
  ],
  'sales.creditNote.updateDraft': [
    {
      expect: 'rejected',
      input: () => ({
        ...creditBody(),
        creditNoteId: a.cnDraft.id,
        expectedVersion: a.cnDraft.version,
      }),
    },
  ],
  'sales.creditNote.deleteDraft': [
    {
      expect: 'rejected',
      input: () => ({ creditNoteId: a.cnDraft.id, expectedVersion: a.cnDraft.version }),
    },
  ],
  'sales.creditNote.issue': [
    {
      expect: 'rejected',
      input: () => ({ creditNoteId: a.cnDraft.id, expectedVersion: a.cnDraft.version }),
    },
  ],
  'finance.receipt.record': [
    {
      expect: 'rejected',
      input: () => ({
        customerId: A.customers.intra.id,
        receiptDate: TODAY,
        amount: '10.00',
        paymentMode: 'CASH',
      }),
    },
    {
      expect: 'rejected',
      input: () => ({
        customerId: B.customers.intra.id,
        receiptDate: TODAY,
        amount: '10.00',
        paymentMode: 'CASH',
        allocations: [{ invoiceId: a.unpaid.id, amount: '10.00' }],
      }),
    },
  ],
  'finance.receipt.allocate': [
    {
      expect: 'rejected',
      input: () => ({
        receiptId: a.openReceipt.id,
        allocations: [{ invoiceId: a.unpaid.id, amount: '10.00' }],
      }),
    },
    {
      expect: 'rejected',
      input: () => ({
        receiptId: bReceipt.id,
        allocations: [{ invoiceId: a.unpaid.id, amount: '10.00' }],
      }),
    },
  ],
};

/** For every registered query: what company B asks for. */
const QUERY_CASES: Record<string, Case[]> = {
  'company.get': [{ expect: 'no-leak', input: () => ({}) }],
  'reference.states.list': [{ expect: 'no-leak', input: () => ({}) }],
  'catalog.hsn.list': [{ expect: 'no-leak', input: () => ({}) }],
  'catalog.uoms.list': [{ expect: 'no-leak', input: () => ({}) }],
  'parties.list': [{ expect: 'no-leak', input: () => ({}) }],
  'parties.get': [{ expect: 'not-found', input: () => ({ partyId: A.customers.intra.id }) }],
  'items.list': [{ expect: 'no-leak', input: () => ({}) }],
  'items.get': [{ expect: 'not-found', input: () => ({ itemId: A.items.widget.id }) }],
  'sales.invoices.list': [
    { expect: 'no-leak', input: () => ({}) },
    { expect: 'no-leak', input: () => ({ customerId: A.customers.intra.id }) },
  ],
  'sales.invoices.get': [{ expect: 'not-found', input: () => ({ invoiceId: a.credited.id }) }],
  'sales.creditNotes.list': [
    { expect: 'no-leak', input: () => ({}) },
    { expect: 'no-leak', input: () => ({ invoiceId: a.credited.id }) },
  ],
  'sales.creditNotes.get': [
    { expect: 'not-found', input: () => ({ creditNoteId: a.cnIssued.id }) },
  ],
  'finance.receipts.list': [
    { expect: 'no-leak', input: () => ({}) },
    { expect: 'no-leak', input: () => ({ customerId: A.customers.intra.id }) },
  ],
  'finance.receipts.get': [{ expect: 'not-found', input: () => ({ receiptId: a.openReceipt.id }) }],
  'finance.receivables.openInvoices': [
    { expect: 'no-leak', input: () => ({ customerId: A.customers.intra.id }) },
  ],
  'finance.receivables.summary': [{ expect: 'no-leak', input: () => ({}) }],
  'audit.events.list': [
    { expect: 'no-leak', input: () => ({ entityType: 'sales.invoice', entityId: a.credited.id }) },
  ],
  'documents.content.get': [{ expect: 'not-found', input: () => ({ documentId: a.documentId }) }],
  'dashboard.get': [{ expect: 'no-leak', input: () => ({}) }],
  'identity.users.list': [{ expect: 'no-leak', input: () => ({}) }],
  'inventory.warehouses.list': [{ expect: 'no-leak', input: () => ({}) }],
  'purchase.orders.list': [
    { expect: 'no-leak', input: () => ({}) },
    { expect: 'no-leak', input: () => ({ supplierId: A.suppliers.local.id }) },
  ],
  'purchase.grns.list': [
    { expect: 'no-leak', input: () => ({}) },
    { expect: 'no-leak', input: () => ({ orderId: a.receivingPo.id }) },
  ],
  'purchase.grns.get': [{ expect: 'not-found', input: () => ({ grnId: a.grnId }) }],
  'purchase.orders.get': [
    { expect: 'not-found', input: () => ({ orderId: a.approvedPo.id }) },
    { expect: 'not-found', input: () => ({ orderId: a.draftPo.id }) },
  ],
  'purchase.invoices.list': [
    { expect: 'no-leak', input: () => ({}) },
    { expect: 'no-leak', input: () => ({ supplierId: A.suppliers.local.id }) },
    { expect: 'no-leak', input: () => ({ orderId: a.receivingPo.id }) },
  ],
  'purchase.invoices.get': [
    { expect: 'not-found', input: () => ({ invoiceId: a.postedBill.id }) },
    { expect: 'not-found', input: () => ({ invoiceId: a.draftBill.id }) },
  ],
  'purchase.invoices.match': [
    { expect: 'not-found', input: () => ({ invoiceId: a.draftBill.id }) },
  ],
  'ai.policy.get': [{ expect: 'no-leak', input: () => ({}) }],
  'ai.policy.view': [{ expect: 'no-leak', input: () => ({}) }],
  'parties.bankAccounts.list': [
    { expect: 'not-found', input: () => ({ partyId: A.suppliers.local.id }) },
  ],
  'finance.supplierPayments.list': [
    { expect: 'no-leak', input: () => ({}) },
    { expect: 'no-leak', input: () => ({ supplierId: A.suppliers.local.id }) },
  ],
  'finance.supplierPayments.get': [
    { expect: 'not-found', input: () => ({ paymentId: a.pendingPayment.id }) },
    { expect: 'not-found', input: () => ({ paymentId: a.approvedPayment.id }) },
  ],
  'finance.payables.openInvoices': [
    { expect: 'no-leak', input: () => ({}) },
    { expect: 'no-leak', input: () => ({ supplierId: A.suppliers.local.id }) },
  ],
  'finance.payables.summary': [{ expect: 'no-leak', input: () => ({}) }],
  'inventory.stock.list': [
    { expect: 'no-leak', input: () => ({ includeZero: 'true' }) },
    { expect: 'no-leak', input: () => ({ warehouseId: a.warehouseId }) },
  ],
  'inventory.movements.list': [
    { expect: 'no-leak', input: () => ({}) },
    { expect: 'no-leak', input: () => ({ itemId: A.items.rawMaterial.id }) },
  ],
  'operations.outbox.list': [
    { expect: 'no-leak', input: () => ({}) },
    { expect: 'no-leak', input: () => ({ status: 'PENDING' }) },
  ],
};

/** Nothing identifying company A may appear in what B receives. */
function assertNoLeak(label: string, value: unknown) {
  const text =
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? '';
  expect(text.toLowerCase(), `${label} mentions company A`).not.toContain('alpha');
  const leaked = [...text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)]
    .map((m) => m[0])
    .filter((id) => aIds.has(id));
  return leaked;
}

async function attempt(
  kind: 'command' | 'query',
  name: string,
  c: Case,
  actor: AuthenticatedActor,
): Promise<void> {
  const registry = buildRegistry({ blobStore: env.services.blobStore });
  const def =
    kind === 'command'
      ? registry.commands.find((d) => d.name === name)
      : registry.queries.find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  const input = c.input();
  // The attempt must be well-formed; a validation failure would prove nothing.
  expect(def.input.safeParse(input).success, `${name}: input must be valid`).toBe(true);

  const run = () =>
    kind === 'command'
      ? env.services.commands.execute(def as never, input, actor, {
          idempotencyKey: `iso-${crypto.randomUUID()}`,
        })
      : env.services.queries.execute(def as never, input, actor);

  if (c.expect === 'not-found') {
    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, `${name} must not find A's record`).toBeInstanceOf(NotFoundError);
    expect(
      assertNoLeak(`${name} error`, (err as Error).message).filter(
        (id) => !JSON.stringify(input).includes(id),
      ),
    ).toEqual([]);
    return;
  }
  if (c.expect === 'rejected') {
    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, `${name} must be rejected`).toBeInstanceOf(AppError);
    // The input passed schema validation above, so a ValidationError here comes from the
    // domain itself (e.g. "line 1: item not found" for another company's item) — a correct
    // refusal. A ForbiddenError would mean B's owner lacked a permission: the wrong test.
    expect(err, `${name}: rejected for the wrong reason`).not.toBeInstanceOf(ForbiddenError);
    const echoed = JSON.stringify(input);
    const details = JSON.stringify({ message: (err as Error).message, ...(err as object) });
    expect(assertNoLeak(`${name} error`, details).filter((id) => !echoed.includes(id))).toEqual([]);
    return;
  }
  const result = await run();
  const echoed = JSON.stringify(input);
  expect(
    assertNoLeak(`${name} result`, result).filter((id) => !echoed.includes(id)),
    `${name} returned company A's identifiers`,
  ).toEqual([]);
}

describe('multi-company isolation', () => {
  const registry = () => buildRegistry({ blobStore: env.services.blobStore });

  it('has an isolation case for every registered command and query', () => {
    const r = registry();
    expect(r.commands.map((c) => c.name).filter((n) => !(n in COMMAND_CASES))).toEqual([]);
    expect(r.queries.map((q) => q.name).filter((n) => !(n in QUERY_CASES))).toEqual([]);
  });

  for (const [name, cases] of Object.entries(QUERY_CASES)) {
    it(`query ${name}: company B cannot read company A`, async () => {
      for (const c of cases) await attempt('query', name, c, B.actors.owner);
    });
  }

  for (const [name, cases] of Object.entries(COMMAND_CASES)) {
    it(`command ${name}: company B cannot change company A`, async () => {
      for (const c of cases) await attempt('command', name, c, B.actors.owner);
    });
  }

  it('the AI actor of company B is held to the same boundary', async () => {
    const r = registry();
    const ai = asAiAgent(B.actors.owner);
    for (const q of r.queries.filter((d) => d.ai.tier === 'READ')) {
      for (const c of QUERY_CASES[q.name] ?? []) await attempt('query', q.name, c, ai);
    }
    for (const cmd of r.commands.filter((d) => d.ai.tier === 'DRAFT')) {
      for (const c of COMMAND_CASES[cmd.name] ?? []) {
        if (c.expect !== 'allowed') await attempt('command', cmd.name, c, ai);
      }
    }
  });

  it('the AI is held to its tier everywhere: no CONFIRM/FORBIDDEN command or FORBIDDEN query runs for it', async () => {
    // Company A's own owner, acting through the AI copilot, on A's own records: the tier check
    // alone must stop it (a human has to confirm). The fingerprint test below proves no effect.
    const r = registry();
    const ai = asAiAgent(A.actors.owner);
    let refused = 0;
    for (const def of r.commands.filter((d) => d.ai.tier !== 'DRAFT')) {
      for (const c of COMMAND_CASES[def.name] ?? []) {
        const input = c.input();
        expect(def.input.safeParse(input).success, def.name).toBe(true);
        const err = await env.services.commands
          .execute(def, input, ai, { idempotencyKey: `tier-${crypto.randomUUID()}` })
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(err, `${def.name} ran for the AI`).toBeInstanceOf(ForbiddenError);
        expect((err as Error).message).toContain(`AI tier ${def.ai.tier}`);
        refused++;
      }
    }
    for (const def of r.queries.filter((d) => d.ai.tier === 'FORBIDDEN')) {
      for (const c of QUERY_CASES[def.name] ?? []) {
        const err = await env.services.queries.execute(def, c.input(), ai).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, `${def.name} ran for the AI`).toBeInstanceOf(ForbiddenError);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(20);
  });

  it("leaves every one of company A's rows exactly as it was", async () => {
    expect(await fingerprint(A.companyId)).toBe(aFingerprint);
  });

  it('no row anywhere references a record of another company (every foreign key)', async () => {
    // Generic: every single-column foreign key between two company-scoped tables.
    const { rows: fks } = await sql<{ src: string; col: string; dst: string; dstcol: string }>`
      select c.conrelid::regclass::text as src, a.attname as col,
             c.confrelid::regclass::text as dst, af.attname as dstcol
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      join pg_attribute af on af.attrelid = c.confrelid and af.attnum = c.confkey[1]
      where c.contype = 'f' and array_length(c.conkey, 1) = 1
        and exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'company_id' and not x.attisdropped)
        and exists (select 1 from pg_attribute y where y.attrelid = c.confrelid and y.attname = 'company_id' and not y.attisdropped)
        and a.attname <> 'company_id'`.execute(env.ownerDb);
    expect(fks.length).toBeGreaterThan(5);
    for (const fk of fks) {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from ${sql.raw(fk.src)} s join ${sql.raw(fk.dst)} d on d.${sql.ref(fk.dstcol)} = s.${sql.ref(fk.col)}
        where s.company_id <> d.company_id`.execute(env.ownerDb);
      expect(Number(rows[0]?.n), `${fk.src}.${fk.col} → ${fk.dst}`).toBe(0);
    }
    // Document lines carry no company_id; check them through their parent document.
    const lines = await sql<{ n: string }>`
      select count(*) as n from sales.invoice_lines l
      join sales.invoices i on i.id = l.invoice_id join catalog.items it on it.id = l.item_id
      where it.company_id <> i.company_id`.execute(env.ownerDb);
    expect(Number(lines.rows[0]?.n)).toBe(0);
  });
});
