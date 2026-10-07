import type { ItemDto } from '@factory-erp/contracts';
import type { InvoiceCalcResult } from '@factory-erp/gst';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { Combobox } from '../../components/combobox';
import { Badge, td, tdNum, th } from '../../components/display';
import { Input } from '../../components/field';
import { Money } from '@factory-erp/money';
import { inr, qty } from '../../lib/format';
import { matches } from './use-invoice-masters';

export interface EditorLine {
  key: string;
  item: ItemDto | null;
  quantity: string;
  unitRate: string;
  discountPercent: string;
}

let seq = 0;
export const newLine = (): EditorLine => ({
  key: `line-${++seq}`,
  item: null,
  quantity: '',
  unitRate: '',
  discountPercent: '',
});

export function LinesEditor({
  lines,
  setLines,
  items,
  preview,
  intra,
}: {
  lines: EditorLine[];
  setLines: Dispatch<SetStateAction<EditorLine[]>>;
  items: readonly ItemDto[];
  preview: InvoiceCalcResult | null;
  intra: boolean;
}) {
  const [queries, setQueries] = useState<Record<string, string>>({});
  const update = (key: string, patch: Partial<EditorLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) =>
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls));

  // Preview lines are numbered over lines that have an item, in order.
  let previewIndex = 0;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse text-sm">
        <thead>
          <tr>
            <th className={`${th} w-8`}>#</th>
            <th className={th}>Item</th>
            <th className={`${th} w-24 text-right`}>Qty</th>
            <th className={`${th} w-28 text-right`}>Rate (₹)</th>
            <th className={`${th} w-20 text-right`}>Disc %</th>
            <th className={`${th} w-16 text-right`}>GST</th>
            <th className={`${th} text-right`}>Taxable</th>
            <th className={`${th} text-right`}>{intra ? 'CGST+SGST' : 'IGST'}</th>
            <th className={`${th} text-right`}>Total</th>
            <th className={`${th} w-8`} />
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => {
            const calc = line.item ? preview?.lines[previewIndex++] : undefined;
            const q = queries[line.key] ?? '';
            const options = items.filter((it) => matches(q, it.name, it.code)).slice(0, 50);
            const isLast = i === lines.length - 1;
            return (
              <tr key={line.key} className="align-top">
                <td className={`${td} pt-3 text-xs text-slate-500`}>{i + 1}</td>
                <td className={`${td} min-w-64`}>
                  <Combobox
                    autoFocus={i > 0 && !line.item}
                    options={options}
                    value={line.item}
                    query={q}
                    onQueryChange={(v) => setQueries((s) => ({ ...s, [line.key]: v }))}
                    onSelect={(it) =>
                      update(line.key, {
                        item: it,
                        unitRate:
                          line.unitRate || (it.defaultSaleRate ? qty(it.defaultSaleRate) : ''),
                      })
                    }
                    getKey={(it) => it.id}
                    getLabel={(it) => `${it.code} · ${it.name}`}
                    placeholder="Search item"
                    renderOption={(it) => (
                      <div className="flex justify-between gap-3">
                        <span className="truncate">
                          <span className="font-mono text-xs text-slate-500">{it.code}</span>{' '}
                          {it.name}
                        </span>
                        <span className="shrink-0 text-xs text-slate-500">
                          HSN {it.hsnCode} · {it.gstRatePercent ?? '?'}%
                        </span>
                      </div>
                    )}
                  />
                  {line.item && (
                    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
                      HSN {line.item.hsnCode} · {line.item.uom}
                      {line.item.gstRateStatus === 'DEMO_UNVERIFIED' && (
                        <Badge
                          tone="amber"
                          title="Synthetic demo GST rate — not verified against official notifications"
                        >
                          demo rate
                        </Badge>
                      )}
                    </p>
                  )}
                </td>
                <td className={td}>
                  <Input
                    inputMode="decimal"
                    aria-label="Quantity"
                    className="text-right tabular"
                    value={line.quantity}
                    onChange={(e) => update(line.key, { quantity: e.target.value })}
                  />
                </td>
                <td className={td}>
                  <Input
                    inputMode="decimal"
                    aria-label="Unit rate"
                    className="text-right tabular"
                    value={line.unitRate}
                    onChange={(e) => update(line.key, { unitRate: e.target.value })}
                  />
                </td>
                <td className={td}>
                  <Input
                    inputMode="decimal"
                    aria-label="Discount percent"
                    className="text-right tabular"
                    placeholder="0"
                    value={line.discountPercent}
                    onChange={(e) => update(line.key, { discountPercent: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && isLast && line.item) {
                        e.preventDefault();
                        setLines((ls) => [...ls, newLine()]);
                      }
                    }}
                  />
                </td>
                <td className={`${tdNum} pt-3 text-slate-600`}>
                  {line.item?.gstRatePercent ? `${line.item.gstRatePercent}%` : '—'}
                </td>
                <td className={`${tdNum} pt-3`}>{calc ? inr(calc.taxableAmount) : '—'}</td>
                <td className={`${tdNum} pt-3`}>
                  {calc
                    ? inr(
                        intra
                          ? Money.of(calc.cgstAmount).plus(Money.of(calc.sgstAmount)).toString()
                          : calc.igstAmount,
                      )
                    : '—'}
                </td>
                <td className={`${tdNum} pt-3 font-medium`}>{calc ? inr(calc.lineTotal) : '—'}</td>
                <td className={`${td} pt-2`}>
                  <button
                    type="button"
                    aria-label={`Remove line ${i + 1}`}
                    onClick={() => remove(line.key)}
                    disabled={lines.length === 1}
                    className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-30"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-slate-500">
        Tip: press Enter in the last discount field to add a line · Ctrl/⌘ + Enter saves.
      </p>
    </div>
  );
}
