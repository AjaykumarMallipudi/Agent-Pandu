import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type RuntimeSettings, type SettingsView } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Alert, Badge, Button, Card, ErrorText, Field, PageHeader } from '../components/ui';

interface Suppression {
  id: number;
  email: string;
  reason: string;
  source: string;
  created_at: string;
}
interface EventRow {
  id: number;
  type: string;
  message: string;
  created_at: string;
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-slate-500">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/settings') });
  const supp = useQuery({ queryKey: ['suppressions'], queryFn: () => api<Suppression[]>('/suppressions') });
  const events = useQuery({ queryKey: ['events'], queryFn: () => api<EventRow[]>('/events?limit=30') });
  const [form, setForm] = useState<RuntimeSettings | null>(null);
  const [newSupp, setNewSupp] = useState('');
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; error?: string; ms?: number } | null>(null);
  useEffect(() => {
    if (s.data && !form) setForm(s.data.runtime);
  }, [s.data, form]);

  const onSaved = (v: SettingsView) => {
    qc.setQueryData(['settings'], v);
    setForm(v.runtime);
  };
  const save = useMutation({
    mutationFn: (patch: Partial<RuntimeSettings>) => api<SettingsView>('/settings', { method: 'PUT', body: patch }),
    onSuccess: onSaved,
  });
  const verify = useMutation({
    mutationFn: () => api<{ ok: boolean; error?: string; ms?: number }>('/settings/smtp/verify', { method: 'POST' }),
    onSuccess: setVerifyResult,
  });
  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('resume', file);
      return api<SettingsView>('/settings/resume', { method: 'POST', form: fd });
    },
    onSuccess: onSaved,
  });
  const removeResume = useMutation({ mutationFn: () => api<SettingsView>('/settings/resume', { method: 'DELETE' }), onSuccess: onSaved });
  const addSupp = useMutation({
    mutationFn: (email: string) => api('/suppressions', { body: { email } }),
    onSuccess: () => {
      setNewSupp('');
      void qc.invalidateQueries({ queryKey: ['suppressions'] });
    },
  });
  const delSupp = useMutation({
    mutationFn: (id: number) => api(`/suppressions/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['suppressions'] }),
  });

  if (s.error) return <ErrorText error={s.error} />;
  if (!s.data || !form) return <p className="text-sm text-slate-500">Loading…</p>;
  const d = s.data;
  const rt = d.runtime;

  return (
    <>
      <PageHeader title="Settings" subtitle="Sending limits, safety switches and diagnostics. Secrets live only in the server's .env file." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Safety switches">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-medium">Test mode</div>
                <p className="text-sm text-slate-500">Campaign messages are fully built but never transmitted. Campaigns created in test mode always stay simulated.</p>
                {rt.testModeLockedByEnv && <Badge color="violet">Locked on by EMAIL_TEST_MODE in .env</Badge>}
              </div>
              <Button
                variant={rt.testMode ? 'primary' : 'secondary'}
                disabled={rt.testModeLockedByEnv || save.isPending}
                onClick={() => {
                  if (rt.testMode && !confirm('Turn OFF test mode? New campaigns will send real email after approval.')) return;
                  save.mutate({ testMode: !rt.testMode });
                }}
              >
                {rt.testMode ? 'On' : 'Off'}
              </Button>
            </div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-medium">Global kill switch</div>
                <p className="text-sm text-slate-500">Immediately stops all new SMTP submissions, including test emails. Queued messages stay queued.</p>
                {rt.killSwitchLockedByEnv && <Badge color="red">Locked on by SENDING_KILL_SWITCH in .env</Badge>}
              </div>
              <Button variant={rt.killSwitch ? 'danger' : 'secondary'} disabled={rt.killSwitchLockedByEnv || save.isPending} onClick={() => save.mutate({ killSwitch: !rt.killSwitch })}>
                {rt.killSwitch ? 'ON — sending halted' : 'Off'}
              </Button>
            </div>
          </div>
        </Card>

        <Card title="Sending limits">
          <form
            className="grid grid-cols-2 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const { maxRecipientsPerCampaign, sendRatePerMinute, sendDailyLimit, sendConcurrency, minConfidence } = form;
              save.mutate({ maxRecipientsPerCampaign, sendRatePerMinute, sendDailyLimit, sendConcurrency, minConfidence });
            }}
          >
            <Field label="Max recipients / campaign">
              <select className="input" value={form.maxRecipientsPerCampaign} onChange={(e) => setForm({ ...form, maxRecipientsPerCampaign: Number(e.target.value) as 50 | 100 })}>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </Field>
            <Field label="Min confidence to be eligible">
              <input className="input" type="number" min={0} max={100} value={form.minConfidence} onChange={(e) => setForm({ ...form, minConfidence: Number(e.target.value) })} />
            </Field>
            <Field label="Messages / minute" hint={`Hard cap from .env: ${d.limits.envRatePerMinute}`}>
              <input className="input" type="number" min={1} value={form.sendRatePerMinute} onChange={(e) => setForm({ ...form, sendRatePerMinute: Number(e.target.value) })} />
            </Field>
            <Field label="Messages / 24 h" hint={`Hard cap from .env: ${d.limits.envDailyLimit}`}>
              <input className="input" type="number" min={1} value={form.sendDailyLimit} onChange={(e) => setForm({ ...form, sendDailyLimit: Number(e.target.value) })} />
            </Field>
            <Field label="Concurrent submissions" hint={`Hard cap from .env: ${d.limits.envConcurrency}`}>
              <input className="input" type="number" min={1} max={10} value={form.sendConcurrency} onChange={(e) => setForm({ ...form, sendConcurrency: Number(e.target.value) })} />
            </Field>
            <div className="col-span-2 flex items-center gap-3">
              <Button variant="primary" type="submit" disabled={save.isPending}>
                Save limits
              </Button>
              <ErrorText error={save.error} />
            </div>
          </form>
        </Card>

        <Card title="SMTP (Nodemailer)" actions={<Button onClick={() => verify.mutate()} disabled={verify.isPending}>{verify.isPending ? 'Checking…' : 'Run diagnostics'}</Button>}>
          {!d.smtp.configured && <Alert tone="warn" title="Not configured">Missing in .env: {d.smtp.missing.join(', ')}</Alert>}
          <div className="mt-2 divide-y divide-slate-100">
            <Row k="Host" v={d.smtp.host || '—'} />
            <Row k="Port / TLS" v={`${d.smtp.port} / ${d.smtp.secure ? 'implicit TLS' : 'STARTTLS if offered'}`} />
            <Row k="User" v={d.smtp.user || '—'} />
            <Row k="From" v={d.smtp.senderName ? `${d.smtp.senderName} <${d.smtp.from}>` : d.smtp.from || '—'} />
            <Row k="Test address" v={d.smtp.testAddress || '— (set TEST_EMAIL_ADDRESS)'} />
            <Row k="Password" v="never shown" />
          </div>
          {verifyResult && (
            <div className="mt-3">
              <Alert tone={verifyResult.ok ? 'success' : 'error'}>
                {verifyResult.ok ? `Connected and authenticated in ${verifyResult.ms} ms. Nothing was sent.` : `Diagnostics failed: ${verifyResult.error}`}
              </Alert>
            </div>
          )}
        </Card>

        <Card title="Company discovery source">
          <div className="space-y-3">
            {d.discovery.providers.map((p) => (
              <div key={p.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{p.label}</span>
                  <span className="flex gap-1">
                    {p.id === d.discovery.active.id && <Badge color="blue">default</Badge>}
                    <Badge color={p.configured ? 'green' : 'amber'}>{p.configured ? 'configured' : 'setup required'}</Badge>
                  </span>
                </div>
                <p className="mt-1 text-slate-500">{p.message}</p>
              </div>
            ))}
            <div className="text-xs text-slate-500">
              Crawler: {d.crawl.concurrency} sites in parallel, {d.crawl.hostDelayMs} ms between requests per site, {d.crawl.timeoutMs / 1000}s timeout, max{' '}
              {Math.round(d.crawl.maxBytes / 1000)} KB/page, {d.crawl.maxRedirects} redirects, MX check {d.crawl.checkMx ? 'on' : 'off'}.
            </div>
          </div>
        </Card>

        <Card title="Resume attachment">
          <div className="space-y-3 text-sm">
            {d.resume.uploaded ? (
              <p>
                Resume PDF uploaded ({Math.round((d.resume.size ?? 0) / 1024)} KB, {fmtDate(d.resume.updatedAt)}).
              </p>
            ) : (
              <p className="text-slate-500">No resume uploaded. Templates with “Attach resume” need one.</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="file"
                accept="application/pdf"
                className="text-sm"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                  e.target.value = '';
                }}
              />
              {d.resume.uploaded && (
                <Button variant="ghost" onClick={() => removeResume.mutate()}>
                  Remove
                </Button>
              )}
            </div>
            <ErrorText error={upload.error} />
          </div>
        </Card>

        <Card title="Security & compliance">
          <div className="divide-y divide-slate-100">
            <Row k="Bound to" v={d.security.host} />
            <Row k="Network exposure" v={d.security.loopbackOnly ? <Badge color="green">localhost only</Badge> : <Badge color="amber">network-reachable</Badge>} />
            <Row k="Admin token" v={d.security.adminTokenSet ? 'set' : 'not set'} />
            <Row k="Unsubscribe links" v={d.publicBaseUrl ? d.publicBaseUrl : 'reply-to-unsubscribe only (set PUBLIC_BASE_URL for links)'} />
          </div>
        </Card>

        <Card title={`Suppression list (${supp.data?.length ?? 0})`} className="lg:col-span-2">
          <form
            className="mb-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newSupp.trim()) addSupp.mutate(newSupp.trim());
            }}
          >
            <input className="input max-w-sm" placeholder="email@company.com" value={newSupp} onChange={(e) => setNewSupp(e.target.value)} />
            <Button type="submit">Suppress</Button>
          </form>
          <ErrorText error={addSupp.error} />
          <p className="mb-2 text-xs text-slate-500">Add anyone who replies “unsubscribe”. Suppressed addresses can never be selected or sent to.</p>
          <ul className="max-h-72 divide-y divide-slate-100 overflow-auto text-sm">
            {supp.data?.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{x.email}</span> <span className="text-xs text-slate-500">· {x.source} · {x.reason} · {fmtDate(x.created_at)}</span>
                </span>
                <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => confirm(`Remove ${x.email} from suppression?`) && delSupp.mutate(x.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Recent activity" className="lg:col-span-2">
          <ul className="max-h-72 divide-y divide-slate-100 overflow-auto text-sm">
            {events.data?.map((e) => (
              <li key={e.id} className="flex justify-between gap-3 py-1.5">
                <span>
                  <span className="font-mono text-xs text-slate-500">{e.type}</span> {e.message}
                </span>
                <span className="whitespace-nowrap text-xs text-slate-400">{fmtDate(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
