import {
  ITEM_TYPES,
  PERMISSIONS,
  type CreateItemRequest,
  type HsnCodeDto,
  type ItemDto,
  type ItemType,
  type UomDto,
  type UpdateItemRequest,
} from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import { ErrorBanner } from '../../components/display';
import { Field, Input, Select } from '../../components/field';
import { api, ApiError } from '../../lib/api';
import { useCan } from '../../lib/session';
import { ITEM_TYPE_LABELS } from './item-types';

const EMPTY = {
  code: '',
  name: '',
  description: '',
  itemType: 'FINISHED_GOOD' as ItemType,
  uom: 'NOS',
  hsnCode: '',
  defaultSaleRate: '',
};

type Form = typeof EMPTY;

function formOf(i: ItemDto): Form {
  return {
    code: i.code,
    name: i.name,
    description: i.description ?? '',
    itemType: i.itemType,
    uom: i.uom,
    hsnCode: i.hsnCode,
    defaultSaleRate: i.defaultSaleRate ?? '',
  };
}

/**
 * Create an item, or (with `item`) edit one. The code never changes, and invoices already
 * issued keep their own line snapshot (HSN, rate, unit). Archiving hides an item from pickers;
 * the server refuses while a draft invoice still uses it.
 */
export function ItemFormDialog({
  open,
  onClose,
  item = null,
}: {
  open: boolean;
  onClose: () => void;
  item?: ItemDto | null;
}) {
  const queryClient = useQueryClient();
  const can = useCan();
  const editing = item !== null;
  const [form, setForm] = useState<Form>(() => (item ? formOf(item) : EMPTY));
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
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

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ['items'] });
    if (!editing) setForm(EMPTY);
    onClose();
  };
  const create = useMutation({
    mutationFn: () => {
      const { code, ...fields } = { ...form, defaultSaleRate: form.defaultSaleRate || null };
      if (item) {
        const body: Omit<UpdateItemRequest, 'itemId'> = {
          ...fields,
          expectedVersion: item.version,
        };
        return api.put<ItemDto>(`/items/${item.id}`, body);
      }
      const body: CreateItemRequest = { ...fields, code };
      return api.post<ItemDto>('/items', body);
    },
    onSuccess: done,
  });
  const archived = item?.status === 'ARCHIVED';
  const setStatus = useMutation({
    mutationFn: () =>
      api.post<ItemDto>(`/items/${item?.id}/${archived ? 'reactivate' : 'archive'}`, {
        expectedVersion: item?.version,
      }),
    onSuccess: done,
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
      title={item ? `Edit ${item.code}` : 'New item'}
      wide
      footer={
        <>
          {item && can(PERMISSIONS.itemUpdate) && (
            <Button
              variant={archived ? 'secondary' : 'danger'}
              className="mr-auto"
              onClick={() => setStatus.mutate()}
              disabled={setStatus.isPending}
            >
              {archived ? 'Reactivate' : 'Archive'}
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="item-form" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="item-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Code"
          htmlFor="i-code"
          error={fieldError('code')}
          hint={editing ? 'Codes never change' : undefined}
        >
          <Input
            id="i-code"
            autoFocus={!editing}
            disabled={editing}
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
        <Field label="Description" htmlFor="i-desc" error={fieldError('description')}>
          <Input
            id="i-desc"
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
        {editing && (
          <p className="text-xs text-slate-500 sm:col-span-2">
            Invoices already issued keep the HSN, GST rate and unit they were issued with; drafts
            pick up these details when next saved.
          </p>
        )}
        <ErrorBanner error={create.error ?? setStatus.error} className="sm:col-span-2" />
      </form>
    </Dialog>
  );
}
