import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Criteria, type DiscoveryRun, type ProviderStatus } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useSnapshotStream } from '../lib/useEventSource';
import { Alert, Button, Card, ErrorText, Field, PageHeader, ProgressBar, StatusBadge } from '../components/ui';

const DEFAULTS: Criteria = { country: 'India', state: '', city: '', industry: 'Software', keywords: '', maxCompanies: 25, maxPagesPerCompany: 6 };

function RunProgress({ run }: { run: DiscoveryRun }) {
  const live = useSnapshotStream<DiscoveryRun>(run.status === 'running' ? `/api/discovery/runs/${run.id}/events` : null);
  const r = live.data ?? run;
  const scanTotal = Math.max(r.companies_found, 1);
  return (
    <Card title={`Run #${r.id}`} actions={<StatusBadge status={r.status} />}>
      <div className="space-y-3 text-sm">
        <div className="text-slate-600">{r.current_step ?? '—'}</div>
        {r.status === 'running' && <ProgressBar value={(r.companies_scanned / scanTotal) * 100} />}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div><div className="label">Companies found</div><div className="text-lg font-semibold">{r.companies_found}</div></div>
          <div><div className="label">Sites scanned</div><div className="text-lg font-semibold">{r.companies_scanned}</div></div>
          <div><div className="label">New contacts</div><div className="text-lg font-semibold">{r.contacts_found}</div></div>
          <div><div className="label">Issues</div><div className="text-lg font-semibold">{r.error_count}</div></div>
        </div>
        <div className="text-xs text-slate-500">
          {[r.criteria.city, r.criteria.state, r.criteria.country].filter(Boolean).join(', ')} · {r.criteria.industry || 'any industry'}
          {r.criteria.keywords ? ` · “${r.criteria.keywords}”` : ''} · started {fmtDate(r.started_at)}
          {r.finished_at ? ` · finished ${fmtDate(r.finished_at)}` : ''}
        </div>
        {r.errors.length > 0 && (
          <details className="rounded-lg bg-slate-50 p-3">
            <summary className="cursor-pointer text-xs font-medium text-slate-600">Show {r.errors.length} issue(s)</summary>
            <ul className="mt-2 max-h-56 space-y-1 overflow-auto text-xs text-slate-600">
              {r.errors.map((e, i) => (
                <li key={i} className="break-all">• {e}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

export function DiscoverPage() {
  const qc = useQueryClient();
  const [c, setC] = useState<Criteria>(DEFAULTS);
  const [provider, setProvider] = useState<string>('');
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ active: string; providers: ProviderStatus[] }>('/discovery/providers') });
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: () => api<DiscoveryRun[]>('/discovery/runs'),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 3000 : false),
  });
  const active = runs.data?.find((r) => r.status === 'running');
  const chosen = provider || providers.data?.active || 'google_places';
  const chosenStatus = providers.data?.providers.find((p) => p.id === chosen);

  const start = useMutation({
    mutationFn: () => api<DiscoveryRun>('/discovery/runs', { body: { criteria: c, provider: chosen } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runs'] }),
  });
  const cancel = useMutation({
    mutationFn: (id: number) => api(`/discovery/runs/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runs'] }),
  });
  const set = <K extends keyof Criteria>(k: K, v: Criteria[K]) => setC((p) => ({ ...p, [k]: v }));

  return (
    <>
      <PageHeader title="Discover Companies" subtitle="Find companies through an official search API, then scan their public websites for published contacts." />
      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Discovery criteria" className="lg:col-span-2">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              start.mutate();
            }}
          >
            <Field label="Source">
              <select className="input" value={chosen} onChange={(e) => setProvider(e.target.value)}>
                {providers.data?.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.configured ? '' : ' — setup required'}
                  </option>
                ))}
              </select>
            </Field>
            {chosenStatus && !chosenStatus.configured && <Alert tone="warn" title="Setup required">{chosenStatus.message}</Alert>}
            {chosen === 'osm' && (
              <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                <p>
                  Free, no API key. Finds businesses tagged <code>office=it</code>, <code>office=software</code>, <code>office=company</code> or with
                  technology <code>company</code>/<code>industry</code> tags. Put <em>IT</em>, <em>software</em>, <em>technology</em> or <em>startups</em> in
                  Industry or Keywords to choose categories. OSM has no startup tag, so startups are matched by name or description.
                </p>
                <p>Many OSM records have no website. Only companies with a website are scanned for publicly listed emails.</p>
                <Button
                  className="px-2 py-1 text-xs"
                  onClick={() => setC({ ...c, country: 'India', state: 'Telangana', city: 'Hyderabad', industry: 'IT, software, technology', keywords: 'startups' })}
                >
                  Use preset: IT / software / tech / startups in Hyderabad
                </Button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Country">
                <input className="input" required value={c.country} onChange={(e) => set('country', e.target.value)} />
              </Field>
              <Field label="State">
                <input className="input" value={c.state} onChange={(e) => set('state', e.target.value)} placeholder="e.g. Karnataka" />
              </Field>
              <Field label={chosen === 'osm' ? 'City (required)' : 'City'}>
                <input className="input" required={chosen === 'osm'} value={c.city} onChange={(e) => set('city', e.target.value)} placeholder="e.g. Hyderabad" />
              </Field>
              <Field label="Industry">
                <input className="input" value={c.industry} onChange={(e) => set('industry', e.target.value)} />
              </Field>
            </div>
            <Field label="Search keywords" hint="Comma-separated; each keyword becomes its own search.">
              <input className="input" value={c.keywords} onChange={(e) => set('keywords', e.target.value)} placeholder="software company, IT services, SaaS" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max companies">
                <input className="input" type="number" min={1} max={500} value={c.maxCompanies} onChange={(e) => set('maxCompanies', Number(e.target.value))} />
              </Field>
              <Field label="Max pages / company">
                <input className="input" type="number" min={1} max={20} value={c.maxPagesPerCompany} onChange={(e) => set('maxPagesPerCompany', Number(e.target.value))} />
              </Field>
            </div>
            <ErrorText error={start.error} />
            {chosen === 'osm' && !c.city.trim() && (
              <p className="text-xs text-amber-700">
                Enter a city. OpenStreetMap can't search a whole country or state; the free public service times out.
              </p>
            )}
            <Button
              variant="primary"
              type="submit"
              className="w-full"
              disabled={start.isPending || Boolean(active) || chosenStatus?.configured === false || (chosen === 'osm' && !c.city.trim())}
            >
              {active ? 'A run is in progress…' : start.isPending ? 'Starting…' : 'Start discovery'}
            </Button>
            <p className="text-xs text-slate-500">
              Only public pages are fetched. robots.txt is honoured, requests are rate-limited per site, and logins, CAPTCHAs or other access controls are never bypassed.
            </p>
          </form>
        </Card>
        <div className="space-y-4 lg:col-span-3">
          {active && (
            <div className="flex justify-end">
              <Button variant="danger" onClick={() => cancel.mutate(active.id)} disabled={cancel.isPending}>
                Stop run (keeps results)
              </Button>
            </div>
          )}
          {runs.data?.length === 0 && <Alert>No discovery runs yet. Configure criteria and start one.</Alert>}
          {runs.data?.slice(0, 6).map((r) => <RunProgress key={`${r.id}-${r.status}`} run={r} />)}
          {(runs.data?.length ?? 0) > 0 && (
            <p className="text-sm text-slate-500">
              Results appear under <Link className="text-blue-600" to="/companies">Companies</Link> and <Link className="text-blue-600" to="/contacts">Contacts</Link>.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
