import type { CompanyDto, ItemDto, PartyDto, StateDto } from '@factory-erp/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

/**
 * Master data for the invoice editor. Lists are capped at 200 and filtered client-side for
 * instant keyboard search; move to server-side search when a tenant outgrows that.
 */
export function useInvoiceMasters() {
  const company = useQuery({
    queryKey: ['company'],
    queryFn: () => api.get<CompanyDto>('/company'),
    staleTime: 10 * 60_000,
  });
  const states = useQuery({
    queryKey: ['states'],
    queryFn: () => api.get<StateDto[]>('/reference/states'),
    staleTime: Infinity,
  });
  const customers = useQuery({
    queryKey: ['parties', 'customers-all'],
    queryFn: () => api.get<PartyDto[]>('/parties', { role: 'customer', limit: 200 }),
  });
  const items = useQuery({
    queryKey: ['items', 'saleable-all'],
    queryFn: () => api.get<ItemDto[]>('/items', { saleable: 'true', limit: 200 }),
  });
  return { company, states, customers, items };
}

export function matches(q: string, ...fields: Array<string | null | undefined>): boolean {
  const needle = q.trim().toLowerCase();
  return !needle || fields.some((f) => f?.toLowerCase().includes(needle));
}
