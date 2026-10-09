import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Dashboard } from '../lib/api';
import { fmtDate, fmtNum } from '../lib/format';
import { Card, Empty, ErrorText, PageHeader, Stat, StatusBadge } from '../components/ui';

export function DashboardPage() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/dashboard'), refetchInterval: 10_000 });
  const d = q.data;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Every number below is counted live from the database." />
      <ErrorText error={q.error} />
      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Stat label="Companies discovered" value={fmtNum(d.companiesDiscovered)} />
            <Stat label="Websites scanned" value={fmtNum(d.websitesScanned)} />
            <Stat label="Contacts found" value={fmtNum(d.contactsFound)} />
            <Stat label="Eligible contacts" value={fmtNum(d.eligibleContacts)} tone="blue" />
            <Stat label="Campaigns created" value={fmtNum(d.campaignsCreated)} />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Accepted by SMTP" value={fmtNum(d.acceptedBySmtp)} tone="green" hint="Live sends; not proof of delivery" />
            <Stat label="Confirmed delivered" value={fmtNum(d.confirmedDelivered)} tone="green" hint="Requires provider webhook" />
            <Stat label="Failed" value={fmtNum(d.failed)} tone="red" />
            <Stat label="Skipped" value={fmtNum(d.skipped)} tone="amber" />
            <Stat label="Pending" value={fmtNum(d.pending)} tone="blue" hint="Queued or processing" />
            <Stat label="Outcome unknown" value={fmtNum(d.unknown)} tone="amber" hint="Needs manual review" />
          </div>
          {d.simulated > 0 && <p className="text-xs text-violet-700">{fmtNum(d.simulated)} simulated test-mode messages are excluded from the sent counts.</p>}

          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="Contacts by type">
              {d.contactsByType.length === 0 ? (
                <p className="text-sm text-slate-500">No contacts yet.</p>
              ) : (
                <ul className="space-y-2">
                  {d.contactsByType.map((t) => {
                    const pct = Math.round((t.n / Math.max(1, d.contactsFound)) * 100);
                    return (
                      <li key={t.type} className="text-sm">
                        <div className="flex justify-between">
                          <span>{t.type}</span>
                          <span className="tabular-nums text-slate-500">{t.n}</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                          <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <Card title="Recent discovery runs" actions={<Link className="text-xs text-blue-600" to="/discover">Discover →</Link>}>
              {d.recentRuns.length === 0 ? (
                <Empty title="No runs yet">Start one from Discover Companies.</Empty>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {d.recentRuns.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                      <div>
                        <div className="font-medium">Run #{r.id}</div>
                        <div className="text-xs text-slate-500">
                          {r.companies_found} companies · {r.contacts_found} new contacts · {fmtDate(r.started_at)}
                        </div>
                      </div>
                      <StatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Recent campaigns" actions={<Link className="text-xs text-blue-600" to="/campaigns">All →</Link>}>
              {d.recentCampaigns.length === 0 ? (
                <Empty title="No campaigns yet">Select contacts to create one.</Empty>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {d.recentCampaigns.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                      <Link to={`/campaigns/${c.id}`} className="font-medium hover:text-blue-600">
                        {c.name}
                        {c.test_mode ? <span className="ml-1 text-xs text-violet-600">(test)</span> : null}
                      </Link>
                      <StatusBadge status={c.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
