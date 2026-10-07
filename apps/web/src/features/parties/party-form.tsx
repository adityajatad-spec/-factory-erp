import type { CreatePartyRequest, PartyDto, StateDto } from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import { ErrorBanner } from '../../components/display';
import { Field, Input, Select } from '../../components/field';
import { api, ApiError } from '../../lib/api';

const EMPTY = {
  code: '',
  name: '',
  isCustomer: true,
  isSupplier: false,
  gstin: '',
  stateCode: '27',
  city: '',
  addressLine1: '',
  postalCode: '',
  phone: '',
  email: '',
  creditDays: '',
};

export function PartyFormDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const states = useQuery({
    queryKey: ['states'],
    queryFn: () => api.get<StateDto[]>('/reference/states'),
    staleTime: Infinity,
    enabled: open,
  });
  const set = (patch: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...patch }));

  const create = useMutation({
    mutationFn: () => {
      const body: CreatePartyRequest = {
        code: form.code,
        name: form.name,
        isCustomer: form.isCustomer,
        isSupplier: form.isSupplier,
        gstin: form.gstin,
        stateCode: form.stateCode,
        addressLine1: form.addressLine1,
        city: form.city,
        postalCode: form.postalCode,
        phone: form.phone,
        email: form.email,
        creditDays: form.creditDays === '' ? null : Number(form.creditDays),
      };
      return api.post<PartyDto>('/parties', body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['parties'] });
      setForm(EMPTY);
      onClose();
    },
  });

  const fieldError = (path: string) =>
    create.error instanceof ApiError
      ? create.error.issues?.find((i) => i.path === path)?.message
      : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New customer / supplier"
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="party-form" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="party-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Code"
          htmlFor="p-code"
          error={fieldError('code')}
          hint="Short unique code, e.g. C-SHARMA"
        >
          <Input
            id="p-code"
            autoFocus
            value={form.code}
            onChange={(e) => set({ code: e.target.value.toUpperCase() })}
          />
        </Field>
        <Field label="Name" htmlFor="p-name" error={fieldError('name')}>
          <Input id="p-name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field
          label="GSTIN"
          htmlFor="p-gstin"
          error={fieldError('gstin')}
          hint="Leave blank for unregistered parties"
        >
          <Input
            id="p-gstin"
            value={form.gstin}
            maxLength={15}
            onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
            className="font-mono"
          />
        </Field>
        <Field label="State" htmlFor="p-state" error={fieldError('stateCode')}>
          <Select
            id="p-state"
            value={form.stateCode}
            onChange={(e) => set({ stateCode: e.target.value })}
          >
            {(states.data ?? []).map((s) => (
              <option key={s.code} value={s.code}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Address" htmlFor="p-addr">
          <Input
            id="p-addr"
            value={form.addressLine1}
            onChange={(e) => set({ addressLine1: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="City" htmlFor="p-city">
            <Input id="p-city" value={form.city} onChange={(e) => set({ city: e.target.value })} />
          </Field>
          <Field label="PIN code" htmlFor="p-pin">
            <Input
              id="p-pin"
              inputMode="numeric"
              value={form.postalCode}
              onChange={(e) => set({ postalCode: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Phone" htmlFor="p-phone">
          <Input id="p-phone" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Email" htmlFor="p-email" error={fieldError('email')}>
          <Input
            id="p-email"
            type="email"
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
          />
        </Field>
        <Field label="Credit days" htmlFor="p-credit" error={fieldError('creditDays')}>
          <Input
            id="p-credit"
            inputMode="numeric"
            value={form.creditDays}
            onChange={(e) => set({ creditDays: e.target.value.replace(/\D/g, '') })}
          />
        </Field>
        <fieldset className="flex items-end gap-4 pb-1 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.isCustomer}
              onChange={(e) => set({ isCustomer: e.target.checked })}
            />{' '}
            Customer
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.isSupplier}
              onChange={(e) => set({ isSupplier: e.target.checked })}
            />{' '}
            Supplier
          </label>
        </fieldset>
        <ErrorBanner error={create.error} className="sm:col-span-2" />
      </form>
    </Dialog>
  );
}
