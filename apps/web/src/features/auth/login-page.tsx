import type { SessionUser } from '@factory-erp/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/button';
import { ErrorBanner } from '../../components/display';
import { Field, Input } from '../../components/field';
import { api } from '../../lib/api';

const route = getRouteApi('/login');

export function LoginPage() {
  const { next } = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.post<SessionUser>('/auth/login', { username, password }),
    onSuccess: async (user) => {
      queryClient.setQueryData(['session'], user);
      await navigate({ to: next ?? '/' });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <span className="text-lg font-semibold tracking-wide text-white">Factory ERP</span>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-lg bg-white p-6 shadow-xl">
          <h1 className="text-base font-semibold text-slate-900">Sign in</h1>
          <Field label="Username" htmlFor="username">
            <Input
              id="username"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <ErrorBanner error={login.error} />
          <Button
            type="submit"
            variant="primary"
            className="w-full justify-center"
            disabled={login.isPending || !username || !password}
          >
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
          {import.meta.env.DEV && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Development build · demo users: <b>owner</b>, <b>accountant</b>, <b>production</b>,{' '}
              <b>worker</b>… · password <b>factory-demo</b>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
