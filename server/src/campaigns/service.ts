import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb, logEvent, nowIso } from '../db/index.js';
import { buildContext, renderTemplate } from '../email/templates.js';
import { smtpStatus } from '../email/transport.js';
import { bus, channels } from '../events.js';
import { getSettings } from '../settings.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const MESSAGE_STATUSES = [
  'draft', 'excluded', 'queued', 'processing', 'accepted', 'delivered', 'bounced', 'failed', 'skipped', 'unknown', 'simulated',
] as const;

export interface CampaignRow {
  id: number;
  name: string;
  template_id: number | null;
  template_name: string | null;
  position: string | null;
  attach_resume: number;
  status: string;
  test_mode: number;
  paused_reason: string | null;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: number;
  campaign_id: number;
  contact_id: number | null;
  email: string;
  recipient_name: string | null;
  company_name: string | null;
  contact_type: string | null;
  subject: string;
  html: string;
  text: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  next_attempt_at: string | null;
  submit_started_at: string | null;
  processed_at: string | null;
  delivered_at: string | null;
  smtp_message_id: string | null;
  smtp_response: string | null;
  idempotency_key: string;
  unsubscribe_token: string;
}

export function resumePath(): string {
  return path.join(config().dataDir, 'uploads', 'resume.pdf');
}
export function hasResume(): boolean {
  return fs.existsSync(resumePath());
}

export function getCampaign(id: number): CampaignRow {
  const c = getDb().prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined;
  if (!c) throw new HttpError(404, 'Campaign not found');
  return c;
}

export function unsubscribeUrl(token: string): string | null {
  const base = config().PUBLIC_BASE_URL.replace(/\/+$/, '');
  return base ? `${base}/unsubscribe/${token}` : null;
}

export function campaignCounts(id: number) {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) n FROM campaign_messages WHERE campaign_id = ? GROUP BY status')
    .all(id) as { status: string; n: number }[];
  const by: Record<string, number> = Object.fromEntries(MESSAGE_STATUSES.map((s) => [s, 0]));
  for (const r of rows) by[r.status] = r.n;
  const total = rows.reduce((a, r) => a + r.n, 0) - by.excluded!;
  const finished = by.accepted! + by.delivered! + by.bounced! + by.failed! + by.skipped! + by.unknown! + by.simulated!;
  // Drafts only exist before sending starts (start queues them, cancel skips them): no progress until then.
  return {
    ...by,
    total,
    finished,
    progress: by.draft! > 0 || total === 0 ? 0 : Math.round((finished / total) * 100),
  } as Record<(typeof MESSAGE_STATUSES)[number], number> & { total: number; finished: number; progress: number };
}

export function campaignSnapshot(id: number) {
  const campaign = getCampaign(id);
  const messages = getDb()
    .prepare(
      `SELECT id, email, recipient_name, company_name, contact_type, subject, status, error_code, error_message, attempts,
              next_attempt_at, processed_at, delivered_at, smtp_message_id, smtp_response
       FROM campaign_messages WHERE campaign_id = ? ORDER BY id`,
    )
    .all(id);
  const s = getSettings();
  return { campaign, counts: campaignCounts(id), messages, killSwitch: s.killSwitch, testMode: s.testMode || campaign.test_mode === 1 };
}

export function publishCampaign(id: number): void {
  bus.emit(channels.campaign(id), id);
}

function eligibilityReason(row: {
  suppressed: number;
  contacted: number;
  status: string;
  syntax_valid: number;
  confidence: number;
}, minConfidence: number): string | null {
  if (row.suppressed) return 'Address is on the suppression list';
  if (row.contacted) return 'Already contacted (previous send or unresolved outcome)';
  if (row.status !== 'active' || !row.syntax_valid) return 'Contact is marked invalid';
  if (row.confidence < minConfidence) return `Confidence ${row.confidence} is below the minimum ${minConfidence}`;
  return null;
}

/** Creates a draft campaign with a frozen, personalized snapshot of every message. Nothing is sent. */
export function createCampaign(input: { name: string; templateId: number; position?: string; contactIds: number[]; attachResume?: boolean }) {
  const db = getDb();
  const settings = getSettings();
  const ids = [...new Set(input.contactIds)];
  if (ids.length === 0) throw new HttpError(400, 'Select at least one contact');
  if (ids.length > settings.maxRecipientsPerCampaign) {
    throw new HttpError(400, `A campaign may have at most ${settings.maxRecipientsPerCampaign} recipients (configured in Settings)`);
  }
  const tpl = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(input.templateId) as
    | { id: number; name: string; subject: string; html: string; text: string; attach_resume: number }
    | undefined;
  if (!tpl) throw new HttpError(404, 'Template not found');
  const attachResume = input.attachResume ?? tpl.attach_resume === 1;
  if (attachResume && !hasResume()) throw new HttpError(400, 'Template attaches a resume, but no resume PDF has been uploaded (Settings)');

  const placeholders = ids.map(() => '?').join(',');
  const contacts = db
    .prepare(
      `SELECT c.id, c.email, c.name, c.contact_type, c.role_title, c.status, c.syntax_valid, c.confidence, co.name AS company_name,
              (s.id IS NOT NULL) AS suppressed,
              EXISTS (SELECT 1 FROM send_ledger l WHERE l.email = c.email) AS contacted
       FROM contacts c JOIN companies co ON co.id = c.company_id
       LEFT JOIN suppressions s ON s.email = c.email
       WHERE c.id IN (${placeholders})`,
    )
    .all(...ids) as {
    id: number;
    email: string;
    name: string | null;
    contact_type: string;
    role_title: string | null;
    status: string;
    syntax_valid: number;
    confidence: number;
    company_name: string;
    suppressed: number;
    contacted: number;
  }[];
  if (contacts.length !== ids.length) throw new HttpError(400, 'Some selected contacts no longer exist');

  return db.transaction(() => {
    const campaignId = Number(
      db
        .prepare('INSERT INTO campaigns (name, template_id, template_name, position, attach_resume, status, test_mode) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.name, tpl.id, tpl.name, input.position ?? '', attachResume ? 1 : 0, 'draft', settings.testMode ? 1 : 0).lastInsertRowid,
    );
    const insert = db.prepare(
      `INSERT INTO campaign_messages (campaign_id, contact_id, email, recipient_name, company_name, contact_type, subject, html, text, status,
         error_message, idempotency_key, unsubscribe_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of contacts) {
      const token = crypto.randomBytes(18).toString('base64url');
      const rendered = renderTemplate(
        tpl,
        buildContext({
          name: c.name,
          company: c.company_name,
          role: c.role_title || (c.contact_type === 'Other' ? '' : c.contact_type),
          position: input.position,
          unsubscribeUrl: unsubscribeUrl(token),
        }),
      );
      const reason = eligibilityReason(c, settings.minConfidence);
      const key = `c${campaignId}-${crypto.createHash('sha256').update(c.email).digest('hex').slice(0, 24)}`;
      insert.run(
        campaignId, c.id, c.email, c.name, c.company_name, c.contact_type, rendered.subject, rendered.html, rendered.text,
        reason ? 'skipped' : 'draft', reason, key, token,
      );
    }
    logEvent('campaign.created', `Campaign "${input.name}" created with ${contacts.length} recipients`, { type: 'campaign', id: campaignId });
    return getCampaign(campaignId);
  })();
}

export function setExcluded(campaignId: number, messageId: number, excluded: boolean): void {
  const c = getCampaign(campaignId);
  if (c.status !== 'draft') throw new HttpError(409, 'Recipients can only be changed while the campaign is a draft');
  const r = getDb()
    .prepare(`UPDATE campaign_messages SET status = ?, updated_at = ? WHERE id = ? AND campaign_id = ? AND status = ?`)
    .run(excluded ? 'excluded' : 'draft', nowIso(), messageId, campaignId, excluded ? 'draft' : 'excluded');
  if (r.changes === 0) throw new HttpError(409, 'Recipient cannot be changed (already skipped or in that state)');
  publishCampaign(campaignId);
}

function senderReadiness(testMode: boolean): void {
  if (testMode) return;
  const s = smtpStatus();
  if (!s.configured) throw new HttpError(400, `Sender configuration incomplete: missing ${s.missing.join(', ')}`);
}

/** Explicit approval. The caller must echo back the exact number of messages it reviewed. */
export function approveCampaign(id: number, body: { confirm: boolean; recipientCount: number }) {
  const db = getDb();
  const c = getCampaign(id);
  if (c.status !== 'draft') throw new HttpError(409, `Campaign is ${c.status}; only drafts can be approved`);
  if (body.confirm !== true) throw new HttpError(400, 'Explicit confirmation is required');
  const n = campaignCounts(id).draft;
  if (n === 0) throw new HttpError(400, 'No sendable recipients in this campaign');
  if (body.recipientCount !== n) {
    throw new HttpError(409, `Recipient count changed (you confirmed ${body.recipientCount}, campaign has ${n}). Review and confirm again.`);
  }
  senderReadiness(c.test_mode === 1 || getSettings().testMode);
  db.prepare(`UPDATE campaigns SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), id);
  logEvent('campaign.approved', `Campaign approved for ${n} recipients`, { type: 'campaign', id });
  publishCampaign(id);
  return getCampaign(id);
}

export function startCampaign(id: number) {
  const db = getDb();
  const c = getCampaign(id);
  if (c.status !== 'approved') throw new HttpError(409, c.status === 'draft' ? 'Approve the campaign before starting it' : `Campaign is already ${c.status}`);
  const s = getSettings();
  if (s.killSwitch) throw new HttpError(423, 'Global kill switch is active — sending is disabled');
  senderReadiness(c.test_mode === 1 || s.testMode);
  db.transaction(() => {
    db.prepare(`UPDATE campaigns SET status = 'sending', started_at = ?, paused_reason = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), id);
    db.prepare(`UPDATE campaign_messages SET status = 'queued', updated_at = ? WHERE campaign_id = ? AND status = 'draft'`).run(nowIso(), id);
  })();
  logEvent('campaign.started', 'Campaign sending started', { type: 'campaign', id });
  publishCampaign(id);
  return getCampaign(id);
}

export function pauseCampaign(id: number, reason = 'Paused by user') {
  const r = getDb()
    .prepare(`UPDATE campaigns SET status = 'paused', paused_reason = ?, updated_at = ? WHERE id = ? AND status = 'sending'`)
    .run(reason, nowIso(), id);
  if (r.changes === 0) throw new HttpError(409, 'Only a sending campaign can be paused');
  logEvent('campaign.paused', reason, { type: 'campaign', id });
  publishCampaign(id);
  return getCampaign(id);
}

export function resumeCampaign(id: number) {
  if (getSettings().killSwitch) throw new HttpError(423, 'Global kill switch is active — release it in Settings first');
  const c = getCampaign(id);
  senderReadiness(c.test_mode === 1 || getSettings().testMode);
  const r = getDb()
    .prepare(`UPDATE campaigns SET status = 'sending', paused_reason = NULL, updated_at = ? WHERE id = ? AND status = 'paused'`)
    .run(nowIso(), id);
  if (r.changes === 0) throw new HttpError(409, 'Only a paused campaign can be resumed');
  logEvent('campaign.resumed', 'Campaign resumed', { type: 'campaign', id });
  publishCampaign(id);
  return getCampaign(id);
}

export function cancelCampaign(id: number) {
  const db = getDb();
  const c = getCampaign(id);
  if (!['draft', 'approved', 'paused'].includes(c.status)) throw new HttpError(409, `A ${c.status} campaign cannot be cancelled (pause it first)`);
  db.transaction(() => {
    db.prepare(`UPDATE campaigns SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), id);
    // Release reservations held by messages waiting for a retry (nothing was accepted for them).
    db.prepare(
      `DELETE FROM send_ledger WHERE state = 'reserved' AND message_id IN
         (SELECT id FROM campaign_messages WHERE campaign_id = ? AND status IN ('draft', 'queued'))`,
    ).run(id);
    db.prepare(
      `UPDATE campaign_messages SET status = 'skipped', error_message = 'Campaign cancelled before sending', updated_at = ?
       WHERE campaign_id = ? AND status IN ('draft', 'queued')`,
    ).run(nowIso(), id);
  })();
  logEvent('campaign.cancelled', 'Campaign cancelled', { type: 'campaign', id });
  publishCampaign(id);
  return getCampaign(id);
}

/** Operator resolution of an ambiguous ("unknown") outcome after checking the mailbox's Sent folder / provider logs. */
export function resolveUnknown(campaignId: number, messageId: number, outcome: 'accepted' | 'failed') {
  const db = getDb();
  const m = db.prepare('SELECT * FROM campaign_messages WHERE id = ? AND campaign_id = ?').get(messageId, campaignId) as MessageRow | undefined;
  if (!m) throw new HttpError(404, 'Message not found');
  if (m.status !== 'unknown') throw new HttpError(409, 'Only messages with an unknown outcome can be resolved');
  db.transaction(() => {
    db.prepare(`UPDATE campaign_messages SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`).run(
      outcome,
      outcome === 'failed' ? 'Marked not sent by operator' : null,
      nowIso(),
      m.id,
    );
    if (outcome === 'accepted') db.prepare(`UPDATE send_ledger SET state = 'accepted' WHERE message_id = ?`).run(m.id);
    else db.prepare('DELETE FROM send_ledger WHERE message_id = ?').run(m.id);
  })();
  publishCampaign(campaignId);
}
