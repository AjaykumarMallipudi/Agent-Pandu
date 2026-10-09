import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, withToken, type Paged } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorText, PageHeader, Pagination, StatusBadge, Table, td, th } from '../components/ui';

interface HistoryRow {
  id: number;
  campaign_id: number;
  campaign_name: string;
  test_mode: number;
  email: string;
  recipient_name: string | null;
  company_name: string | null;
  subject: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  processed_at: string | null;
  smtp_response: string | null;
}

const STATUSES = ['', 'accepted', 'delivered', 'simulated', 'queued', 'processing', 'failed', 'bounced', 'skipped', 'unknown'];

export function HistoryPage() {
  const [f, setF] = useState({ q: '', status: '', page: 1 });
  const q = useQuery({
    queryKey: ['history', f],
    queryFn: () => api<Paged<HistoryRow>>(`/history${qs({ ...f, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
  return (
    <>
      <PageHeader
        title="Sending History"
        subtitle="Every message submitted, skipped or failed, across all campaigns."
        actions={
          <a href={withToken('/api/export/campaign-history.xlsx')}>
            <Button>Export Excel</Button>
          </a>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <input className="input" placeholder="Recipient, company or campaign" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} />
          <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || 'Any status'}
              </option>
            ))}
          </select>
        </div>
      </Card>
      <ErrorText error={q.error} />
      {q.data?.total === 0 ? (
        <Empty title="Nothing sent yet" />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th className={th}>When</th>
                <th className={th}>Recipient</th>
                <th className={th}>Campaign</th>
                <th className={th}>Subject</th>
                <th className={th}>Status</th>
                <th className={th}>Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {q.data?.items.map((m) => (
                <tr key={m.id}>
                  <td className={`${td} whitespace-nowrap text-slate-500`}>{fmtDate(m.processed_at)}</td>
                  <td className={td}>
                    <div className="break-all font-medium">{m.email}</div>
                    <div className="text-xs text-slate-500">{m.company_name}</div>
                  </td>
                  <td className={td}>
                    <Link to={`/campaigns/${m.campaign_id}`} className="text-blue-700 hover:underline">
                      {m.campaign_name}
                    </Link>
                    {m.test_mode ? (
                      <span className="ml-1">
                        <Badge color="violet">test</Badge>
                      </span>
                    ) : null}
                  </td>
                  <td className={`${td} max-w-xs truncate`} title={m.subject}>
                    {m.subject}
                  </td>
                  <td className={td}>
                    <StatusBadge status={m.status} />
                  </td>
                  <td className={`${td} max-w-sm text-xs text-slate-600`}>
                    {m.error_code && <span className="font-mono">{m.error_code} </span>}
                    {m.error_message ?? m.smtp_response ?? '—'}
                    {m.attempts > 1 && <div className="text-slate-400">{m.attempts} attempts</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {q.data && <Pagination page={f.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => setF({ ...f, page: p })} />}
        </>
      )}
    </>
  );
}
