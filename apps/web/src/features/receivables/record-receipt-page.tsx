import {
  PAYMENT_MODES,
  PERMISSIONS,
  type OpenInvoiceDto,
  type PartyDto,
  type PaymentMode,
  type ReceiptDto,
} from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '../../components/button';
import { Combobox } from '../../components/combobox';
import { ErrorBanner, PageHeader, Panel, Spinner } from '../../components/display';
import { Field, Input, Select } from '../../components/field';
import { api } from '../../lib/api';
import { todayIST } from '../../lib/format';
import { useCan } from '../../lib/session';
import { matches } from '../invoices/use-invoice-masters';
import { checkDraftAllocations, parseAmount } from './allocation-math';
import { AllocationEditor, allocationsPayload, openInvoicesQuery } from './allocation-editor';
import { PAYMENT_MODE_LABELS } from './labels';

const route = getRouteApi('/app/finance/receipts/new');

export function RecordReceiptPage() {
  const { customerId, invoiceId } = route.useSearch();
  const customers = useQuery({
    queryKey: ['parties', 'customers-all'],
    queryFn: () => api.get<PartyDto[]>('/parties', { role: 'customer', limit: 200 }),
  });
  // When opened from an invoice ("Record payment"), prefill that invoice's outstanding.
  const open = useQuery({ ...openInvoicesQuery(customerId ?? ''), enabled: !!customerId });

  if (customers.isPending || (customerId && open.isPending)) return <Spinner />;
  const error = customers.error ?? open.error;
  if (error) return <ErrorBanner error={error} />;

  const preset = invoiceId ? open.data?.find((i) => i.invoiceId === invoiceId) : undefined;
  return (
    <ReceiptForm
      customers={customers.data ?? []}
      initialCustomer={customers.data?.find((c) => c.id === customerId) ?? null}
      preset={preset ?? null}
    />
  );
}

function ReceiptForm({
  customers,
  initialCustomer,
  preset,
}: {
  customers: PartyDto[];
  initialCustomer: PartyDto | null;
  preset: OpenInvoiceDto | null;
}) {
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [customer, setCustomer] = useState<PartyDto | null>(initialCustomer);
  const [customerQuery, setCustomerQuery] = useState('');
  const [receiptDate, setReceiptDate] = useState(todayIST());
  const [amount, setAmount] = useState(preset?.outstandingAmount ?? '');
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>(
    preset ? { [preset.invoiceId]: preset.outstandingAmount } : {},
  );

  const amountValid = (parseAmount(amount)?.isPositive() ?? false) && amount.trim() !== '';
  const open = useQuery({ ...openInvoicesQuery(customer?.id ?? ''), enabled: !!customer });
  const check = checkDraftAllocations(amount || '0', open.data ?? [], amounts);

  const save = useMutation({
    mutationFn: () =>
      api.post<ReceiptDto>('/receipts', {
        customerId: customer?.id,
        receiptDate,
        amount: amount.trim(),
        paymentMode,
        reference,
        notes,
        allocations: allocationsPayload(amounts),
      }),
    onSuccess: async (receipt) => {
      await Promise.all(
        ['receipts', 'receivables', 'invoices', 'invoice', 'dashboard', 'parties'].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      );
      await navigate({ to: '/finance/receipts/$receiptId', params: { receiptId: receipt.id } });
    },
  });

  const canSave = !!customer && amountValid && check.valid && !save.isPending;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) {
        e.preventDefault();
        save.mutate();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSave, save]);

  const customerOptions = customers
    .filter((c) => matches(customerQuery, c.name, c.code, c.gstin))
    .slice(0, 50);

  return (
    <>
      <PageHeader
        title="Record receipt"
        subtitle="Money received from a customer. Receipts are permanent; allocate them against invoices now or later."
        actions={
          <>
            <Button onClick={() => window.history.back()}>Cancel</Button>
            <Button
              variant="primary"
              shortcut="Ctrl ↵"
              disabled={!canSave || !can(PERMISSIONS.receiptRecord)}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Record receipt'}
            </Button>
          </>
        }
      />
      <ErrorBanner error={save.error} className="mb-3" />

      <div className="space-y-4">
        <Panel title="Payment">
          <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-6">
            <div className="sm:col-span-2">
              <Field label="Customer" htmlFor="r-customer">
                <Combobox
                  inputId="r-customer"
                  autoFocus={!initialCustomer}
                  options={customerOptions}
                  value={customer}
                  query={customerQuery}
                  onQueryChange={setCustomerQuery}
                  onSelect={(c) => {
                    setCustomer(c);
                    setAmounts({});
                  }}
                  getKey={(c) => c.id}
                  getLabel={(c) => c.name}
                  placeholder="Search customer"
                />
              </Field>
            </div>
            <Field label="Receipt date" htmlFor="r-date">
              <Input
                id="r-date"
                type="date"
                value={receiptDate}
                max={todayIST()}
                onChange={(e) => setReceiptDate(e.target.value)}
              />
            </Field>
            <Field
              label="Amount received (₹)"
              htmlFor="r-amount"
              error={
                amount.trim() !== '' && !amountValid ? 'Enter an amount like 1234.50' : undefined
              }
            >
              <Input
                id="r-amount"
                autoFocus={!!initialCustomer}
                inputMode="decimal"
                className="text-right tabular"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Mode" htmlFor="r-mode">
              <Select
                id="r-mode"
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
            <Field label="Reference" htmlFor="r-ref" hint="UTR / UPI ref / cheque no.">
              <Input
                id="r-ref"
                value={reference}
                maxLength={100}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
            <div className="sm:col-span-2 lg:col-span-6">
              <Field label="Notes" htmlFor="r-notes">
                <Input
                  id="r-notes"
                  value={notes}
                  maxLength={500}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
            </div>
          </div>
        </Panel>

        <Panel title="Allocate against invoices">
          {customer ? (
            <AllocationEditor
              customerId={customer.id}
              available={amountValid ? amount.trim() : '0'}
              amounts={amounts}
              onChange={setAmounts}
            />
          ) : (
            <p className="p-3 text-sm text-slate-500">
              Choose a customer to see their open invoices.
            </p>
          )}
        </Panel>
      </div>
    </>
  );
}
