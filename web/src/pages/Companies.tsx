import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs, withToken, type Company, type Eligibility, type Paged } from '../lib/api';
import { fmtDate, location } from '../lib/format';
import { Badge, Button, Card, ConfidencePill, Empty, ErrorText, PageHeader, Pagination, StatusBadge, Table, td, th } from '../components/ui';

interface CompanyDetail {
  company: Company & { address: string | null };
  contacts: {
    id: number;
    email: string;
    name: string | null;
    role_title: string | null;
    contact_type: string;
    confidence: number;
    confidence_explanation: string;
    eligibility: Eligibility;
  }[];
  sources: { provider: string; provider_ref: string; source_url: string | null; created_at: string }[];
}

function CompanyDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['company', id], queryFn: () => api<CompanyDetail>(`/companies/${id}`) });
  const d = q.data;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">{d?.company.name ?? 'Loading…'}</h2>
            {d?.company.website_url && (
              <a href={d.company.website_url} target="_blank" rel="noreferrer noopener" className="text-sm text-blue-600 hover:underline">
                {d.company.website_url}
              </a>
            )}
          </div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <ErrorText error={q.error} />
        {d && (
          <div className="space-y-5 text-sm">
            <dl className="grid grid-cols-2 gap-3">
              <div><dt className="label">Status</dt><dd><StatusBadge status={d.company.discovery_status} /></dd></div>
              <div><dt className="label">Last scan</dt><dd>{fmtDate(d.company.last_scanned_at)}</dd></div>
              <div><dt className="label">Location</dt><dd>{location(d.company)}</dd></div>
              <div><dt className="label">Industry</dt><dd>{d.company.industry ?? '—'}</dd></div>
              <div className="col-span-2"><dt className="label">Address</dt><dd>{d.company.address ?? '—'}</dd></div>
              <div><dt className="label">Pages scanned</dt><dd>{d.company.pages_scanned}</dd></div>
              <div>
                <dt className="label">Source</dt>
                <dd className="space-x-2">
                  {d.sources.length === 0
                    ? '—'
                    : d.sources.map((s) =>
                        s.source_url ? (
                          <a key={s.provider_ref} href={s.source_url} target="_blank" rel="noreferrer noopener" className="text-blue-600 hover:underline">
                            {s.provider === 'osm' ? 'View on OpenStreetMap' : s.provider}
                          </a>
                        ) : (
                          <span key={s.provider_ref}>{s.provider}</span>
                        ),
                      )}
                </dd>
              </div>
            </dl>
            {d.company.scan_error && (
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                <div className="mb-1 font-medium">Scan notes</div>
                {d.company.scan_error}
              </div>
            )}
            <div>
              <h3 className="mb-2 font-semibold">Contacts ({d.contacts.length})</h3>
              {d.contacts.length === 0 ? (
                <p className="text-slate-500">No publicly displayed email addresses were found.</p>
              ) : (
                <ul className="space-y-3">
                  {d.contacts.map((c) => (
                    <li key={c.id} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{c.email}</span>
                        <Badge color="blue">{c.contact_type}</Badge>
                        <ConfidencePill value={c.confidence} />
                        <StatusBadge status={c.eligibility} />
                      </div>
                      {(c.name || c.role_title) && <div className="mt-1 text-slate-600">{[c.name, c.role_title].filter(Boolean).join(' — ')}</div>}
                      <ul className="mt-2 list-disc pl-5 text-xs text-slate-500">
                        {(JSON.parse(c.confidence_explanation) as string[]).map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
              {d.contacts.length > 0 && (
                <Link to={`/contacts?companyId=${id}`} className="mt-3 inline-block text-blue-600">
                  Open in Contacts to select →
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const STATUSES = ['', 'scanned', 'discovered', 'no_website', 'invalid_website', 'blocked_robots', 'scan_failed'];

export function CompaniesPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [f, setF] = useState({ q: '', status: '', location: '', industry: '', page: 1 });
  const q = useQuery({
    queryKey: ['companies', f],
    queryFn: () => api<Paged<Company>>(`/companies${qs({ ...f, pageSize: 25 })}`),
    placeholderData: keepPreviousData,
  });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v, page: 1 }));

  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="Companies found by discovery runs and the outcome of each website scan."
        actions={
          <a href={withToken('/api/export/companies.xlsx')}>
            <Button>Export Excel</Button>
          </a>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input className="input" placeholder="Search name or domain" value={f.q} onChange={(e) => set('q', e.target.value)} />
          <input className="input" placeholder="City, state or country" value={f.location} onChange={(e) => set('location', e.target.value)} />
          <input className="input" placeholder="Industry" value={f.industry} onChange={(e) => set('industry', e.target.value)} />
          <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s ? s.replace(/_/g, ' ') : 'Any status'}
              </option>
            ))}
          </select>
        </div>
      </Card>
      <ErrorText error={q.error} />
      {q.data && q.data.total === 0 ? (
        <Empty title="No companies match">Run a discovery to populate this list.</Empty>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th className={th}>Company</th>
                <th className={th}>Website</th>
                <th className={th}>Location</th>
                <th className={th}>Industry</th>
                <th className={th}>Contacts</th>
                <th className={th}>Status</th>
                <th className={th}>Last scan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {q.data?.items.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/companies/${c.id}`)}>
                  <td className={`${td} font-medium`}>{c.name}</td>
                  <td className={`${td} text-slate-600`}>{c.domain ?? '—'}</td>
                  <td className={td}>{location(c)}</td>
                  <td className={td}>{c.industry ?? '—'}</td>
                  <td className={`${td} tabular-nums`}>{c.contact_count}</td>
                  <td className={td}>
                    <StatusBadge status={c.discovery_status} />
                  </td>
                  <td className={`${td} whitespace-nowrap text-slate-500`}>{fmtDate(c.last_scanned_at)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {q.data && <Pagination page={f.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => setF((x) => ({ ...x, page: p }))} />}
        </>
      )}
      {id && <CompanyDrawer id={Number(id)} onClose={() => nav('/companies')} />}
    </>
  );
}
