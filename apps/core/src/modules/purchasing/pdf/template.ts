import { formatIndianNumber } from '@factory-erp/money';
import type { PurchaseOrderPrintModel } from './print-model';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
const amt = (s: string) => formatIndianNumber(s, 2);
const qty = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const date = (iso: string) => iso.split('-').reverse().join('-');

const STYLES = `
  @page { size: A4; margin: 12mm 10mm 14mm 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, "Noto Sans", sans-serif; font-size: 9pt; color: #111; margin: 0; }
  .watermark { position: fixed; top: 38%; left: -5%; width: 110%; text-align: center; transform: rotate(-28deg);
    font-size: 30pt; font-weight: 700; color: rgba(200, 30, 30, 0.12); white-space: nowrap; z-index: 0; }
  .doc { position: relative; z-index: 1; }
  .top { display: flex; justify-content: space-between; border-bottom: 2px solid #111; padding-bottom: 6px; }
  h1 { font-size: 15pt; margin: 0 0 2px; } h2 { margin: 0; font-size: 14pt; letter-spacing: 1px; text-align: right; }
  .muted { color: #555; }
  .badge { display: inline-block; border: 1px solid #b91c1c; color: #b91c1c; font-size: 7pt; padding: 1px 4px; margin-top: 3px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0; }
  .box { border: 1px solid #999; padding: 6px; }
  .box h3 { margin: 0 0 3px; font-size: 7.5pt; text-transform: uppercase; color: #555; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 3px 4px; vertical-align: top; }
  th { background: #f0f0f0; font-size: 7.5pt; text-transform: uppercase; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  .totals { display: grid; grid-template-columns: 1.4fr 1fr; gap: 8px; margin-top: 8px; }
  .totals table td { border: none; padding: 2px 4px; }
  .grand td { border-top: 2px solid #111 !important; font-weight: 700; font-size: 11pt; }
  .sign { text-align: right; margin-top: 14px; } .sign .line { margin-top: 36px; border-top: 1px solid #111; display: inline-block; min-width: 45%; }
  .fine { font-size: 7pt; color: #666; margin-top: 10px; border-top: 1px dashed #bbb; padding-top: 4px; }
`;

/** Pure function: print model → self-contained HTML (no scripts, no external resources). */
export function renderPurchaseOrderHtml(m: PurchaseOrderPrintModel): string {
  const intra = m.supplyType === 'INTRA_STATE';
  const taxHead = intra
    ? '<th class="n">CGST</th><th class="n">SGST</th>'
    : '<th class="n">IGST</th>';
  const rows = m.lines
    .map(
      (
        l,
      ) => `<tr><td class="n">${l.lineNo}</td><td>${esc(l.description)}</td><td>${esc(l.hsnCode)}</td>
      <td class="n">${esc(qty(l.quantity))} ${esc(l.uom)}</td><td class="n">${amt(l.unitRate)}</td>
      <td class="n">${l.discountPercent === '0' ? '—' : `${esc(l.discountPercent)}%`}</td>
      <td class="n">${amt(l.taxableAmount)}</td>
      ${intra ? `<td class="n">${amt(l.cgstAmount)}</td><td class="n">${amt(l.sgstAmount)}</td>` : `<td class="n">${amt(l.igstAmount)}</td>`}
      <td class="n">${amt(l.lineTotal)}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(m.poNumber)}</title><style>${STYLES}</style></head>
<body>
${m.specimen ? '<div class="watermark">SPECIMEN — DEMO PURCHASE ORDER</div>' : ''}
<div class="doc">
  <div class="top">
    <div>
      <h1>${esc(m.buyer.legalName)}</h1>
      <div class="muted">${m.buyer.addressLines.map(esc).join('<br>')}</div>
      <div>${m.buyer.gstin ? `GSTIN: <strong>${esc(m.buyer.gstin)}</strong> · ` : ''}State: ${esc(m.buyer.stateName)}</div>
      ${m.buyer.contact.length ? `<div class="muted">${m.buyer.contact.map(esc).join(' · ')}</div>` : ''}
    </div>
    <div><h2>PURCHASE ORDER</h2>${m.buyer.isDemo ? '<div class="badge">DEMO DATA</div>' : ''}</div>
  </div>
  <div class="meta">
    <div class="box"><h3>Supplier</h3><strong>${esc(m.supplier.name)}</strong> (${esc(m.supplier.code)})<br>
      ${m.supplier.addressLines.map(esc).join('<br>')}${m.supplier.addressLines.length ? '<br>' : ''}
      ${m.supplier.gstin ? `GSTIN: <strong>${esc(m.supplier.gstin)}</strong>` : 'Unregistered'} · State ${esc(m.supplier.stateCode)}</div>
    <div class="box"><h3>Order</h3>PO no: <strong>${esc(m.poNumber)}</strong><br>PO date: <strong>${esc(date(m.poDate))}</strong><br>
      ${m.expectedDate ? `Deliver by: <strong>${esc(date(m.expectedDate))}</strong><br>` : ''}
      Deliver to: ${esc(m.deliverTo.warehouse)}<br>
      Tax: ${intra ? 'Intra-state (CGST + SGST)' : 'Inter-state (IGST)'}</div>
  </div>
  <table><thead><tr><th class="n">#</th><th>Description</th><th>HSN</th><th class="n">Qty</th><th class="n">Rate</th>
    <th class="n">Disc</th><th class="n">Taxable</th>${taxHead}<th class="n">Total</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="totals">
    <div><strong>${esc(m.amountInWords)}</strong>${m.notes ? `<div class="muted" style="margin-top:4px">Notes: ${esc(m.notes)}</div>` : ''}</div>
    <table>
      <tr><td>Taxable value</td><td class="n">${amt(m.totals.taxableAmount)}</td></tr>
      ${intra ? `<tr><td>CGST</td><td class="n">${amt(m.totals.cgstAmount)}</td></tr><tr><td>SGST</td><td class="n">${amt(m.totals.sgstAmount)}</td></tr>` : `<tr><td>IGST</td><td class="n">${amt(m.totals.igstAmount)}</td></tr>`}
      <tr><td>Round off</td><td class="n">${amt(m.totals.roundOff)}</td></tr>
      <tr class="grand"><td>Order total (₹)</td><td class="n">${amt(m.totals.grandTotal)}</td></tr>
    </table>
  </div>
  <div class="sign">For ${esc(m.buyer.legalName)}<br><span class="line">${m.approvedByName ? `Approved by ${esc(m.approvedByName)}` : 'Authorised signatory'}</span></div>
  <div class="fine">Computer-generated purchase order · Factory ERP · GST engine v${esc(m.engineVersion)}${
    m.specimen ? ' · SPECIMEN: tax calculations are pending CA validation.' : ''
  }</div>
</div>
</body></html>`;
}
