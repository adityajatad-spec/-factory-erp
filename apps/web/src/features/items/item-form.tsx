import {
  ITEM_TYPES,
  type CreateItemRequest,
  type HsnCodeDto,
  type ItemDto,
  type ItemType,
  type UomDto,
} from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import { ErrorBanner } from '../../components/display';
import { Field, Input, Select } from '../../components/field';
import { api, ApiError } from '../../lib/api';
import { ITEM_TYPE_LABELS } from './item-types';

const EMPTY = {
  code: '',
  name: '',
  itemType: 'FINISHED_GOOD' as ItemType,
  uom: 'NOS',
  hsnCode: '',
  defaultSaleRate: '',
};

export function ItemFormDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const set = (patch: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...patch }));
  const hsn = useQuery({
    queryKey: ['hsn'],
    queryFn: () => api.get<HsnCodeDto[]>('/reference/hsn-codes'),
    enabled: open,
  });
  const uoms = useQuery({
    queryKey: ['uoms'],
    queryFn: () => api.get<UomDto[]>('/reference/uoms'),
    staleTime: Infinity,
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () => {
      const body: CreateItemRequest = { ...form, defaultSaleRate: form.defaultSaleRate || null };
      return api.post<ItemDto>('/items', body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      setForm(EMPTY);
      onClose();
    },
  });
  const fieldError = (path: string) =>
    create.error instanceof ApiError
      ? create.error.issues?.find((i) => i.path === path)?.message
      : undefined;
  const selectedHsn = hsn.data?.find((h) => h.code === form.hsnCode);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New item"
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="item-form" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="item-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" htmlFor="i-code" error={fieldError('code')}>
          <Input
            id="i-code"
            autoFocus
            value={form.code}
            onChange={(e) => set({ code: e.target.value.toUpperCase() })}
          />
        </Field>
        <Field label="Name" htmlFor="i-name" error={fieldError('name')}>
          <Input id="i-name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Type" htmlFor="i-type">
          <Select
            id="i-type"
            value={form.itemType}
            onChange={(e) => set({ itemType: e.target.value as ItemType })}
          >
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {ITEM_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Unit of measure" htmlFor="i-uom">
          <Select id="i-uom" value={form.uom} onChange={(e) => set({ uom: e.target.value })}>
            {(uoms.data ?? []).map((u) => (
              <option key={u.code} value={u.code}>
                {u.code} — {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="HSN / SAC code"
          htmlFor="i-hsn"
          error={fieldError('hsnCode')}
          hint={
            selectedHsn
              ? `GST today: ${selectedHsn.currentRatePercent ?? 'not configured'}%${selectedHsn.rateStatus === 'DEMO_UNVERIFIED' ? ' (demo rate, unverified)' : ''}`
              : 'Rates are effective-dated master data'
          }
        >
          <Select
            id="i-hsn"
            value={form.hsnCode}
            onChange={(e) => set({ hsnCode: e.target.value })}
          >
            <option value="">Select…</option>
            {(hsn.data ?? []).map((h) => (
              <option key={h.code} value={h.code}>
                {h.code} — {h.description}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default sale rate (₹)" htmlFor="i-rate" error={fieldError('defaultSaleRate')}>
          <Input
            id="i-rate"
            inputMode="decimal"
            className="tabular"
            value={form.defaultSaleRate}
            onChange={(e) => set({ defaultSaleRate: e.target.value })}
          />
        </Field>
        <ErrorBanner error={create.error} className="sm:col-span-2" />
      </form>
    </Dialog>
  );
}
