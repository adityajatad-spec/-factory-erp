import type {
  CreatePurchaseInvoiceRequest,
  GoodsReceiptDto,
  PurchaseInvoiceDto,
  PurchaseLineInput,
  PurchaseOrderDto,
} from '@factory-erp/contracts';
import type { AuthenticatedActor } from '../src/platform/actor';
import {
  approvePurchaseOrder,
  createPurchaseInvoiceDraft,
  createPurchaseOrderDraft,
  getPurchaseInvoice,
  getPurchaseOrder,
  postPurchaseInvoice,
  recordGoodsReceipt,
} from '../src/modules/purchasing';
import type { Fixture } from './fixtures';
import type { TestEnv } from './test-db';

/**
 * Business-level helpers for purchasing tests. Everything goes through the real command and
 * query buses (validation, RBAC, transactions, audit), exactly like the HTTP API.
 *
 * Handy amounts (steel sheet @ 18 % GST from the local supplier, rounded to the rupee):
 *   100 kg × ₹50 → taxable 5,000.00 + CGST 450.00 + SGST 450.00 = ₹5,900.00
 *    10 kg × ₹50 → ₹590.00
 */
export function purchaseFlows(env: () => TestEnv, fx: () => Fixture, today: string) {
  const cmd = () => env().services.commands;
  const qry = () => env().services.queries;

  const steel = (quantity = '100', unitRate = '50'): PurchaseLineInput => ({
    itemId: fx().items.rawMaterial.id,
    quantity,
    unitRate,
  });

  function draftPo(
    lines: PurchaseLineInput[] = [steel()],
    opts: {
      actor?: AuthenticatedActor;
      supplierId?: string;
      poDate?: string;
      expectedDate?: string;
    } = {},
  ): Promise<PurchaseOrderDto> {
    return cmd().execute(
      createPurchaseOrderDraft,
      {
        supplierId: opts.supplierId ?? fx().suppliers.local.id,
        warehouseId: fx().warehouse.id,
        poDate: opts.poDate ?? today,
        expectedDate: opts.expectedDate ?? today,
        lines,
      },
      opts.actor ?? fx().actors.purchase,
    );
  }

  async function approvedPo(
    lines: PurchaseLineInput[] = [steel()],
    opts: { supplierId?: string; poDate?: string; expectedDate?: string } = {},
  ): Promise<PurchaseOrderDto> {
    const draft = await draftPo(lines, opts);
    return cmd().execute(
      approvePurchaseOrder,
      { orderId: draft.id, expectedVersion: draft.version },
      fx().actors.owner,
    );
  }

  const order = (orderId: string) =>
    qry().execute(getPurchaseOrder, { orderId }, fx().actors.owner);

  /** Receive goods against an order (as the supervisor), everything accepted unless said otherwise. */
  const receive = (
    orderId: string,
    lines: Array<{ orderLineNo: number; acceptedQuantity: string }>,
    opts: { date?: string } = {},
  ): Promise<GoodsReceiptDto> =>
    cmd().execute(
      recordGoodsReceipt,
      { orderId, receiptDate: opts.date ?? today, lines },
      fx().actors.supervisor,
    );

  let billNo = 0;
  /** Enter a supplier bill as a draft (as the accountant). */
  const draftBill = (
    input: Partial<CreatePurchaseInvoiceRequest> &
      Pick<CreatePurchaseInvoiceRequest, 'lines' | 'supplierStatedTotal'>,
    opts: { actor?: AuthenticatedActor; key?: string } = {},
  ): Promise<PurchaseInvoiceDto> =>
    cmd().execute(
      createPurchaseInvoiceDraft,
      {
        supplierId: fx().suppliers.local.id,
        orderId: null,
        supplierInvoiceNumber: `SUP/${++billNo}`,
        invoiceDate: today,
        ...input,
      },
      opts.actor ?? fx().actors.accountant,
      opts.key ? { idempotencyKey: opts.key } : {},
    );

  const postBill = (
    bill: PurchaseInvoiceDto,
    opts: { actor?: AuthenticatedActor; reason?: string; key?: string } = {},
  ): Promise<PurchaseInvoiceDto> =>
    cmd().execute(
      postPurchaseInvoice,
      { invoiceId: bill.id, expectedVersion: bill.version, matchOverrideReason: opts.reason },
      opts.actor ?? fx().actors.accountant,
      opts.key ? { idempotencyKey: opts.key } : {},
    );

  /** Order → approve → receive everything → bill exactly that → post: a bill that is owed. */
  async function postedBillFor(
    lines: PurchaseLineInput[] = [steel()],
    opts: { supplierId?: string } = {},
  ): Promise<PurchaseInvoiceDto> {
    const po = await approvedPo(lines, opts);
    await receive(
      po.id,
      po.lines.map((l) => ({ orderLineNo: l.lineNo, acceptedQuantity: l.quantity })),
    );
    const draft = await draftBill({
      supplierId: po.supplierId,
      orderId: po.id,
      supplierStatedTotal: po.grandTotal,
      lines: po.lines.map((l) => ({
        itemId: l.itemId,
        orderLineNo: l.lineNo,
        quantity: l.quantity,
        unitRate: l.unitRate,
        discountPercent: l.discountPercent,
      })),
    });
    return postBill(draft);
  }

  const bill = (invoiceId: string) =>
    qry().execute(getPurchaseInvoice, { invoiceId }, fx().actors.owner);

  return {
    steel,
    draftPo,
    approvedPo,
    order,
    receive,
    draftBill,
    postBill,
    postedBillFor,
    bill,
  };
}
