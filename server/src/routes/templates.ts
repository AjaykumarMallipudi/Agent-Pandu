import { Router } from 'express';
import { z } from 'zod';
import { HttpError, hasResume, resumePath } from '../campaigns/service.js';
import { config } from '../config.js';
import { getDb, logEvent, nowIso } from '../db/index.js';
import { buildContext, PLACEHOLDERS, renderTemplate, SAMPLE_CONTEXT_INPUT, validateTemplateSource } from '../email/templates.js';
import { fromHeader, realTransport, smtpStatus } from '../email/transport.js';
import { idParam, parse } from '../http/middleware.js';
import { getSettings } from '../settings.js';

export const templatesRouter = Router();

const templateBody = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(300),
  html: z.string().min(1).max(200_000),
  text: z.string().min(1).max(50_000),
  attachResume: z.boolean().default(false),
});

function validate(t: { subject: string; html: string; text: string }) {
  validateTemplateSource(t.subject, 'Subject');
  validateTemplateSource(t.html, 'HTML');
  validateTemplateSource(t.text, 'Plain text');
}

const getTemplate = (id: number) => {
  const t = getDb().prepare('SELECT * FROM email_templates WHERE id = ?').get(id) as
    | { id: number; name: string; subject: string; html: string; text: string; attach_resume: number }
    | undefined;
  if (!t) throw new HttpError(404, 'Template not found');
  return t;
};

templatesRouter.get('/templates', (_req, res) => {
  res.json({ items: getDb().prepare('SELECT * FROM email_templates ORDER BY updated_at DESC').all(), placeholders: PLACEHOLDERS });
});

templatesRouter.get('/templates/:id', (req, res) => {
  res.json(getTemplate(parse(idParam, req.params.id)));
});

templatesRouter.post('/templates', (req, res) => {
  const b = parse(templateBody, req.body);
  validate(b);
  try {
    const r = getDb()
      .prepare('INSERT INTO email_templates (name, subject, html, text, attach_resume) VALUES (?, ?, ?, ?, ?)')
      .run(b.name, b.subject, b.html, b.text, b.attachResume ? 1 : 0);
    res.status(201).json(getTemplate(Number(r.lastInsertRowid)));
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new HttpError(409, 'A template with this name already exists');
    throw e;
  }
});

templatesRouter.put('/templates/:id', (req, res) => {
  const id = parse(idParam, req.params.id);
  getTemplate(id);
  const b = parse(templateBody, req.body);
  validate(b);
  try {
    getDb()
      .prepare('UPDATE email_templates SET name = ?, subject = ?, html = ?, text = ?, attach_resume = ?, updated_at = ? WHERE id = ?')
      .run(b.name, b.subject, b.html, b.text, b.attachResume ? 1 : 0, nowIso(), id);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new HttpError(409, 'A template with this name already exists');
    throw e;
  }
  res.json(getTemplate(id));
});

templatesRouter.post('/templates/:id/duplicate', (req, res) => {
  const t = getTemplate(parse(idParam, req.params.id));
  let name = `${t.name} (copy)`;
  for (let i = 2; getDb().prepare('SELECT 1 FROM email_templates WHERE name = ?').get(name); i++) name = `${t.name} (copy ${i})`;
  const r = getDb()
    .prepare('INSERT INTO email_templates (name, subject, html, text, attach_resume) VALUES (?, ?, ?, ?, ?)')
    .run(name, t.subject, t.html, t.text, t.attach_resume);
  res.status(201).json(getTemplate(Number(r.lastInsertRowid)));
});

templatesRouter.delete('/templates/:id', (req, res) => {
  const id = parse(idParam, req.params.id);
  getTemplate(id);
  getDb().prepare('DELETE FROM email_templates WHERE id = ?').run(id);
  res.json({ ok: true });
});

/** Renders unsaved template source for the live preview, with a sample or real contact. */
templatesRouter.post('/templates/preview', (req, res) => {
  const b = parse(
    z.object({ subject: z.string().max(300), html: z.string().max(200_000), text: z.string().max(50_000), contactId: z.number().int().optional(), position: z.string().max(120).optional() }),
    req.body,
  );
  let input: Parameters<typeof buildContext>[0] = { ...SAMPLE_CONTEXT_INPUT, position: b.position ?? '' };
  if (b.contactId) {
    const c = getDb()
      .prepare('SELECT c.name, c.role_title, c.contact_type, co.name AS company FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.id = ?')
      .get(b.contactId) as { name: string | null; role_title: string | null; contact_type: string; company: string } | undefined;
    if (c) input = { name: c.name, company: c.company, role: c.role_title || (c.contact_type === 'Other' ? '' : c.contact_type), position: b.position };
  }
  const ctx = buildContext({ ...input, unsubscribeUrl: config().PUBLIC_BASE_URL ? `${config().PUBLIC_BASE_URL.replace(/\/+$/, '')}/unsubscribe/preview` : null });
  res.json(renderTemplate(b, ctx));
});

/** Sends one rendered sample to TEST_EMAIL_ADDRESS only. Never to contacts. */
templatesRouter.post('/templates/:id/test-email', async (req, res) => {
  const t = getTemplate(parse(idParam, req.params.id));
  const cfg = config();
  if (!cfg.TEST_EMAIL_ADDRESS) throw new HttpError(400, 'TEST_EMAIL_ADDRESS is not configured in .env');
  const s = smtpStatus();
  if (!s.configured) throw new HttpError(400, `SMTP is not configured: missing ${s.missing.join(', ')}`);
  if (getSettings().killSwitch) throw new HttpError(423, 'Global kill switch is active — no messages may be submitted');
  const rendered = renderTemplate(t, buildContext({ ...SAMPLE_CONTEXT_INPUT, position: typeof req.body?.position === 'string' ? req.body.position : '' }));
  const from = fromHeader();
  try {
    const info = await realTransport().sendMail({
      from: { name: from.name, address: from.address },
      to: cfg.TEST_EMAIL_ADDRESS,
      subject: `[TEST] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
      attachments: t.attach_resume && hasResume() ? [{ filename: 'Resume.pdf', path: resumePath(), contentType: 'application/pdf' }] : undefined,
    });
    logEvent('template.test_email', `Test email for template ${t.id} accepted by SMTP`, { type: 'template', id: t.id });
    res.json({ ok: true, to: cfg.TEST_EMAIL_ADDRESS, response: info.response ?? null, messageId: info.messageId ?? null });
  } catch (e) {
    throw new HttpError(502, `SMTP error: ${(e as Error).message}`);
  }
});
