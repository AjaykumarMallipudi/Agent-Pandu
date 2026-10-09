import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, CONTACT_TYPES, qs, withToken, type Contact, type Evidence, type Paged, type SettingsView } from '../lib/api';
import { fmtDate, location } from '../lib/format';
import { useSelection } from '../lib/selection';
import { Alert, Badge, Button, Card, ConfidencePill, Empty, ErrorText, PageHeader, Pagination, StatusBadge, Table, td, th } from '../components/ui';

interface ContactDetail {
  contact: Contact & { confidence_explanation: string[]; website_url: string | null };
  evidence: Evidence[];
  messages: { id: number; campaign_id: number; campaign_name: string; status: string; processed_at: string | null }[];
}

function EvidencePanel({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['contact', id], queryFn: () => api<ContactDetail>(`/contacts/${id}`) });
  const d = q.data;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <h2 className="break-all text-lg font-semibold">{d?.contact.email ?? 'Loading…'}</h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {d && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge color="blue">{d.contact.contact_type}</Badge>
              <ConfidencePill value={d.contact.confidence} />
              <StatusBadge status={d.contact.eligibility} />
            </div>
            <div>
              <div className="label">Confidence explanation</div>
              <ul className="list-disc space-y-0.5 pl-5 text-slate-600">
                {d.contact.confidence_explanation.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="label">Where it was published ({d.evidence.length})</div>
              <ul className="space-y-2">
                {d.evidence.map((e, i) => (
                  <li key={i} className="rounded-lg border border-slate-200 p-3">
                    <a className="break-all text-blue-600 hover:underline" href={e.source_url} target="_blank" rel="noreferrer noopener">
                      {e.source_url}
                    </a>
                    <div className="mt-1 text-xs text-slate-500">
                      {e.page_type} page · {e.method === 'mailto' ? 'mailto link' : 'visible text'} · {fmtDate(e.created_at)}
                    </div>
                    {e.context_snippet && <blockquote className="mt-2 border-l-2 border-slate-200 pl-3 text-xs text-slate-600">{e.context_snippet}</blockquote>}
                  </li>
                ))}
              </ul>
            </div>
            {d.messages.length > 0 && (
              <div>
                <div className="label">Campaign history</div>
                <ul className="space-y-1">
                  {d.messages.map((m) => (
                    <li key={m.id} className="flex justify-between">
                      <span>{m.campaign_name}</span>
                      <StatusBadge status={m.status} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ContactsPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const sel = useSelection();
  const [detail, setDetail] = useState<number | null>(null);
  const [f, setF] = useState({
    q: '',
    type: '',
    location: '',
    minConfidence: '',
    status: '',
    companyId: params.get('companyId') ?? '',
    page: 1,
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/settings') });
  const max = settings.data?.runtime.maxRecipientsPerCampaign ?? 50;
  const q = useQuery({
    queryKey: ['contacts', f],
    queryFn: () => api<Paged<Contact>>(`/contacts${qs({ ...f, pageSize: 25 })}`),
    placeholderData: keepPreviousData,
  });
  const [notice, setNotice] = useState('');
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v, page: 1 }));

  const selectable = (c: Contact) => c.eligibility === 'eligible';
  const toggle = (c: Contact) => {
    if (!selectable(c)) return;
    if (!sel.has(c.id) && sel.ids.length >= max) {
      setNotice(`A campaign can include at most ${max} recipients (change in Settings).`);
      return;
    }
    setNotice('');
    sel.toggle(c.id);
  };
  const pageEligible = (q.data?.items ?? []).filter(selectable);
  const allOnPage = pageEligible.length > 0 && pageEligible.every((c) => sel.has(c.id));
  const togglePage = () => {
    if (allOnPage) return sel.remove(pageEligible.map((c) => c.id));
    const notSelected = pageEligible.filter((c) => !sel.has(c.id));
    const add = notSelected.slice(0, Math.max(0, max - sel.ids.length));
    sel.add(add.map((c) => c.id));
    if (add.length < notSelected.length) setNotice(`Selection capped at ${max} recipients.`);
  };
  const selectAllMatching = async () => {
    const r = await api<{ ids: number[]; limit: number }>(`/contacts/eligible-ids${qs({ ...f, status: undefined, page: undefined })}`);
    sel.clear();
    sel.add(r.ids);
    setNotice(`Selected ${r.ids.length} eligible contact(s) (limit ${r.limit}).`);
  };

  return (
    <>
      <PageHeader
        title="Contacts"
        subtitle="Publicly displayed business addresses with evidence. Only eligible contacts can be selected."
        actions={
          <>
            <a href={withToken(`/api/export/contacts.xlsx${sel.ids.length ? `?ids=${sel.ids.join(',')}` : ''}`)}>
              <Button>{sel.ids.length ? `Export ${sel.ids.length} selected` : 'Export all'}</Button>
            </a>
            <Button variant="primary" disabled={sel.ids.length === 0} onClick={() => nav('/campaigns/new')}>
              Create campaign ({sel.ids.length}/{max})
            </Button>
          </>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <input className="input" placeholder="Company, email or name" value={f.q} onChange={(e) => set('q', e.target.value)} />
          <select className="input" value={f.type} onChange={(e) => set('type', e.target.value)}>
            <option value="">Any type</option>
            {CONTACT_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <input className="input" placeholder="City, state or country" value={f.location} onChange={(e) => set('location', e.target.value)} />
          <select className="input" value={f.minConfidence} onChange={(e) => set('minConfidence', e.target.value)}>
            <option value="">Any confidence</option>
            <option value="40">≥ 40</option>
            <option value="60">≥ 60</option>
            <option value="80">≥ 80</option>
          </select>
          <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any status</option>
            <option value="eligible">Eligible</option>
            <option value="contacted">Already contacted</option>
            <option value="suppressed">Suppressed</option>
            <option value="low_confidence">Low confidence</option>
            <option value="invalid">Invalid</option>
          </select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <Button onClick={selectAllMatching}>Select eligible matching filters (max {max})</Button>
          {sel.ids.length > 0 && (
            <Button variant="ghost" onClick={() => sel.clear()}>
              Clear selection
            </Button>
          )}
          {f.companyId && (
            <Button variant="ghost" onClick={() => set('companyId', '')}>
              Remove company filter ×
            </Button>
          )}
        </div>
      </Card>
      {notice && (
        <div className="mb-4">
          <Alert tone="info">{notice}</Alert>
        </div>
      )}
      <ErrorText error={q.error} />
      {q.data && q.data.total === 0 ? (
        <Empty title="No contacts match">Contacts appear after a discovery run scans company websites.</Empty>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th className={th}>
                  <input type="checkbox" aria-label="Select page" checked={allOnPage} onChange={togglePage} disabled={pageEligible.length === 0} />
                </th>
                <th className={th}>Email</th>
                <th className={th}>Name / role</th>
                <th className={th}>Type</th>
                <th className={th}>Company</th>
                <th className={th}>Location</th>
                <th className={th}>Confidence</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {q.data?.items.map((c) => (
                <tr key={c.id} className={sel.has(c.id) ? 'bg-blue-50/60' : 'hover:bg-slate-50'}>
                  <td className={td}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${c.email}`}
                      checked={sel.has(c.id)}
                      disabled={!selectable(c)}
                      title={selectable(c) ? '' : `Not selectable: ${c.eligibility.replace('_', ' ')}`}
                      onChange={() => toggle(c)}
                    />
                  </td>
                  <td className={td}>
                    <button className="break-all text-left font-medium text-blue-700 hover:underline" onClick={() => setDetail(c.id)}>
                      {c.email}
                    </button>
                  </td>
                  <td className={`${td} text-slate-600`}>{[c.name, c.role_title].filter(Boolean).join(' — ') || '—'}</td>
                  <td className={td}>
                    <Badge color="blue">{c.contact_type}</Badge>
                  </td>
                  <td className={td}>{c.company_name}</td>
                  <td className={`${td} text-slate-600`}>{location(c)}</td>
                  <td className={td}>
                    <ConfidencePill value={c.confidence} />
                  </td>
                  <td className={td}>
                    <StatusBadge status={c.eligibility} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {q.data && <Pagination page={f.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => setF((x) => ({ ...x, page: p }))} />}
        </>
      )}
      {detail && <EvidencePanel id={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
