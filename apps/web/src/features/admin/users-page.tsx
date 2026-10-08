import {
  ROLE_CODES,
  type CreateUserRequest,
  type ResetPasswordRequest,
  type RoleCode,
  type SetUserRolesRequest,
  type UserDto,
} from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import {
  Badge,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Panel,
  Spinner,
  Table,
  td,
  tdNum,
  th,
} from '../../components/display';
import { Field, Input } from '../../components/field';
import { IconPlus } from '../../components/icons';
import { api, ApiError } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { generatePassword } from '../../lib/password';
import { useSession } from '../../lib/session';

/** What each role is for (the permissions themselves are fixed in code and enforced by the server). */
const ROLES: Record<RoleCode, { label: string; hint: string }> = {
  OWNER: { label: 'Owner', hint: 'Everything, including managing other owners' },
  ADMIN: { label: 'Administrator', hint: 'Everything except managing owners' },
  ACCOUNTANT: { label: 'Accountant', hint: 'Invoices, corrections, receipts, customers' },
  PRODUCTION_MANAGER: { label: 'Production manager', hint: 'Items and stock' },
  PURCHASE_MANAGER: { label: 'Purchase manager', hint: 'Suppliers, items and stock' },
  HR: { label: 'HR', hint: 'No HR screens yet' },
  SUPERVISOR: { label: 'Supervisor', hint: 'Items and stock' },
  WORKER: { label: 'Worker', hint: 'No worker screens yet' },
};

export function UsersPage() {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserDto | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserDto[]>('/users') });

  return (
    <>
      <PageHeader
        title="Users & roles"
        subtitle="Who can sign in, and what each person may do. Every change is audited."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus /> New user
          </Button>
        }
      />
      <Panel title={`${users.data?.length ?? 0} users`}>
        <ErrorBanner error={users.error} className="m-3" />
        {users.isPending ? (
          <Spinner />
        ) : users.data?.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>Username</th>
                <th className={th}>Name</th>
                <th className={th}>Roles</th>
                <th className={th}>Status</th>
                <th className={`${th} hidden md:table-cell`}>Last sign-in</th>
                <th className={`${th} text-right`}>Failed (24 h)</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <tr
                  key={u.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => setEditing(u)}
                  title="Manage"
                >
                  <td className={`${td} font-mono text-xs`}>{u.username}</td>
                  <td className={`${td} font-medium`}>{u.displayName}</td>
                  <td className={td}>
                    <span className="flex flex-wrap gap-1">
                      {u.roles.map((r) => (
                        <Badge key={r} tone={r === 'OWNER' ? 'blue' : 'neutral'}>
                          {ROLES[r].label}
                        </Badge>
                      ))}
                    </span>
                  </td>
                  <td className={td}>
                    <span className="flex flex-wrap gap-1">
                      {u.status === 'ACTIVE' ? (
                        <Badge tone="green">Active</Badge>
                      ) : (
                        <Badge tone="red">Deactivated</Badge>
                      )}
                      {u.mustChangePassword && <Badge tone="amber">Temporary password</Badge>}
                    </span>
                  </td>
                  <td className={`${td} hidden text-slate-600 md:table-cell`}>
                    {u.lastSignInAt ? dateTime(u.lastSignInAt) : 'Never'}
                  </td>
                  <td
                    className={`${tdNum} ${u.failedSignInsLast24h ? 'font-semibold text-red-700' : 'text-slate-400'}`}
                  >
                    {u.failedSignInsLast24h}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No users" />
        )}
      </Panel>
      {creating && <NewUserDialog onClose={() => setCreating(false)} />}
      {editing && (
        <ManageUserDialog key={editing.id} user={editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function RolePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: RoleCode[];
  onChange: (roles: RoleCode[]) => void;
  disabled?: boolean;
}) {
  const session = useSession();
  const ownerAllowed = session.roles.includes('OWNER');
  return (
    <fieldset className="grid gap-1.5 sm:grid-cols-2" disabled={disabled}>
      <legend className="mb-1 text-xs font-medium text-slate-700">Roles</legend>
      {ROLE_CODES.map((r) => (
        <label key={r} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={value.includes(r)}
            disabled={r === 'OWNER' && !ownerAllowed}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))
            }
          />
          <span>
            {ROLES[r].label}
            <span className="block text-xs text-slate-500">{ROLES[r].hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function PasswordInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-2">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono"
        autoComplete="off"
      />
      <Button onClick={() => onChange(generatePassword())}>Generate</Button>
    </div>
  );
}

function NewUserDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roles, setRoles] = useState<RoleCode[]>([]);
  const [password, setPassword] = useState(generatePassword);
  const [created, setCreated] = useState<UserDto | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateUserRequest = { username, displayName, roles, initialPassword: password };
      return api.post<UserDto>('/users', body);
    },
    onSuccess: async (u) => {
      setCreated(u);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
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

  if (created) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={`${created.username} can now sign in`}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <p className="text-sm text-slate-700">
          Share this first password with {created.displayName} privately. They must choose their own
          when they first sign in. It is not shown again.
        </p>
        <p
          className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 text-center font-mono text-lg"
          data-testid="new-user-password"
        >
          {password}
        </p>
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="New user"
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="user-form" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create user'}
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Username"
          htmlFor="u-username"
          error={fieldError('username')}
          hint="Lower case, e.g. ravi or ravi.k"
        >
          <Input
            id="u-username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
          />
        </Field>
        <Field label="Full name" htmlFor="u-name" error={fieldError('displayName')}>
          <Input id="u-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <RolePicker value={roles} onChange={setRoles} />
          {fieldError('roles') && (
            <p className="mt-1 text-xs text-red-700">{fieldError('roles')}</p>
          )}
        </div>
        <Field
          label="First password"
          htmlFor="u-password"
          error={fieldError('initialPassword')}
          hint="At least 10 characters. They must change it at first sign-in."
        >
          <PasswordInput id="u-password" value={password} onChange={setPassword} />
        </Field>
        <ErrorBanner error={create.error} className="sm:col-span-2" />
      </form>
    </Dialog>
  );
}

function ManageUserDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const self = user.id === session.id;
  const ownerTarget = user.roles.includes('OWNER');
  const mayManage = !self && (!ownerTarget || session.roles.includes('OWNER'));
  const [roles, setRoles] = useState<RoleCode[]>(user.roles);
  const [temporary, setTemporary] = useState('');
  const [sharedPassword, setSharedPassword] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const saveRoles = useMutation({
    mutationFn: () => {
      const body: Omit<SetUserRolesRequest, 'userId'> = { expectedVersion: user.version, roles };
      return api.put<UserDto>(`/users/${user.id}/roles`, body);
    },
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const setStatus = useMutation({
    mutationFn: () =>
      api.post<UserDto>(
        `/users/${user.id}/${user.status === 'ACTIVE' ? 'deactivate' : 'reactivate'}`,
        { expectedVersion: user.version },
      ),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const reset = useMutation({
    mutationFn: () => {
      const body: Omit<ResetPasswordRequest, 'userId'> = {
        expectedVersion: user.version,
        temporaryPassword: temporary,
      };
      return api.post<UserDto>(`/users/${user.id}/reset-password`, body);
    },
    onSuccess: async () => {
      setSharedPassword(temporary);
      await refresh();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${user.displayName} (${user.username})`}
      wide
      footer={
        <>
          {mayManage && !sharedPassword && (
            <Button
              variant={user.status === 'ACTIVE' ? 'danger' : 'secondary'}
              className="mr-auto"
              onClick={() => setStatus.mutate()}
              disabled={setStatus.isPending}
            >
              {user.status === 'ACTIVE' ? 'Deactivate sign-in' : 'Reactivate sign-in'}
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
          {mayManage && !sharedPassword && (
            <Button
              variant="primary"
              onClick={() => saveRoles.mutate()}
              disabled={saveRoles.isPending || roles.length === 0}
            >
              {saveRoles.isPending ? 'Saving…' : 'Save roles'}
            </Button>
          )}
        </>
      }
    >
      {self && (
        <p className="mb-3 rounded bg-slate-50 p-2 text-sm text-slate-600">
          This is you. Another administrator manages your roles; change your own password from the
          menu.
        </p>
      )}
      {!self && !mayManage && (
        <p className="mb-3 rounded bg-slate-50 p-2 text-sm text-slate-600">
          Only an owner can manage an owner.
        </p>
      )}
      {sharedPassword ? (
        <>
          <p className="text-sm text-slate-700">
            {user.displayName} is signed out everywhere. Share this temporary password privately;
            they must choose their own at next sign-in.
          </p>
          <p
            className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 text-center font-mono text-lg"
            data-testid="reset-password"
          >
            {sharedPassword}
          </p>
        </>
      ) : (
        <div className="grid gap-4">
          <RolePicker value={roles} onChange={setRoles} disabled={!mayManage} />
          {mayManage && (
            <div className="rounded border border-slate-200 p-3">
              <p className="mb-2 text-sm font-medium text-slate-800">Reset password</p>
              <Field
                label="Temporary password"
                htmlFor="u-temp"
                hint="Signs them out everywhere; they must change it at next sign-in."
              >
                <PasswordInput id="u-temp" value={temporary} onChange={setTemporary} />
              </Field>
              <Button
                className="mt-2"
                onClick={() => reset.mutate()}
                disabled={reset.isPending || temporary.length < 10}
              >
                Set temporary password
              </Button>
            </div>
          )}
          <ErrorBanner error={saveRoles.error ?? setStatus.error ?? reset.error} />
        </div>
      )}
    </Dialog>
  );
}
