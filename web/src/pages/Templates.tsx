import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Rendered, type SettingsView, type Template } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Alert, Badge, Button, Card, ErrorText, Field, HtmlPreview, PageHeader, cx } from '../components/ui';

type Draft = { name: string; subject: string; html: string; text: string; attachResume: boolean };
const toDraft = (t: Template): Draft => ({ name: t.name, subject: t.subject, html: t.html, text: t.text, attachResume: t.attach_resume === 1 });

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Editor({ template, placeholders, onSaved }: { template: Template | null; placeholders: string[]; onSaved: (t: Template) => void }) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(template ? toDraft(template) : { name: '', subject: '', html: '<p>Dear {{name}},</p>\n<p></p>', text: 'Dear {{name}},\n\n', attachResume: false });
  const [tab, setTab] = useState<'html' | 'text'>('html');
  const [view, setView] = useState<'html' | 'text'>('html');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/settings') });
  const debounced = useDebounced(d, 350);
  const preview = useQuery({
    queryKey: ['preview', debounced.subject, debounced.html, debounced.text],
    queryFn: () => api<Rendered>('/templates/preview', { body: { subject: debounced.subject, html: debounced.html, text: debounced.text } }),
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => (template ? api<Template>(`/templates/${template.id}`, { method: 'PUT', body: d }) : api<Template>('/templates', { body: d })),
    onSuccess: (t) => {
      setMsg({ tone: 'success', text: 'Template saved.' });
      void qc.invalidateQueries({ queryKey: ['templates'] });
      onSaved(t);
    },
    onError: (e) => setMsg({ tone: 'error', text: (e as Error).message }),
  });
  const test = useMutation({
    mutationFn: () => api<{ to: string; response: string | null }>(`/templates/${template!.id}/test-email`, { body: {} }),
    onSuccess: (r) => setMsg({ tone: 'success', text: `Test email accepted by SMTP for ${r.to}. ${r.response ?? ''}` }),
    onError: (e) => setMsg({ tone: 'error', text: (e as Error).message }),
  });

  const insert = (ph: string) => {
    const ref = tab === 'html' ? htmlRef.current : textRef.current;
    const key = tab;
    const token = `{{${ph}}}`;
    if (!ref) return;
    const { selectionStart: s, selectionEnd: e } = ref;
    setD((p) => ({ ...p, [key]: p[key].slice(0, s) + token + p[key].slice(e) }));
    requestAnimationFrame(() => {
      ref.focus();
      ref.setSelectionRange(s + token.length, s + token.length);
    });
  };

  const dirty = template ? JSON.stringify(toDraft(template)) !== JSON.stringify(d) : true;

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card title={template ? `Edit: ${template.name}` : 'New template'}>
        <div className="space-y-4">
          <Field label="Template name">
            <input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field label="Subject">
            <input className="input" value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} />
          </Field>
          <div>
            <span className="label">Insert placeholder</span>
            <div className="flex flex-wrap gap-1.5">
              {placeholders.map((p) => (
                <button key={p} type="button" onClick={() => insert(p)} className="rounded-md bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700 hover:bg-blue-100">
                  {`{{${p}}}`}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Conditional blocks are allowed: <code>{'{{#if linkedin}}…{{/if}}'}</code>. Values are HTML-escaped; scripts, event handlers and unsafe links are stripped.
            </p>
          </div>
          <div className="flex gap-1 border-b border-slate-200">
            {(['html', 'text'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === t ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500')}>
                {t === 'html' ? 'HTML body' : 'Plain-text version'}
              </button>
            ))}
          </div>
          {tab === 'html' ? (
            <textarea ref={htmlRef} className="input h-96 font-mono text-xs" spellCheck={false} value={d.html} onChange={(e) => setD({ ...d, html: e.target.value })} />
          ) : (
            <textarea ref={textRef} className="input h-96 font-mono text-xs" value={d.text} onChange={(e) => setD({ ...d, text: e.target.value })} />
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.attachResume} onChange={(e) => setD({ ...d, attachResume: e.target.checked })} />
            Attach resume PDF
            {d.attachResume && !settings.data?.resume.uploaded && <Badge color="amber">No resume uploaded — add one in Settings</Badge>}
          </label>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending || !dirty || !d.name.trim()}>
              {save.isPending ? 'Saving…' : 'Save template'}
            </Button>
            {template && (
              <Button
                onClick={() => test.mutate()}
                disabled={test.isPending || dirty}
                title={dirty ? 'Save first' : `Sends one sample to ${settings.data?.smtp.testAddress || 'TEST_EMAIL_ADDRESS'}`}
              >
                {test.isPending ? 'Sending…' : `Send test to ${settings.data?.smtp.testAddress || 'test address'}`}
              </Button>
            )}
          </div>
        </div>
      </Card>
      <Card
        title="Live preview (sample recipient)"
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
        {preview.error ? (
          <ErrorText error={preview.error} />
        ) : preview.data ? (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span className="text-slate-500">Subject: </span>
              <span className="font-medium">{preview.data.subject}</span>
            </div>
            {view === 'html' ? (
              <HtmlPreview html={preview.data.html} />
            ) : (
              <pre className="h-[560px] overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-4 font-mono text-xs">{preview.data.text}</pre>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-500">Rendering…</p>
        )}
      </Card>
    </div>
  );
}

export function TemplatesPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['templates'], queryFn: () => api<{ items: Template[]; placeholders: string[] }>('/templates') });
  const dup = useMutation({
    mutationFn: (tid: number) => api<Template>(`/templates/${tid}/duplicate`, { method: 'POST' }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      nav(`/templates/${t.id}`);
    },
  });
  const del = useMutation({
    mutationFn: (tid: number) => api(`/templates/${tid}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      nav('/templates');
    },
  });

  const items = list.data?.items ?? [];
  const current = id && id !== 'new' ? items.find((t) => t.id === Number(id)) ?? null : null;

  if (id) {
    if (id !== 'new' && !current) return <p className="text-sm text-slate-500">Loading…</p>;
    return (
      <>
        <PageHeader title="Email Templates" subtitle={<Link to="/templates" className="text-blue-600">← All templates</Link>} />
        <Editor key={current?.id ?? 'new'} template={current} placeholders={list.data?.placeholders ?? []} onSaved={(t) => nav(`/templates/${t.id}`)} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Email Templates"
        subtitle="Reusable, personalized HTML emails with a plain-text alternative."
        actions={
          <Button variant="primary" onClick={() => nav('/templates/new')}>
            New template
          </Button>
        }
      />
      <ErrorText error={list.error ?? dup.error ?? del.error} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((t) => (
          <Card key={t.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{t.name}</div>
                <div className="mt-1 line-clamp-2 text-sm text-slate-500">{t.subject}</div>
              </div>
              {t.attach_resume ? <Badge color="violet">Resume</Badge> : null}
            </div>
            <div className="mt-2 text-xs text-slate-400">Updated {fmtDate(t.updated_at)}</div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => nav(`/templates/${t.id}`)}>
                Edit & preview
              </Button>
              <Button onClick={() => dup.mutate(t.id)}>Duplicate</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  if (confirm(`Delete template "${t.name}"? Existing campaigns keep their frozen content.`)) del.mutate(t.id);
                }}
              >
                Delete
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
