import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Campaign } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Badge, Button, Empty, ErrorText, PageHeader, ProgressBar, StatusBadge, Table, td, th } from '../components/ui';

export function CampaignsPage() {
  const q = useQuery({ queryKey: ['campaigns'], queryFn: () => api<Campaign[]>('/campaigns'), refetchInterval: 5000 });
  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle="Each campaign sends individual messages, only after you approve and start it."
        actions={
          <Link to="/contacts">
            <Button variant="primary">Select contacts</Button>
          </Link>
        }
      />
      <ErrorText error={q.error} />
      {q.data?.length === 0 ? (
        <Empty title="No campaigns yet">Select eligible contacts on the Contacts page, then create a campaign.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Campaign</th>
              <th className={th}>Status</th>
              <th className={th}>Recipients</th>
              <th className={th}>Accepted</th>
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
