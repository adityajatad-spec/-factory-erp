import {
  PAYMENT_MODES,
  PERMISSIONS,
  type PartyDto,
  type PaymentMode,
  type SupplierPaymentDto,
} from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '../../components/button';
import { Combobox } from '../../components/combobox';
import { ErrorBanner, PageHeader, Panel, Spinner } from '../../components/display';
import { Field, Input, Select } from '../../components/field';
import { api } from '../../lib/api';
import { todayIST } from '../../lib/format';
import { useCan } from '../../lib/session';
import { matches } from '../invoices/use-invoice-masters';
import { PURCHASING_KEYS, useSuppliers } from '../purchasing/shared';
import { checkDraftAllocations, parseAmount } from '../receivables/allocation-math';
import { PAYMENT_MODE_LABELS } from '../receivables/labels';
import {
  asOpenAmounts,
  BillAllocationEditor,
  billAllocationsPayload,
  openBillsQuery,
} from './bill-allocation-editor';

const route = getRouteApi('/app/finance/supplier-payments/new');

export function SupplierPaymentNewPage() {
  const { supplierId, invoiceId } = route.useSearch();
  const suppliers = useSuppliers();
  const open = useQuery({ ...openBillsQuery(supplierId ?? ''), enabled: !!supplierId });
  if (suppliers.isPending || (supplierId && open.isPending)) return <Spinner />;
  const error = suppliers.error ?? open.error;
  if (error) return <ErrorBanner error={error} />;
  const preset = invoiceId ? open.data?.find((b) => b.purchaseInvoiceId === invoiceId) : undefined;
  return (
    <PaymentForm
      suppliers={suppliers.data ?? []}
      initialSupplier={suppliers.data?.find((s) => s.id === supplierId) ?? null}
      preset={preset ? { id: preset.purchaseInvoiceId, amount: preset.outstandingAmount } : null}
    />
  );
}

function PaymentForm({
  suppliers,
  initialSupplier,
  preset,
}: {
  suppliers: PartyDto[];
  initialSupplier: PartyDto | null;
  preset: { id: string; amount: string } | null;
}) {
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [supplier, setSupplier] = useState<PartyDto | null>(initialSupplier);
  const [query, setQuery] = useState('');
  const [paymentDate, setPaymentDate] = useState(todayIST());
  const [amount, setAmount] = useState(preset?.amount ?? '');
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>(
    preset ? { [preset.id]: preset.amount } : {},
  );
  const amountValid = amount.trim() !== '' && (parseAmount(amount)?.isPositive() ?? false);
  const open = useQuery({ ...openBillsQuery(supplier?.id ?? ''), enabled: !!supplier });
  const check = checkDraftAllocations(amount || '0', asOpenAmounts(open.data ?? []), amounts);

  const save = useMutation({
    mutationFn: () =>
      api.post<SupplierPaymentDto>('/supplier-payments', {
        supplierId: supplier?.id,
        paymentDate,
        amount: amount.trim(),
        paymentMode,
        reference: reference || null,
        notes: notes || null,
        allocations: billAllocationsPayload(amounts),
      }),
    onSuccess: async (saved) => {
      await Promise.all(
        PURCHASING_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      );
      await navigate({
        to: '/finance/supplier-payments/$paymentId',
        params: { paymentId: saved.id },
      });
    },
  });

  return (
    <>
      <PageHeader
        title="Record supplier payment"
        subtitle="It waits for approval by a different person; only then does it reduce what we owe and settle the bills."
        actions={
          <>
            <Button onClick={() => window.history.back()}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                save.isPending ||
                !supplier ||
                !amountValid ||
                !check.valid ||
                !can(PERMISSIONS.supplierPaymentRequest)
              }
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Send for approval'}
            </Button>
          </>
        }
      />
      <ErrorBanner error={save.error} className="mb-3" />
      <div className="space-y-4">
        <Panel title="Payment">
          <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-6">
            <div className="sm:col-span-2">
              <Field label="Supplier" htmlFor="pay-supplier">
                <Combobox
                  inputId="pay-supplier"
                  autoFocus={!initialSupplier}
                  options={suppliers.filter((s) => matches(query, s.name, s.code)).slice(0, 50)}
                  value={supplier}
                  query={query}
                  onQueryChange={setQuery}
                  onSelect={(s) => {
                    setSupplier(s);
                    setAmounts({});
                  }}
                  getKey={(s) => s.id}
                  getLabel={(s) => s.name}
                  placeholder="Search supplier"
                />
              </Field>
            </div>
            <Field label="Payment date" htmlFor="pay-date">
              <Input
                id="pay-date"
                type="date"
                value={paymentDate}
                max={todayIST()}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </Field>
            <Field label="Amount (₹)" htmlFor="pay-amount">
              <Input
                id="pay-amount"
                inputMode="decimal"
                className="text-right tabular"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Mode" htmlFor="pay-mode">
              <Select
                id="pay-mode"
                value={paymentMode}
                onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}
              >
                {PAYMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_MODE_LABELS[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference (UTR / cheque no.)" htmlFor="pay-ref">
              <Input
                id="pay-ref"
                value={reference}
                maxLength={100}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
            <div className="sm:col-span-2 lg:col-span-6">
              <Field label="Notes" htmlFor="pay-notes">
                <Input
                  id="pay-notes"
                  value={notes}
                  maxLength={500}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
            </div>
          </div>
        </Panel>
        {supplier && (
          <Panel title="Bills this payment settles">
            <BillAllocationEditor
              supplierId={supplier.id}
              available={amount || '0'}
              amounts={amounts}
              onChange={setAmounts}
            />
          </Panel>
        )}
      </div>
    </>
  );
}
