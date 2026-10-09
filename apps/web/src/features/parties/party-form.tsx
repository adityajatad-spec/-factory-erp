import {
  PERMISSIONS,
  type CreatePartyRequest,
  type PartyDto,
  type StateDto,
  type UpdatePartyRequest,
} from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import { ErrorBanner } from '../../components/display';
import { Field, Input, Select } from '../../components/field';
import { api, ApiError } from '../../lib/api';
import { useCan } from '../../lib/session';

const EMPTY = {
  code: '',
  name: '',
  isCustomer: true,
  isSupplier: false,
  gstin: '',
  stateCode: '27',
  city: '',
  addressLine1: '',
  addressLine2: '',
  postalCode: '',
  contactName: '',
  phone: '',
  email: '',
  creditDays: '',
};

type Form = typeof EMPTY;

function formOf(p: PartyDto): Form {
  return {
    code: p.code,
    name: p.name,
    isCustomer: p.isCustomer,
    isSupplier: p.isSupplier,
    gstin: p.gstin ?? '',
    stateCode: p.stateCode,
    city: p.city ?? '',
    addressLine1: p.addressLine1 ?? '',
    addressLine2: p.addressLine2 ?? '',
    postalCode: p.postalCode ?? '',
    contactName: p.contactName ?? '',
    phone: p.phone ?? '',
    email: p.email ?? '',
    creditDays: p.creditDays === null ? '' : String(p.creditDays),
  };
}

/**
 * Create a party, or (with `party`) edit one. Editing never changes the code, and documents
 * already issued keep the details they were issued with. Archiving hides a party from pickers
 * without deleting anything; the server refuses while it has drafts or an open balance.
 */
export function PartyFormDialog({
  open,
  onClose,
  party = null,
  asSupplier = false,
}: {
  open: boolean;
  onClose: () => void;
  party?: PartyDto | null;
  /** New parties start as suppliers (from the purchasing screens). */
  asSupplier?: boolean;
}) {
  const blank: Form = asSupplier ? { ...EMPTY, isCustomer: false, isSupplier: true } : EMPTY;
  const queryClient = useQueryClient();
  const can = useCan();
  const editing = party !== null;
  const [form, setForm] = useState<Form>(() => (party ? formOf(party) : blank));
  const states = useQuery({
    queryKey: ['states'],
    queryFn: () => api.get<StateDto[]>('/reference/states'),
    staleTime: Infinity,
    enabled: open,
  });
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ['parties'] });
    if (!editing) setForm(blank);
    onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      const fields = {
        name: form.name,
        isCustomer: form.isCustomer,
        isSupplier: form.isSupplier,
        gstin: form.gstin,
        stateCode: form.stateCode,
        addressLine1: form.addressLine1,
        addressLine2: form.addressLine2,
        city: form.city,
        postalCode: form.postalCode,
        contactName: form.contactName,
        phone: form.phone,
        email: form.email,
        creditDays: form.creditDays === '' ? null : Number(form.creditDays),
      };
      if (party) {
        const body: Omit<UpdatePartyRequest, 'partyId'> = {
          ...fields,
          expectedVersion: party.version,
        };
        return api.put<PartyDto>(`/parties/${party.id}`, body);
      }
      const body: CreatePartyRequest = { ...fields, code: form.code };
      return api.post<PartyDto>('/parties', body);
    },
    onSuccess: done,
  });
  const archived = party?.status === 'ARCHIVED';
  const setStatus = useMutation({
    mutationFn: () =>
      api.post<PartyDto>(`/parties/${party?.id}/${archived ? 'reactivate' : 'archive'}`, {
        expectedVersion: party?.version,
      }),
    onSuccess: done,
  });

  const fieldError = (path: string) =>
    save.error instanceof ApiError
      ? save.error.issues?.find((i) => i.path === path)?.message
      : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={party ? `Edit ${party.code}` : 'New customer / supplier'}
      wide
      footer={
        <>
          {party && can(PERMISSIONS.partyUpdate) && (
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
          <Button variant="primary" type="submit" form="party-form" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="party-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Code"
          htmlFor="p-code"
          error={fieldError('code')}
          hint={editing ? 'Codes never change' : 'Short unique code, e.g. C-SHARMA'}
        >
          <Input
            id="p-code"
            autoFocus={!editing}
            disabled={editing}
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
        <Field label="Contact person" htmlFor="p-contact">
          <Input
            id="p-contact"
            value={form.contactName}
            onChange={(e) => set({ contactName: e.target.value })}
          />
        </Field>
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
        {editing && (
          <p className="text-xs text-slate-500 sm:col-span-2">
            Invoices already issued keep the details they were issued with; new documents use these.
          </p>
        )}
        <ErrorBanner error={save.error ?? setStatus.error} className="sm:col-span-2" />
      </form>
    </Dialog>
  );
}
