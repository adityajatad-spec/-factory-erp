import type { ChangePasswordRequest } from '@factory-erp/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/button';
import { ErrorBanner, PageHeader, Panel } from '../../components/display';
import { Field, Input } from '../../components/field';
import { api, ApiError } from '../../lib/api';
import { sessionQuery, useSession } from '../../lib/session';

/**
 * Change your own password. With `forced`, the app shows only this until the user replaces a
 * password an administrator set (the server refuses everything else meanwhile).
 */
export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const mismatch = confirm !== '' && confirm !== next;

  const change = useMutation({
    mutationFn: () => {
      const body: ChangePasswordRequest = { currentPassword: current, newPassword: next };
      return api.post<{ changed: true }>('/account/password', body);
    },
    onSuccess: async () => {
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
  });
  const fieldError = (path: string) =>
    change.error instanceof ApiError
      ? change.error.issues?.find((i) => i.path === path)?.message
      : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!mismatch) change.mutate();
  };

  return (
    <>
      <PageHeader
        title={forced ? 'Choose your own password' : 'Change password'}
        subtitle={
          forced
            ? `Welcome, ${session.displayName}. Your administrator set a temporary password; choose your own to continue.`
            : 'Your other signed-in devices are signed out; this one stays signed in.'
        }
      />
      <Panel title="Password" className="max-w-lg">
        <form onSubmit={submit} className="grid gap-3 p-3">
          <Field
            label="Current password"
            htmlFor="pw-current"
            error={fieldError('currentPassword')}
          >
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field
            label="New password"
            htmlFor="pw-new"
            error={fieldError('newPassword')}
            hint="At least 10 characters. A few unrelated words work well."
          >
            <Input
              id="pw-new"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field
            label="New password again"
            htmlFor="pw-confirm"
            error={mismatch ? 'Does not match the new password' : undefined}
          >
            <Input
              id="pw-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          <ErrorBanner error={change.error} />
          {done && !forced && <p className="text-sm text-emerald-700">Password changed.</p>}
          <div>
            <Button
              variant="primary"
              type="submit"
              disabled={change.isPending || !current || next.length < 10 || next !== confirm}
            >
              {change.isPending ? 'Saving…' : 'Change password'}
            </Button>
          </div>
        </form>
      </Panel>
    </>
  );
}
