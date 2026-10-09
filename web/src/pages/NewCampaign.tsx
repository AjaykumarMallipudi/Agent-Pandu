import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type CampaignSnapshot, type SettingsView, type Template } from '../lib/api';
import { useSelection } from '../lib/selection';
import { Alert, Button, Card, ErrorText, Field, PageHeader } from '../components/ui';

export function NewCampaignPage() {
  const sel = useSelection();
  const nav = useNavigate();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<{ items: Template[] }>('/templates') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/settings') });
  const [name, setName] = useState(`Outreach ${new Date().toLocaleDateString()}`);
  const [templateId, setTemplateId] = useState<number | ''>('');
  const [position, setPosition] = useState('');
  const tplId = templateId || templates.data?.items[0]?.id;
  const tpl = templates.data?.items.find((t) => t.id === tplId);
  const max = settings.data?.runtime.maxRecipientsPerCampaign ?? 50;

  const create = useMutation({
    mutationFn: () => api<CampaignSnapshot>('/campaigns', { body: { name, templateId: tplId, position: position || undefined, contactIds: sel.ids } }),
    onSuccess: (s) => {
      sel.clear();
      nav(`/campaigns/${s.campaign.id}`);
    },
  });

  if (sel.ids.length === 0) {
    return (
      <>
        <PageHeader title="New campaign" />
        <Alert>
          No contacts selected. <Link to="/contacts" className="font-medium text-blue-700 underline">Select eligible contacts</Link> first.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader title="New campaign" subtitle="Creating a campaign only prepares a draft. Nothing is sent until you review, approve and start it." />
      <Card className="max-w-2xl">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Campaign name">
            <input className="input" required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Template">
            <select className="input" value={tplId ?? ''} onChange={(e) => setTemplateId(Number(e.target.value))}>
              {templates.data?.items.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Position you are applying for (optional)" hint="Fills {{position}} in the template. Leave blank for a general enquiry.">
            <input className="input" value={position} onChange={(e) => setPosition(e.target.value)} placeholder="e.g. Frontend Developer" />
          </Field>
          {tpl?.attach_resume ? <Alert tone={settings.data?.resume.uploaded ? 'info' : 'warn'}>{settings.data?.resume.uploaded ? 'Your resume PDF will be attached.' : 'This template attaches a resume, but none is uploaded (Settings).'}</Alert> : null}
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <strong>{sel.ids.length}</strong> recipient(s) selected (limit {max}). Each receives a separate, individually addressed message.
          </div>
          {settings.data?.runtime.testMode && <Alert tone="info" title="Test mode is on">This campaign will be simulated: messages are built but never transmitted.</Alert>}
          <ErrorText error={create.error} />
          <div className="flex gap-2">
            <Button variant="primary" type="submit" disabled={create.isPending || !tplId}>
              {create.isPending ? 'Preparing…' : 'Create draft & preview'}
            </Button>
            <Link to="/contacts">
              <Button>Back to contacts</Button>
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
