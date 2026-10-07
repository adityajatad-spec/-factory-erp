import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../identity/password';
import { formatDocumentNumber } from '../../platform/numbering';
import type { SalesPrintModel } from './pdf/print-model';
import { renderSalesDocumentHtml } from './pdf/template';

describe('formatDocumentNumber', () => {
  it('pads the sequence', () => {
    expect(formatDocumentNumber('INV', '26-27', 42n, 5)).toBe('INV/26-27/00042');
    expect(formatDocumentNumber('INV', '26-27', 123456n, 5)).toBe('INV/26-27/123456');
  });
});

const model = (overrides: Partial<SalesPrintModel> = {}): SalesPrintModel => ({
  kind: 'TAX_INVOICE',
  creditNote: null,
  seller: {
    legalName: 'Seller <Ltd>',
    tradeName: null,
    gstin: '27TESTO0001A1Z1',
    stateCode: '27',
    stateName: 'Maharashtra',
    addressLines: ['Line 1'],
    phone: null,
    email: null,
    bankDetails: null,
    invoiceTerms: null,
    financeReadiness: 'DEVELOPMENT',
    isDemo: true,
  },
  customer: {
    partyId: 'p',
    code: 'C',
    name: '<script>alert("x")</script> & Co',
    gstin: null,
    stateCode: '24',
    stateName: 'Gujarat',
    addressLines: [],
    phone: null,
    email: null,
  },
  documentNumber: 'INV/26-27/00001',
  documentDate: '2026-10-05',
  placeOfSupply: { code: '24', name: 'Gujarat' },
  supplyType: 'INTER_STATE',
  lines: [
    {
      lineNo: 1,
      description: 'Widget',
      hsnCode: '7326',
      quantity: '1234567.500',
      uom: 'NOS',
      unitRate: '10.0000',
      discountPercent: '0',
      taxableAmount: '12345675.00',
      gstRatePercent: '18',
      cgstAmount: '0.00',
      sgstAmount: '0.00',
      igstAmount: '2222221.50',
      lineTotal: '14567896.50',
    },
  ],
  taxSummary: [
    {
      gstRatePercent: '18',
      taxableAmount: '12345675.00',
      cgstAmount: '0.00',
      sgstAmount: '0.00',
      igstAmount: '2222221.50',
    },
  ],
  totals: {
    taxableAmount: '12345675.00',
    cgstAmount: '0.00',
    sgstAmount: '0.00',
    igstAmount: '2222221.50',
    totalTax: '2222221.50',
    roundOff: '0.50',
    grandTotal: '14567897.00',
  },
  amountInWords:
    'Rupees One Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety Seven Only',
  notes: null,
  engineVersion: '1.0.0',
  specimen: true,
  copyLabel: 'Original for Recipient',
  ...overrides,
});

describe('renderInvoiceHtml', () => {
  it('escapes all user-controlled text (no HTML/script injection into PDFs)', () => {
    const html = renderSalesDocumentHtml(model());
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co');
    expect(html).toContain('Seller &lt;Ltd&gt;');
  });

  it('uses Indian digit grouping and shows IGST for inter-state supply', () => {
    const html = renderSalesDocumentHtml(model());
    expect(html).toContain('1,45,67,897.00');
    expect(html).toContain('Inter-state (IGST)');
    expect(html).not.toContain('<th class="n">CGST</th>');
  });

  it('watermarks documents until finance readiness is PRODUCTION', () => {
    expect(renderSalesDocumentHtml(model())).toContain('SPECIMEN');
    expect(renderSalesDocumentHtml(model({ specimen: false }))).not.toContain('SPECIMEN');
  });
});

describe('credit note PDF template', () => {
  const creditNote = (overrides: Partial<SalesPrintModel> = {}) =>
    model({
      kind: 'CREDIT_NOTE',
      documentNumber: 'CN/26-27/00001',
      creditNote: {
        againstInvoiceNumber: 'INV/26-27/00001',
        againstInvoiceDate: '2026-10-01',
        reasonLabel: 'Goods returned',
        reason: '2 units <damaged> in transit',
      },
      seller: {
        ...model().seller,
        bankDetails: {
          bankName: 'Bank',
          accountName: 'A',
          accountNumber: '1',
          ifsc: 'IFSC0000001',
        },
      },
      ...overrides,
    });

  it('is titled as a credit note and references the original invoice and reason (escaped)', () => {
    const html = renderSalesDocumentHtml(creditNote());
    expect(html).toContain('<h2>CREDIT NOTE</h2>');
    expect(html).not.toContain('TAX INVOICE');
    expect(html).toContain('Credit note no: <strong>CN/26-27/00001</strong>');
    expect(html).toContain('Against invoice: <strong>INV/26-27/00001</strong> dated 01-10-2026');
    expect(html).toContain('Goods returned — 2 units &lt;damaged&gt; in transit');
    expect(html).toContain('Computer-generated credit note · Factory ERP');
    expect(html).toContain('Total credit (₹)');
    expect(html).not.toContain('Grand total (₹)');
  });

  it('carries its own SPECIMEN watermark and no payment instructions', () => {
    const html = renderSalesDocumentHtml(creditNote());
    expect(html).toContain('SPECIMEN — NOT A VALID CREDIT NOTE');
    expect(html).not.toContain('Bank details');
    expect(renderSalesDocumentHtml(creditNote({ specimen: false }))).not.toContain('SPECIMEN');
  });
});

describe('password hashing (argon2id)', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('s3cret-pass');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword('s3cret-pass', hash)).toBe(true);
    expect(await verifyPassword('S3cret-pass', hash)).toBe(false);
    expect(await verifyPassword('s3cret-pass', 'not-a-hash')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
});
