import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Campaign, type Dashboard, type SettingsView } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorText, PageHeader, ProgressBar, StatusBadge, Table, cx, td, th } from '../components/ui';

function Check({ ok, warn, children }: { ok: boolean; warn?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span
        className={cx(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white',
          ok ? 'bg-emerald-500' : warn ? 'bg-amber-500' : 'bg-red-500',
        )}
      >
        {ok ? '✓' : '!'}
      </span>
      <span>{children}</span>
    </li>
  );
}

function SendingGuide() {
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/settings') });
  const d = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/dashboard') });
  if (!s.data || !d.data) return null;
  const rt = s.data.runtime;
  const smtp = s.data.smtp;
  const live = !rt.testMode && smtp.configured && !rt.killSwitch;
  return (
    <div className="mb-6 grid gap-6 lg:grid-cols-2">
      <Card title="How sending works">
        <ol className="space-y-3 text-sm">
          <li>
            <strong>1. New campaign</strong> — pick who to email (automatically: the best HR/recruiting contact at each company) and a template.
          </li>
          <li>
            <strong>2. Review</strong> — preview every personalized email; remove anyone you don't want.
          </li>
          <li>
            <strong>3. Approve</strong> — type the confirmation (e.g. <code>SEND 25</code>) so nothing goes out by accident.
          </li>
          <li>
            <strong>4. Start sending</strong> — emails go out one by one ({rt.sendRatePerMinute}/minute). Watch progress live; pause any time.
          </li>
        </ol>
        <Link to="/campaigns/new" className="mt-4 inline-block">
          <Button variant="primary">Start a new campaign</Button>
        </Link>
      </Card>
      <Card title={live ? 'Ready to send real emails' : 'Before real emails can be sent'}>
        <ul className="space-y-2.5">
          <Check ok={d.data.eligibleContacts > 0}>
            {d.data.eligibleContacts} eligible contact(s){d.data.eligibleContacts === 0 && <> — run <Link to="/discover" className="text-blue-600">Discover Companies</Link> first</>}
          </Check>
          <Check ok={smtp.configured}>
            {smtp.configured ? (
              <>Email account configured ({smtp.from})</>
            ) : (
              <>
                Email account not set up — in <code>.env</code> fill <code>SMTP_HOST</code>, <code>SMTP_USER</code>, <code>SMTP_PASSWORD</code>, <code>EMAIL_FROM</code>,{' '}
                <code>SENDER_NAME</code> (Gmail: smtp.gmail.com, port 465, SMTP_SECURE=true, an App Password), then restart.
              </>
            )}
          </Check>
          <Check ok={Boolean(rt.resumeUrl)} warn>
            {rt.resumeUrl ? 'Resume link set' : <>No resume link — add it in <Link to="/settings" className="text-blue-600">Settings</Link> for the “View My Resume” button</>}
          </Check>
          <Check ok={!rt.testMode} warn>
            {rt.testMode ? (
              <>
                Test mode is <strong>on</strong>: campaigns are simulated, nothing is sent. To send for real, set <code>EMAIL_TEST_MODE=false</code> in{' '}
                <code>.env</code> and restart — after sending yourself a test from Email Templates.
              </>
            ) : (
              'Test mode is off — approved campaigns send real email'
            )}
          </Check>
          <Check ok={!rt.killSwitch}>{rt.killSwitch ? 'Kill switch is ON — all sending blocked (Settings)' : 'Kill switch off'}</Check>
        </ul>
      </Card>
    </div>
  );
}

export function CampaignsPage() {
  const q = useQuery({ queryKey: ['campaigns'], queryFn: () => api<Campaign[]>('/campaigns'), refetchInterval: 5000 });
  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle="Each campaign sends separate, individual emails — only after you approve and start it."
        actions={
          <Link to="/campaigns/new">
            <Button variant="primary">New campaign</Button>
          </Link>
        }
      />
      <SendingGuide />
      <ErrorText error={q.error} />
      {q.data?.length === 0 ? (
        <Empty title="No campaigns yet">Click “New campaign” to pick recipients and a template.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Campaign</th>
              <th className={th}>Status</th>
              <th className={th}>Recipients</th>
              <th className={th}>Sent</th>
              <th className={th}>Failed</th>
              <th className={th}>Skipped</th>
              <th className={th}>Progress</th>
              <th className={th}>Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {q.data?.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className={td}>
                  <Link to={`/campaigns/${c.id}`} className="font-medium text-blue-700 hover:underline">
                    {c.name}
                  </Link>
                  {c.test_mode ? (
                    <span className="ml-2">
                      <Badge color="violet">test</Badge>
                    </span>
                  ) : null}
                  <div className="text-xs text-slate-500">{c.template_name}</div>
                </td>
                <td className={td}>
                  <StatusBadge status={c.status} />
                </td>
                <td className={`${td} tabular-nums`}>{c.counts?.total}</td>
                <td className={`${td} tabular-nums text-emerald-700`}>{(c.counts?.accepted ?? 0) + (c.counts?.delivered ?? 0) + (c.counts?.simulated ?? 0)}</td>
                <td className={`${td} tabular-nums text-red-700`}>{(c.counts?.failed ?? 0) + (c.counts?.bounced ?? 0)}</td>
                <td className={`${td} tabular-nums text-amber-700`}>{c.counts?.skipped}</td>
                <td className={`${td} w-40`}>
                  <ProgressBar value={c.counts?.progress ?? 0} tone={c.status === 'completed' ? 'green' : 'blue'} />
                  <div className="mt-1 text-xs text-slate-500">{c.counts?.progress ?? 0}%</div>
                </td>
                <td className={`${td} whitespace-nowrap text-slate-500`}>{fmtDate(c.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
