import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api, setToken, type SettingsView } from '../lib/api';
import { useSelection } from '../lib/selection';
import { Button, cx } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: 'M3 12l9-9 9 9M5 10v10h14V10' },
  { to: '/discover', label: 'Discover Companies', icon: 'M11 4a7 7 0 100 14 7 7 0 000-14zm10 17l-5-5' },
  { to: '/companies', label: 'Companies', icon: 'M4 21V5a2 2 0 012-2h8a2 2 0 012 2v16M16 9h2a2 2 0 012 2v10M8 7h4M8 11h4M8 15h4M3 21h18' },
  { to: '/contacts', label: 'Contacts', icon: 'M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21a8 8 0 0116 0' },
  { to: '/templates', label: 'Email Templates', icon: 'M4 6h16v12H4zM4 7l8 6 8-6' },
  { to: '/campaigns', label: 'Campaigns', icon: 'M3 11l18-8-8 18-2-8-8-2z' },
  { to: '/history', label: 'Sending History', icon: 'M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
  { to: '/settings', label: 'Settings', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z' },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function TokenGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener('applytick:unauthorized', h);
    return () => window.removeEventListener('applytick:unauthorized', h);
  }, []);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <form
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value.trim());
          window.location.reload();
        }}
      >
        <h2 className="text-lg font-semibold">Admin token required</h2>
        <p className="mt-1 text-sm text-slate-500">This server has ADMIN_TOKEN set. Enter it to continue (stored in this browser only).</p>
        <input className="input mt-4" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        <Button variant="primary" className="mt-4 w-full" type="submit">
          Continue
        </Button>
      </form>
    </div>
  );
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const loc = useLocation();
  const sel = useSelection();
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/settings'), refetchInterval: 30_000 });
  const rt = settings.data?.runtime;

  return (
    <div className="min-h-screen lg:flex">
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 w-64 border-r border-slate-200 bg-white transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 items-center gap-2 border-b border-slate-100 px-5">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <span className="text-base font-semibold tracking-tight">Smart Applytick</span>
        </div>
        <nav className="space-y-0.5 p-3">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100')
              }
            >
              <Icon d={n.icon} />
              {n.label}
              {n.to === '/contacts' && sel.ids.length > 0 && (
                <span className="ml-auto rounded-full bg-blue-600 px-2 py-0.5 text-xs text-white">{sel.ids.length}</span>
              )}
            </NavLink>
          ))}
        </nav>
        {rt && (
          <div className="absolute inset-x-3 bottom-3 space-y-2 text-xs">
            {rt.testMode && <div className="rounded-lg bg-violet-50 px-3 py-2 font-medium text-violet-700">Test mode — campaigns are simulated</div>}
            {rt.killSwitch && <div className="rounded-lg bg-red-50 px-3 py-2 font-medium text-red-700">Kill switch ON — sending halted</div>}
          </div>
        )}
      </aside>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={() => setMobileOpen(false)} />}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:hidden">
          <Button variant="ghost" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Icon d="M4 6h16M4 12h16M4 18h16" />
          </Button>
          <span className="font-semibold">Smart Applytick</span>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
      <TokenGate />
    </div>
  );
}
