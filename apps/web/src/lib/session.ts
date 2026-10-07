import type { Permission, SessionUser } from '@factory-erp/contracts';
import { queryOptions, useSuspenseQuery } from '@tanstack/react-query';
import { api } from './api';

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: () => api.get<SessionUser>('/auth/me'),
  staleTime: 5 * 60_000,
  retry: false,
});

/** The signed-in user. Only used under the authenticated layout, which guarantees a session. */
export function useSession(): SessionUser {
  return useSuspenseQuery(sessionQuery).data;
}

/**
 * Hide actions the user cannot perform. This is UX only — the server enforces every
 * permission independently and never trusts the client.
 */
export function useCan(): (permission: Permission) => boolean {
  const session = useSession();
  return (p) => session.permissions.includes(p);
}
