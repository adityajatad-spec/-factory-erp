import { formatIndianNumber, Percent } from '@factory-erp/money';
import type { SalesPrintModel } from './print-model';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const amt = (s: string) => formatIndianNumber(s, 2);
const qty = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const rate = (s: string) => formatIndianNumber(s, 2);

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d ?? ''}-${m ?? ''}-${y ?? ''}`;
}

const STYLES = `
  @page { size: A4; margin: 12mm 10mm 14mm 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, "Noto Sans", sans-serif; font-size: 9pt; color: #111; margin: 0; }
  .watermark { position: fixed; top: 38%; left: -5%; width: 110%; text-align: center; transform: rotate(-28deg);
    font-size: 30pt; font-weight: 700; color: rgba(200, 30, 30, 0.12); letter-spacing: 2px; white-space: nowrap; z-index: 0; }
  .doc { position: relative; z-index: 1; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 6px; }
  .seller h1 { font-size: 15pt; margin: 0 0 2px; }
  .muted { color: #555; }
  .title { text-align: right; }
  .title h2 { margin: 0; font-size: 14pt; letter-spacing: 1px; }
  .badge { display: inline-block; border: 1px solid #b91c1c; color: #b91c1c; font-size: 7pt; padding: 1px 4px; margin-top: 3px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0; }
  .box { border: 1px solid #999; padding: 6px; }
  .box h3 { margin: 0 0 3px; font-size: 7.5pt; text-transform: uppercase; color: #555; letter-spacing: .5px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 3px 4px; vertical-align: top; }
  th { background: #f0f0f0; font-size: 7.5pt; text-transform: uppercase; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  .totals { display: grid; grid-template-columns: 1.4fr 1fr; gap: 8px; margin-top: 8px; }
  .totals table td { border: none; padding: 2px 4px; }
  .totals .grand td { border-top: 2px solid #111; font-weight: 700; font-size: 11pt; }
  .words { font-weight: 600; margin-top: 4px; }
  .footer { display: flex; justify-content: space-between; margin-top: 14px; }
  .sign { text-align: right; min-width: 45%; }
  .sign .line { margin-top: 36px; border-top: 1px solid #111; padding-top: 2px; }
  .fine { font-size: 7pt; color: #666; margin-top: 10px; border-top: 1px dashed #bbb; padding-top: 4px; }
`;

const LABELS = {
  TAX_INVOICE: {
    title: 'TAX INVOICE',
    box: 'Invoice',
    number: 'Invoice no',
    date: 'Invoice date',
    party: 'Billed to',
    footer: 'Computer-generated invoice',
    specimen: 'SPECIMEN — NOT A VALID TAX INVOICE',
    total: 'Grand total (₹)',
  },
  CREDIT_NOTE: {
    title: 'CREDIT NOTE',
    box: 'Credit note',
    number: 'Credit note no',
    date: 'Credit note date',
    party: 'Customer',
    footer: 'Computer-generated credit note',
    specimen: 'SPECIMEN — NOT A VALID CREDIT NOTE',
    total: 'Total credit (₹)',
  },
} as const;

/**
 * Pure function: print model → self-contained HTML (no scripts, no external resources).
 * One template for tax invoices and credit notes, so both share the same tested layout.
 */
export function renderSalesDocumentHtml(m: SalesPrintModel): string {
  const intra = m.supplyType === 'INTRA_STATE';
  const s = m.seller;
  const c = m.customer;
  const t = LABELS[m.kind];
  const cn = m.creditNote;

  const taxHead = intra
    ? '<th class="n">CGST</th><th class="n">SGST</th>'
    : '<th class="n">IGST</th>';
  const lineRows = m.lines
    .map((l) => {
      const half = Percent.of(l.gstRatePercent).half().toString();
      const taxCells = intra
        ? `<td class="n">${amt(l.cgstAmount)}<br><span class="muted">${esc(half)}%</span></td><td class="n">${amt(l.sgstAmount)}<br><span class="muted">${esc(half)}%</span></td>`
        : `<td class="n">${amt(l.igstAmount)}<br><span class="muted">${esc(l.gstRatePercent)}%</span></td>`;
      return `<tr>
        <td class="n">${l.lineNo}</td>
        <td>${esc(l.description)}</td>
        <td>${esc(l.hsnCode)}</td>
        <td class="n">${esc(qty(l.quantity))} ${esc(l.uom)}</td>
        <td class="n">${rate(l.unitRate)}</td>
        <td class="n">${l.discountPercent === '0' ? '—' : `${esc(l.discountPercent)}%`}</td>
        <td class="n">${amt(l.taxableAmount)}</td>
        ${taxCells}
        <td class="n">${amt(l.lineTotal)}</td>
      </tr>`;
    })
    .join('');

  const summaryRows = m.taxSummary
    .map(
      (t) =>
        `<tr><td>${esc(t.gstRatePercent)}%</td><td class="n">${amt(t.taxableAmount)}</td>${
          intra
            ? `<td class="n">${amt(t.cgstAmount)}</td><td class="n">${amt(t.sgstAmount)}</td>`
            : `<td class="n">${amt(t.igstAmount)}</td>`
        }</tr>`,
    )
    .join('');

  // Payment instructions and sale terms belong on invoices, not on credit notes.
  const bank =
    m.kind === 'TAX_INVOICE' && s.bankDetails
      ? `<div class="box"><h3>Bank details</h3>${esc(s.bankDetails.bankName)}<br>A/c name: ${esc(s.bankDetails.accountName)}<br>A/c no: ${esc(
          s.bankDetails.accountNumber,
        )}<br>IFSC: ${esc(s.bankDetails.ifsc)}${s.bankDetails.branch ? `<br>Branch: ${esc(s.bankDetails.branch)}` : ''}</div>`
      : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(m.documentNumber)}</title><style>${STYLES}</style></head>
<body>
${m.specimen ? `<div class="watermark">${t.specimen}</div>` : ''}
<div class="doc">
  <div class="top">
    <div class="seller">
      <h1>${esc(s.legalName)}</h1>
      ${s.tradeName ? `<div>${esc(s.tradeName)}</div>` : ''}
      <div class="muted">${s.addressLines.map(esc).join('<br>')}</div>
      <div>${s.gstin ? `GSTIN: <strong>${esc(s.gstin)}</strong> · ` : ''}State: ${esc(s.stateName)} (${esc(s.stateCode)})</div>
      ${
        s.phone || s.email
          ? `<div class="muted">${[s.phone, s.email]
              .filter(Boolean)
              .map((x) => esc(x ?? ''))
              .join(' · ')}</div>`
          : ''
      }
    </div>
    <div class="title">
      <h2>${t.title}</h2>
      <div class="muted">${esc(m.copyLabel)}</div>
      ${s.isDemo ? '<div class="badge">DEMO DATA</div>' : ''}
    </div>
  </div>

  <div class="meta">
    <div class="box">
      <h3>${t.party}</h3>
      <strong>${esc(c.name)}</strong><br>
      ${c.addressLines.map(esc).join('<br>')}${c.addressLines.length ? '<br>' : ''}
      ${c.gstin ? `GSTIN: <strong>${esc(c.gstin)}</strong><br>` : 'Unregistered<br>'}
      State: ${esc(c.stateName)} (${esc(c.stateCode)})
    </div>
    <div class="box">
      <h3>${t.box}</h3>
      ${t.number}: <strong>${esc(m.documentNumber)}</strong><br>
      ${t.date}: <strong>${esc(formatDate(m.documentDate))}</strong><br>
      ${
        cn
          ? `Against invoice: <strong>${esc(cn.againstInvoiceNumber)}</strong> dated ${esc(formatDate(cn.againstInvoiceDate))}<br>
      Reason: ${esc(cn.reasonLabel)} — ${esc(cn.reason)}<br>`
          : ''
      }
      Place of supply: ${esc(m.placeOfSupply.name)} (${esc(m.placeOfSupply.code)})<br>
      Supply: ${intra ? 'Intra-state (CGST + SGST)' : 'Inter-state (IGST)'}
    </div>
  </div>

  <table>
    <thead><tr>
      <th class="n">#</th><th>Description</th><th>HSN</th><th class="n">Qty</th><th class="n">Rate</th>
      <th class="n">Disc</th><th class="n">Taxable</th>${taxHead}<th class="n">Total</th>
    </tr></thead>
    <tbody>${lineRows}</tbody>
  </table>

  <div class="totals">
    <div>
      <table>
        <thead><tr><th>GST rate</th><th class="n">Taxable</th>${intra ? '<th class="n">CGST</th><th class="n">SGST</th>' : '<th class="n">IGST</th>'}</tr></thead>
        <tbody>${summaryRows}</tbody>
      </table>
      <div class="words">${esc(m.amountInWords)}</div>
      ${m.notes ? `<div class="muted" style="margin-top:4px">Notes: ${esc(m.notes)}</div>` : ''}
    </div>
    <div>
      <table>
        <tr><td>Taxable value</td><td class="n">${amt(m.totals.taxableAmount)}</td></tr>
        ${intra ? `<tr><td>CGST</td><td class="n">${amt(m.totals.cgstAmount)}</td></tr><tr><td>SGST</td><td class="n">${amt(m.totals.sgstAmount)}</td></tr>` : `<tr><td>IGST</td><td class="n">${amt(m.totals.igstAmount)}</td></tr>`}
        <tr><td>Round off</td><td class="n">${amt(m.totals.roundOff)}</td></tr>
        <tr class="grand"><td>${t.total}</td><td class="n">${amt(m.totals.grandTotal)}</td></tr>
      </table>
    </div>
  </div>

  <div class="footer">
    <div style="max-width:52%">${bank}${m.kind === 'TAX_INVOICE' && s.invoiceTerms ? `<div class="muted" style="margin-top:6px">${esc(s.invoiceTerms)}</div>` : ''}</div>
    <div class="sign">For ${esc(s.legalName)}<div class="line">Authorised signatory</div></div>
  </div>

  <div class="fine">
    ${t.footer} · Factory ERP · GST engine v${esc(m.engineVersion)}
    ${m.specimen ? ' · SPECIMEN: tax calculations are pending CA validation and this document is not valid for tax purposes.' : ''}
  </div>
</div>
</body></html>`;
}
