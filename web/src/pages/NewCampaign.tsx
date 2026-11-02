import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs, type CampaignSnapshot, type Contact, type Paged, type Rendered, type SettingsView, type Template } from '../lib/api';
import { location } from '../lib/format';
import { useSelection } from '../lib/selection';
import { Alert, Badge, Button, Card, ConfidencePill, ErrorText, Field, HtmlPreview, PageHeader, cx } from '../components/ui';

const HIRING_TYPES = ['HR', 'Talent Acquisition', 'Recruiter', 'Recruitment', 'Careers', 'Hiring'];

function Step({ n, title, children, done }: { n: number; title: string; children: React.ReactNode; done?: boolean }) {
  return (
    <Card>
      <div className="mb-4 flex items-center gap-3">
        <span className={cx('flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold', done ? 'bg-emerald-600 text-white' : 'bg-blue-600 text-white')}>
          {done ? '✓' : n}
        </span>
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      {children}
    </Card>
  );
}

export function NewCampaignPage() {
  const sel = useSelection();
  const nav = useNavigate();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/settings') });
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<{ items: Template[] }>('/templates') });
  const max = settings.data?.runtime.maxRecipientsPerCampaign ?? 50;
  const onePerCompany = settings.data?.runtime.onePerCompany ?? true;

  // ---- Step 1: recipients ----
  const [mode, setMode] = useState<'auto' | 'selection'>(sel.ids.length ? 'selection' : 'auto');
  const [loc, setLoc] = useState('');
  const [hiringOnly, setHiringOnly] = useState(false);
  const [howMany, setHowMany] = useState(25);
  const [unchecked, setUnchecked] = useState<Set<number>>(new Set());
  const pool = useQuery({
    queryKey: ['pick', loc, onePerCompany],
    queryFn: () =>
      api<Paged<Contact>>(`/contacts${qs({ status: 'eligible', bestPerCompany: onePerCompany ? 1 : 0, sort: 'priority', location: loc, pageSize: 200 })}`),
    enabled: mode === 'auto' && Boolean(settings.data),
  });
  const picked = useMemo(
    () => (pool.data?.items ?? []).filter((c) => !hiringOnly || HIRING_TYPES.includes(c.contact_type)).slice(0, Math.min(howMany, max)),
    [pool.data, hiringOnly, howMany, max],
  );
  const recipientIds = mode === 'selection' ? sel.ids : picked.filter((c) => !unchecked.has(c.id)).map((c) => c.id);

  // ---- Step 2: message ----
  const [templateId, setTemplateId] = useState<number | ''>('');
  const [position, setPosition] = useState('');
  const [name, setName] = useState(`Applications ${new Date().toLocaleDateString()}`);
  useEffect(() => {
    if (templateId === '' && templates.data?.items.length) {
      const preferred = templates.data.items.find((t) => t.name === 'Simple — resume button') ?? templates.data.items[0]!;
      setTemplateId(preferred.id);
    }
  }, [templates.data, templateId]);
  const tpl = templates.data?.items.find((t) => t.id === templateId);
  const usesResumeLink = Boolean(tpl && /resume_url/.test(tpl.html + tpl.text));
  const previewContact = recipientIds[0];
  const preview = useQuery({
    queryKey: ['new-campaign-preview', tpl?.id, tpl?.updated_at, previewContact, position, settings.data?.runtime.resumeUrl],
    queryFn: () => api<Rendered>('/templates/preview', { body: { subject: tpl!.subject, html: tpl!.html, text: tpl!.text, contactId: previewContact, position } }),
    enabled: Boolean(tpl),
  });

  const create = useMutation({
    mutationFn: () => api<CampaignSnapshot>('/campaigns', { body: { name, templateId, position: position || undefined, contactIds: recipientIds } }),
    onSuccess: (s) => {
      if (mode === 'selection') sel.clear();
      nav(`/campaigns/${s.campaign.id}`);
    },
  });

  const rt = settings.data?.runtime;
  return (
    <>
      <PageHeader title="New campaign" subtitle="Three steps: choose who to email, choose the message, then review and send on the next page." />
      {rt?.testMode && (
        <div className="mb-4">
          <Alert tone="info" title="Test mode is on">
            You can go through the whole flow safely: messages are built and shown but never sent. See <Link to="/campaigns" className="underline">how to send for real</Link>.
          </Alert>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Step n={1} title="Who to email" done={recipientIds.length > 0}>
            <div className="mb-4 flex flex-wrap gap-2">
              <Button variant={mode === 'auto' ? 'primary' : 'secondary'} onClick={() => setMode('auto')}>
                Pick automatically
              </Button>
              <Button variant={mode === 'selection' ? 'primary' : 'secondary'} onClick={() => setMode('selection')} disabled={sel.ids.length === 0}>
                Use my selection ({sel.ids.length})
              </Button>
            </div>
            {mode === 'auto' ? (
              <div className="space-y-4">
                <p className="text-sm text-slate-600">
                  {onePerCompany ? 'The best eligible person at each company' : 'Eligible contacts'} (HR and recruiting first), skipping anyone suppressed or already
                  contacted{onePerCompany ? ', and companies you already wrote to' : ''}.
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="City / state (optional)">
                    <input className="input" value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="e.g. Hyderabad" />
                  </Field>
                  <Field label={`How many (max ${max})`}>
                    <input className="input" type="number" min={1} max={max} value={howMany} onChange={(e) => setHowMany(Math.max(1, Math.min(max, Number(e.target.value))))} />
                  </Field>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input type="checkbox" checked={hiringOnly} onChange={(e) => setHiringOnly(e.target.checked)} />
                    HR / recruiting / careers only
                  </label>
                </div>
                <ErrorText error={pool.error} />
                {pool.data && picked.length === 0 && (
                  <Alert tone="warn">No eligible contacts match. Run a discovery first, or widen the filters.</Alert>
                )}
                {picked.length > 0 && (
                  <div className="max-h-80 overflow-auto rounded-lg border border-slate-200">
                    <table className="min-w-full text-sm">
                      <tbody className="divide-y divide-slate-100">
                        {picked.map((c) => (
                          <tr key={c.id} className={unchecked.has(c.id) ? 'opacity-50' : ''}>
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={!unchecked.has(c.id)}
                                onChange={() =>
                                  setUnchecked((u) => {
                                    const n = new Set(u);
                                    if (n.has(c.id)) n.delete(c.id);
                                    else n.add(c.id);
                                    return n;
                                  })
                                }
                              />
                            </td>
                            <td className="px-3 py-2">
                              <div className="font-medium">{c.company_name}</div>
                              <div className="text-xs text-slate-500">{location(c)}</div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="break-all">{c.email}</div>
                              <Badge color="blue">{c.contact_type}</Badge>
                            </td>
                            <td className="px-3 py-2">
                              <ConfidencePill value={c.confidence} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                Using the {sel.ids.length} contact(s) you ticked on the <Link to="/contacts" className="text-blue-600">Contacts</Link> page.
                {onePerCompany && ' If several are at the same company, only the best one will be kept.'}
              </p>
            )}
            <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <strong>{recipientIds.length}</strong> recipient(s) — each gets their own separate email.
            </div>
          </Step>

          <Step n={2} title="Choose the message" done={Boolean(tpl)}>
            <div className="space-y-4">
              <Field label="Template">
                <select className="input" value={templateId} onChange={(e) => setTemplateId(Number(e.target.value))}>
                  {templates.data?.items.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Role you are applying for (optional)" hint="Fills {{position}}, e.g. in the subject “Application for Frontend Developer at …”.">
                <input className="input" value={position} onChange={(e) => setPosition(e.target.value)} placeholder="e.g. Software Engineer" />
              </Field>
              {usesResumeLink && !rt?.resumeUrl && (
                <Alert tone="warn" title="Resume link missing">
                  This template shows a “View My Resume” button, but no link is set. Add your Google Drive link in{' '}
                  <Link to="/settings" className="font-medium underline">Settings → Resume link</Link> (share it as “Anyone with the link”).
                </Alert>
              )}
              {usesResumeLink && rt?.resumeUrl && <p className="text-xs text-slate-500">Resume button opens: {rt.resumeUrl}</p>}
              <Field label="Campaign name (for your records)">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
          </Step>

          <Step n={3} title="Create the draft">
            <p className="mb-4 text-sm text-slate-600">
              Nothing is sent yet. On the next page you review every email, approve, and press <strong>Start sending</strong>.
            </p>
            <ErrorText error={create.error} />
            <Button variant="primary" className="w-full" disabled={create.isPending || recipientIds.length === 0 || !tpl || !name.trim()} onClick={() => create.mutate()}>
              {create.isPending ? 'Preparing…' : `Create draft for ${recipientIds.length} recipient(s) →`}
            </Button>
          </Step>
        </div>

        <Card title={previewContact ? 'Preview (first recipient)' : 'Preview (sample recipient)'}>
          <ErrorText error={preview.error} />
          {preview.data && (
            <div className="space-y-2 text-sm">
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-slate-500">Subject: </span>
                <span className="font-medium">{preview.data.subject}</span>
              </div>
              <HtmlPreview html={preview.data.html} className="h-[640px]" />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
