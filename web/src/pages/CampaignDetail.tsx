import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, withToken, type CampaignMessage, type CampaignSnapshot } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useSnapshotStream } from '../lib/useEventSource';
import { Alert, Badge, Button, Card, ErrorText, HtmlPreview, PageHeader, ProgressBar, Stat, StatusBadge, Table, cx, td, th } from '../components/ui';

interface FullMessage {
  id: number;
  email: string;
  recipient_name: string | null;
  company_name: string | null;
  subject: string;
  html: string;
  text: string;
  status: string;
}

function Preview({ campaignId, message }: { campaignId: number; message: CampaignMessage }) {
  const [view, setView] = useState<'html' | 'text'>('html');
  const q = useQuery({ queryKey: ['message', campaignId, message.id], queryFn: () => api<FullMessage>(`/campaigns/${campaignId}/messages/${message.id}`) });
  return (
    <Card
      title="Personalized preview"
      actions={
        <div className="flex gap-1">
          {(['html', 'text'] as const).map((v) => (
            <Button key={v} variant={view === v ? 'primary' : 'ghost'} className="px-2 py-1 text-xs" onClick={() => setView(v)}>
              {v === 'html' ? 'HTML' : 'Plain text'}
            </Button>
          ))}
        </div>
      }
    >
      {q.data && (
        <div className="space-y-2 text-sm">
          <div className="grid gap-1 rounded-lg bg-slate-50 p-3">
            <div><span className="text-slate-500">To: </span><span className="font-medium">{q.data.email}</span> <span className="text-xs text-slate-400">(only this address — no other recipients are visible)</span></div>
            <div><span className="text-slate-500">Subject: </span><span className="font-medium">{q.data.subject}</span></div>
          </div>
          {view === 'html' ? (
            <HtmlPreview html={q.data.html} />
          ) : (
            <pre className="h-[560px] overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 p-4 font-mono text-xs">{q.data.text}</pre>
          )}
        </div>
      )}
    </Card>
  );
}

const SENDING_STATES = ['sending', 'paused', 'completed', 'cancelled'];

export function CampaignDetailPage() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const initial = useQuery({ queryKey: ['campaign', id], queryFn: () => api<CampaignSnapshot>(`/campaigns/${id}`) });
  const live = useSnapshotStream<CampaignSnapshot>(`/api/campaigns/${id}/events`);
  const snap = live.data ?? initial.data;
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    if (!selected && snap?.messages.length) setSelected((snap.messages.find((m) => m.status === 'draft') ?? snap.messages[0]!).id);
  }, [snap, selected]);

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api<CampaignSnapshot>(`/campaigns/${id}/${path}`, { method: 'POST', body }),
    onSuccess: (s) => {
      qc.setQueryData(['campaign', id], s);
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const exclude = useMutation({
    mutationFn: ({ mid, excluded }: { mid: number; excluded: boolean }) =>
      api<CampaignSnapshot>(`/campaigns/${id}/messages/${mid}`, { method: 'PATCH', body: { excluded } }),
    onSuccess: (s) => qc.setQueryData(['campaign', id], s),
  });
  const resolve = useMutation({
    mutationFn: ({ mid, outcome }: { mid: number; outcome: 'accepted' | 'failed' }) => api<CampaignSnapshot>(`/campaigns/${id}/messages/${mid}/resolve`, { body: { outcome } }),
  });

  if (initial.error) return <ErrorText error={initial.error} />;
  if (!snap) return <p className="text-sm text-slate-500">Loading…</p>;
  const { campaign: c, counts } = snap;
  const isDraft = c.status === 'draft';
  const sendable = counts.draft;
  const phrase = `SEND ${sendable}`;
  const selectedMsg = snap.messages.find((m) => m.id === selected) ?? null;
  const rows = statusFilter ? snap.messages.filter((m) => m.status === statusFilter) : snap.messages;
  const accepted = counts.accepted + counts.delivered + counts.bounced;

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} />
            {snap.testMode && <Badge color="violet">Test mode — simulated</Badge>}
            {snap.killSwitch && <Badge color="red">Kill switch on</Badge>}
            <span>Template: {c.template_name ?? '—'}</span>
            {c.position && <span>· Position: {c.position}</span>}
            <span className={cx('text-xs', live.connected ? 'text-emerald-600' : 'text-slate-400')}>● {live.connected ? 'live' : 'connecting…'}</span>
          </span>
        }
        actions={
          <>
            {c.status === 'approved' && (
              <Button variant="success" disabled={act.isPending || snap.killSwitch} onClick={() => act.mutate({ path: 'start' })}>
                Start sending
              </Button>
            )}
            {c.status === 'sending' && (
              <Button onClick={() => act.mutate({ path: 'pause' })} disabled={act.isPending}>
                Pause
              </Button>
            )}
            {c.status === 'paused' && (
              <Button variant="primary" onClick={() => act.mutate({ path: 'resume' })} disabled={act.isPending}>
                Resume
              </Button>
            )}
            {['draft', 'approved', 'paused'].includes(c.status) && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (confirm('Cancel this campaign? Unsent messages will be skipped.')) act.mutate({ path: 'cancel' });
                }}
              >
                Cancel campaign
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-6">
        <ErrorText error={act.error ?? exclude.error ?? resolve.error} />
        {c.paused_reason && c.status === 'paused' && <Alert tone="warn" title="Paused">{c.paused_reason}</Alert>}

        {SENDING_STATES.includes(c.status) || c.status === 'approved' ? (
          <Card title="Progress">
            <div className="mb-4">
              <div className="mb-1 flex justify-between text-sm">
                <span>{counts.progress}% processed</span>
                <span className="text-slate-500">
                  Started {fmtDate(c.started_at)} · Ended {fmtDate(c.completed_at)}
                </span>
              </div>
              <ProgressBar value={counts.progress} tone={c.status === 'completed' ? 'green' : 'blue'} />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
              <Stat label="Total" value={counts.total} />
              <Stat label="Queued" value={counts.queued} tone="blue" />
              <Stat label="Processing" value={counts.processing} tone="blue" />
              {snap.testMode ? <Stat label="Simulated" value={counts.simulated} tone="violet" /> : <Stat label="Accepted by SMTP" value={accepted} tone="green" />}
              <Stat label="Confirmed delivered" value={counts.delivered} tone="green" hint="Needs provider evidence" />
              <Stat label="Failed" value={counts.failed + counts.bounced} tone="red" />
              <Stat label="Skipped" value={counts.skipped} tone="amber" />
              <Stat label="Unknown" value={counts.unknown} tone="amber" />
            </div>
          </Card>
        ) : null}

        {isDraft && (
          <Card title="Review & approve">
            <div className="space-y-3 text-sm">
              <p>
                <strong>{sendable}</strong> message(s) will be sent individually{snap.testMode ? ' in test mode (simulated, nothing transmitted)' : ''}.
                {counts.skipped > 0 && ` ${counts.skipped} recipient(s) were skipped automatically (see reasons below).`}
                {counts.excluded > 0 && ` ${counts.excluded} excluded by you.`}
              </p>
              <p className="text-slate-600">Preview each recipient below and exclude anyone who should not receive this message. To approve, type <code className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold">{phrase}</code>.</p>
              <div className="flex flex-wrap gap-2">
                <input className="input max-w-xs" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={phrase} />
                <Button
                  variant="primary"
                  disabled={confirmText.trim() !== phrase || sendable === 0 || act.isPending}
                  onClick={() => act.mutate({ path: 'approve', body: { confirm: true, recipientCount: sendable } })}
                >
                  Approve campaign
                </Button>
              </div>
            </div>
          </Card>
        )}
        {c.status === 'approved' && (
          <Alert tone="success" title="Approved">
            Approved {fmtDate(c.approved_at)}. Press <strong>Start sending</strong> when ready. You can pause at any time.
          </Alert>
        )}

        <div className="grid gap-6 xl:grid-cols-5">
          <div className="xl:col-span-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-700">Recipients ({snap.messages.length})</h2>
              <div className="flex gap-2">
                <select className="input py-1 text-xs" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">All statuses</option>
                  {Object.entries(counts)
                    .filter(([k, v]) => !['total', 'finished', 'progress'].includes(k) && v > 0)
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {k} ({v})
                      </option>
                    ))}
                </select>
                <a href={withToken('/api/export/campaign-history.xlsx')}>
                  <Button className="py-1 text-xs">Export</Button>
                </a>
              </div>
            </div>
            <Table>
              <thead>
                <tr>
                  <th className={th}>Recipient</th>
                  <th className={th}>Status</th>
                  <th className={th}>Result</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((m) => (
                  <tr key={m.id} className={cx('cursor-pointer', selected === m.id ? 'bg-blue-50/70' : 'hover:bg-slate-50')} onClick={() => setSelected(m.id)}>
                    <td className={td}>
                      <div className="break-all font-medium">{m.email}</div>
                      <div className="text-xs text-slate-500">
                        {[m.recipient_name, m.company_name].filter(Boolean).join(' · ')} {m.contact_type ? `· ${m.contact_type}` : ''}
                      </div>
                    </td>
                    <td className={td}>
                      <StatusBadge status={m.status} />
                      {m.attempts > 1 && <div className="mt-1 text-xs text-slate-400">{m.attempts} attempts</div>}
                    </td>
                    <td className={`${td} max-w-xs text-xs text-slate-600`}>
                      {m.error_message ?? m.smtp_response ?? '—'}
                      {m.processed_at && <div className="text-slate-400">{fmtDate(m.processed_at)}</div>}
                    </td>
                    <td className={td} onClick={(e) => e.stopPropagation()}>
                      {isDraft && m.status === 'draft' && (
                        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => exclude.mutate({ mid: m.id, excluded: true })}>
                          Exclude
                        </Button>
                      )}
                      {isDraft && m.status === 'excluded' && (
                        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => exclude.mutate({ mid: m.id, excluded: false })}>
                          Include
                        </Button>
                      )}
                      {m.status === 'unknown' && (
                        <div className="flex flex-col gap-1">
                          <Button className="px-2 py-1 text-xs" title="You confirmed it is in your Sent folder" onClick={() => resolve.mutate({ mid: m.id, outcome: 'accepted' })}>
                            Mark sent
                          </Button>
                          <Button className="px-2 py-1 text-xs" title="You confirmed it was not sent" onClick={() => resolve.mutate({ mid: m.id, outcome: 'failed' })}>
                            Mark not sent
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <div className="xl:col-span-2">{selectedMsg && <Preview campaignId={id} message={selectedMsg} />}</div>
        </div>
        <p className="text-xs text-slate-500">
          “Accepted by SMTP” means your mail server took the message; it does not prove inbox delivery. “Unknown” means the connection failed mid-submission — it is never retried
          automatically; check your Sent folder and resolve it. <Link to="/history" className="text-blue-600">Sending history →</Link>
        </p>
      </div>
    </>
  );
}
