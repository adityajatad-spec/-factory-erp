import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { Badge } from '../display';
import { IconMenu, IconSearch } from '../icons';
import { CommandPalette } from './command-palette';
import { NAV } from './nav';

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const can = useCan();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="flex h-full flex-col gap-4 px-2 py-3" aria-label="Main">
      {NAV.map((group) => {
        const items = group.items.filter((i) => can(i.permission));
        if (items.length === 0) return null;
        return (
          <div key={group.section ?? 'root'}>
            {group.section && (
              <p className="px-2 pb-1 text-[10px] font-semibold tracking-widest text-slate-500 uppercase">
                {group.section}
              </p>
            )}
            <ul className="space-y-0.5">
              {items.map((item) => {
                const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      onClick={onNavigate}
                      className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${
                        active
                          ? 'bg-slate-800 font-medium text-white'
                          : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
                      }`}
                    >
                      <Icon />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function AppShell() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const logout = useMutation({
    mutationFn: () => api.post<void>('/auth/logout'),
    onSettled: async () => {
      queryClient.clear();
      await navigate({ to: '/login' });
    },
  });

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col bg-slate-900 md:flex">
        <Brand />
        <Sidebar />
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-slate-900/50"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="relative h-full w-64 bg-slate-900">
            <Brand />
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-slate-200 bg-white px-3 md:px-5">
          <button
            type="button"
            className="rounded p-1 text-slate-600 hover:bg-slate-100 md:hidden"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
          >
            <IconMenu />
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-800">
              {session.company.tradeName ?? session.company.legalName}
            </span>
            {session.company.isDemo && (
              <Badge tone="amber" title="All data in this company is synthetic demo data">
                Demo data
              </Badge>
            )}
          </div>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="ml-auto flex h-8 w-full max-w-72 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 text-sm text-slate-500 hover:border-slate-300"
          >
            <IconSearch />
            <span className="flex-1 text-left">Search or jump to…</span>
            <kbd className="hidden rounded border border-slate-300 px-1 font-mono text-[10px] sm:inline">
              Ctrl K
            </kbd>
          </button>
          <div className="flex items-center gap-2">
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-xs font-medium text-slate-800">{session.displayName}</p>
              <p className="text-[10px] text-slate-500">{session.roles.join(', ')}</p>
            </div>
            <button
              type="button"
              onClick={() => logout.mutate()}
              className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-3 py-4 md:px-6">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

function Brand() {
  return (
    <div className="flex h-12 items-center gap-2 border-b border-slate-800 px-4">
      <img src="/favicon.svg" alt="" className="h-6 w-6" />
      <span className="text-sm font-semibold tracking-wide text-white">Factory ERP</span>
    </div>
  );
}
