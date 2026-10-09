import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../campaigns/service.js';
import { CONTACT_TYPES } from '../crawler/classify.js';
import { contactStatusSql } from '../contacts/repo.js';
import { normalizeEmail, isValidEmailSyntax } from '../crawler/extract.js';
import { getDb, logEvent } from '../db/index.js';
import { exportCampaignHistory, exportCompanies, exportContacts } from '../export/excel.js';
import { idParam, parse } from '../http/middleware.js';
import { getSettings } from '../settings.js';

export const dataRouter = Router();

const count = (sql: string, ...params: unknown[]) => (getDb().prepare(sql).get(...params) as { n: number }).n;

dataRouter.get('/dashboard', (_req, res) => {
  const st = contactStatusSql();
  const db = getDb();
  const msg = (statuses: string, live = true) =>
    count(
      `SELECT COUNT(*) n FROM campaign_messages m JOIN campaigns c ON c.id = m.campaign_id WHERE m.status IN (${statuses})${live ? ' AND c.test_mode = 0' : ''}`,
    );
  res.json({
    companiesDiscovered: count('SELECT COUNT(*) n FROM companies'),
    websitesScanned: count('SELECT COUNT(*) n FROM companies WHERE last_scanned_at IS NOT NULL'),
    contactsFound: count('SELECT COUNT(*) n FROM contacts'),
    eligibleContacts: count(
      `SELECT COUNT(*) n FROM contacts c LEFT JOIN suppressions s ON s.email = c.email WHERE (${st.sql}) = 'eligible'`,
      ...st.params,
    ),
    campaignsCreated: count('SELECT COUNT(*) n FROM campaigns'),
    acceptedBySmtp: msg(`'accepted','delivered','bounced'`),
    confirmedDelivered: msg(`'delivered'`),
    failed: msg(`'failed','bounced'`, false),
    skipped: msg(`'skipped'`, false),
    pending: msg(`'queued','processing'`, false),
    unknown: msg(`'unknown'`, false),
    simulated: msg(`'simulated'`, false),
    contactsByType: db.prepare('SELECT contact_type AS type, COUNT(*) n FROM contacts GROUP BY contact_type ORDER BY n DESC').all(),
    recentRuns: db.prepare('SELECT id, status, provider, companies_found, companies_scanned, contacts_found, started_at, finished_at FROM discovery_runs ORDER BY id DESC LIMIT 5').all(),
    recentCampaigns: db.prepare('SELECT id, name, status, test_mode, created_at FROM campaigns ORDER BY id DESC LIMIT 5').all(),
  });
});

// ---------- Companies ----------
const companyQuery = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  location: z.string().optional(),
  industry: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

dataRouter.get('/companies', (req, res) => {
  const q = parse(companyQuery, req.query);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.q) {
    where.push('(co.name LIKE ? OR co.domain LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`);
  }
  if (q.status) {
    where.push('co.discovery_status = ?');
    params.push(q.status);
  }
  if (q.location) {
    where.push('(co.city LIKE ? OR co.state LIKE ? OR co.country LIKE ?)');
    params.push(`%${q.location}%`, `%${q.location}%`, `%${q.location}%`);
  }
  if (q.industry) {
    where.push('co.industry LIKE ?');
    params.push(`%${q.industry}%`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = count(`SELECT COUNT(*) n FROM companies co ${w}`, ...params);
  const items = getDb()
    .prepare(
      `SELECT co.id, co.name, co.domain, co.website_url, co.city, co.state, co.country, co.industry, co.discovery_status,
              co.scan_error, co.pages_scanned, co.last_scanned_at, co.created_at,
              (SELECT COUNT(*) FROM contacts c WHERE c.company_id = co.id) AS contact_count
       FROM companies co ${w} ORDER BY co.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize);
  res.json({ items, total, page: q.page, pageSize: q.pageSize });
});

dataRouter.get('/companies/:id', (req, res) => {
  const id = parse(idParam, req.params.id);
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!company) throw new HttpError(404, 'Company not found');
  const st = contactStatusSql();
  const contacts = db
    .prepare(
      `SELECT c.id, c.email, c.name, c.role_title, c.contact_type, c.confidence, c.confidence_explanation, c.mx_checked, c.mx_valid,
              c.domain_matches_company, ${st.sql} AS eligibility
       FROM contacts c LEFT JOIN suppressions s ON s.email = c.email WHERE c.company_id = ? ORDER BY c.confidence DESC`,
    )
    .all(...st.params, id);
  const sources = db.prepare('SELECT provider, provider_ref, source_url, run_id, created_at FROM company_sources WHERE company_id = ?').all(id);
  res.json({ company, contacts, sources });
});

// ---------- Contacts ----------
const contactQuery = z.object({
  q: z.string().optional(),
  type: z.enum(CONTACT_TYPES).optional(),
  location: z.string().optional(),
  minConfidence: z.coerce.number().int().min(0).max(100).optional(),
  status: z.enum(['eligible', 'suppressed', 'contacted', 'invalid', 'low_confidence']).optional(),
  companyId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

function contactFilter(q: z.infer<typeof contactQuery>) {
  const st = contactStatusSql();
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.q) {
    where.push('(c.email LIKE ? OR c.name LIKE ? OR co.name LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  if (q.type) {
    where.push('c.contact_type = ?');
    params.push(q.type);
  }
  if (q.location) {
    where.push('(co.city LIKE ? OR co.state LIKE ? OR co.country LIKE ?)');
    params.push(`%${q.location}%`, `%${q.location}%`, `%${q.location}%`);
  }
  if (q.minConfidence !== undefined) {
    where.push('c.confidence >= ?');
    params.push(q.minConfidence);
  }
  if (q.companyId) {
    where.push('c.company_id = ?');
    params.push(q.companyId);
  }
  if (q.status) {
    where.push(`(${st.sql}) = ?`);
    params.push(...st.params, q.status);
  }
  return { st, w: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const CONTACT_FROM = 'FROM contacts c JOIN companies co ON co.id = c.company_id LEFT JOIN suppressions s ON s.email = c.email';

dataRouter.get('/contacts', (req, res) => {
  const q = parse(contactQuery, req.query);
  const { st, w, params } = contactFilter(q);
  const total = count(`SELECT COUNT(*) n ${CONTACT_FROM} ${w}`, ...params);
  const items = getDb()
    .prepare(
      `SELECT c.id, c.email, c.name, c.role_title, c.contact_type, c.confidence, c.domain_matches_company, c.mx_checked, c.mx_valid,
              c.last_seen_at, co.id AS company_id, co.name AS company_name, co.city, co.state, co.country, ${st.sql} AS eligibility
       ${CONTACT_FROM} ${w} ORDER BY c.confidence DESC, c.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...st.params, ...params, q.pageSize, (q.page - 1) * q.pageSize);
  res.json({ items, total, page: q.page, pageSize: q.pageSize });
});

/** IDs of eligible contacts matching the filter, capped at the campaign recipient limit ("select all eligible"). */
dataRouter.get('/contacts/eligible-ids', (req, res) => {
  const q = parse(contactQuery, req.query);
  const { st, w, params } = contactFilter({ ...q, status: undefined });
  const limit = getSettings().maxRecipientsPerCampaign;
  const ids = (
    getDb()
      .prepare(`SELECT c.id ${CONTACT_FROM} ${w ? `${w} AND` : 'WHERE'} (${st.sql}) = 'eligible' ORDER BY c.confidence DESC, c.id LIMIT ?`)
      .all(...params, ...st.params, limit) as { id: number }[]
  ).map((r) => r.id);
  res.json({ ids, limit });
});

dataRouter.get('/contacts/:id', (req, res) => {
  const id = parse(idParam, req.params.id);
  const st = contactStatusSql();
  const contact = getDb()
    .prepare(`SELECT c.*, co.name AS company_name, co.website_url, ${st.sql} AS eligibility ${CONTACT_FROM} WHERE c.id = ?`)
    .get(...st.params, id) as Record<string, unknown> | undefined;
  if (!contact) throw new HttpError(404, 'Contact not found');
  contact.confidence_explanation = JSON.parse(String(contact.confidence_explanation));
  const evidence = getDb().prepare('SELECT source_url, page_type, method, context_snippet, created_at FROM contact_evidence WHERE contact_id = ?').all(id);
  const messages = getDb()
    .prepare('SELECT m.id, m.campaign_id, m.status, m.processed_at, c.name AS campaign_name FROM campaign_messages m JOIN campaigns c ON c.id = m.campaign_id WHERE m.email = ?')
    .all(contact.email);
  res.json({ contact, evidence, messages });
});

// ---------- Suppressions ----------
dataRouter.get('/suppressions', (_req, res) => {
  res.json(getDb().prepare('SELECT * FROM suppressions ORDER BY id DESC').all());
});

dataRouter.post('/suppressions', (req, res) => {
  const body = parse(z.object({ email: z.string().max(254), reason: z.string().max(300).default('Manually suppressed') }), req.body);
  const email = normalizeEmail(body.email);
  if (!isValidEmailSyntax(email)) throw new HttpError(400, 'Invalid email address');
  getDb().prepare(`INSERT OR IGNORE INTO suppressions (email, reason, source) VALUES (?, ?, 'manual')`).run(email, body.reason);
  logEvent('suppression.added', `${email} suppressed`, undefined, { reason: body.reason });
  res.status(201).json({ ok: true });
});

dataRouter.delete('/suppressions/:id', (req, res) => {
  const id = parse(idParam, req.params.id);
  getDb().prepare('DELETE FROM suppressions WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- History & events ----------
const historyQuery = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  campaignId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

dataRouter.get('/history', (req, res) => {
  const q = parse(historyQuery, req.query);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.q) {
    where.push('(m.email LIKE ? OR m.company_name LIKE ? OR c.name LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  if (q.status) {
    where.push('m.status = ?');
    params.push(q.status);
  }
  if (q.campaignId) {
    where.push('m.campaign_id = ?');
    params.push(q.campaignId);
  }
  where.push(`m.status NOT IN ('draft','excluded')`);
  const w = `WHERE ${where.join(' AND ')}`;
  const from = 'FROM campaign_messages m JOIN campaigns c ON c.id = m.campaign_id';
  const total = count(`SELECT COUNT(*) n ${from} ${w}`, ...params);
  const items = getDb()
    .prepare(
      `SELECT m.id, m.campaign_id, c.name AS campaign_name, c.test_mode, m.email, m.recipient_name, m.company_name, m.subject, m.status,
              m.error_code, m.error_message, m.attempts, m.processed_at, m.delivered_at, m.smtp_response
       ${from} ${w} ORDER BY COALESCE(m.processed_at, m.updated_at) DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize);
  res.json({ items, total, page: q.page, pageSize: q.pageSize });
});

dataRouter.get('/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json(getDb().prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit));
});

// ---------- Excel exports (also written to data/*.xlsx) ----------
dataRouter.get('/export/companies.xlsx', async (_req, res) => {
  res.download(await exportCompanies(), 'companies.xlsx');
});
dataRouter.get('/export/contacts.xlsx', async (req, res) => {
  const ids =
    typeof req.query.ids === 'string' && req.query.ids
      ? parse(z.array(z.coerce.number().int().positive()).max(10000), req.query.ids.split(','))
      : undefined;
  res.download(await exportContacts(ids), 'contacts.xlsx');
});
dataRouter.get('/export/campaign-history.xlsx', async (_req, res) => {
  res.download(await exportCampaignHistory(), 'campaign-history.xlsx');
});
