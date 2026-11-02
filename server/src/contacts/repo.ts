import { config } from '../config.js';
import { classifyContact, type EvidenceInput } from '../crawler/classify.js';
import type { EmailFinding, PageType } from '../crawler/extract.js';
import { normalizeEmail } from '../crawler/extract.js';
import { checkMx } from '../crawler/mx.js';
import { getDb, nowIso } from '../db/index.js';
import { getSettings } from '../settings.js';

export interface ContactRow {
  id: number;
  company_id: number;
  email: string;
  name: string | null;
  role_title: string | null;
  contact_type: string;
  syntax_valid: number;
  domain_matches_company: number;
  mx_checked: number;
  mx_valid: number | null;
  confidence: number;
  confidence_explanation: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * Records one finding for a company: de-duplicates by normalized email, appends evidence,
 * and recomputes classification from *all* evidence collected so far.
 * Returns true if this created a new contact.
 */
export async function recordFinding(
  company: { id: number; domain: string | null },
  finding: EmailFinding,
  page: { url: string; pageType: PageType },
  runId: number | null,
): Promise<boolean> {
  const db = getDb();
  const email = normalizeEmail(finding.email);
  const emailDomain = email.split('@')[1] ?? '';

  let mx: { checked: boolean; valid: boolean | null } = { checked: false, valid: null };
  if (config().CRAWL_CHECK_MX) {
    const v = await checkMx(emailDomain);
    mx = v === null ? { checked: false, valid: null } : { checked: true, valid: v };
  }

  return db.transaction(() => {
    let existing = db.prepare('SELECT * FROM contacts WHERE email = ?').get(email) as ContactRow | undefined;
    const created = !existing;
    if (!existing) {
      const r = db
        .prepare(
          `INSERT INTO contacts (company_id, email, contact_type, syntax_valid, domain_matches_company, confidence, confidence_explanation)
           VALUES (?, ?, 'Other', 0, 0, 0, '[]')`,
        )
        .run(company.id, email);
      existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid) as ContactRow;
    }
    db.prepare(
      `INSERT OR IGNORE INTO contact_evidence (contact_id, source_url, page_type, method, context_snippet, run_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(existing.id, page.url, page.pageType, finding.method, [finding.heading, finding.context].filter(Boolean).join(' — '), runId);

    const evidence = db
      .prepare('SELECT source_url, page_type, method, context_snippet FROM contact_evidence WHERE contact_id = ?')
      .all(existing.id) as { source_url: string; page_type: PageType; method: 'mailto' | 'text'; context_snippet: string | null }[];
    const ownerDomain = (db.prepare('SELECT domain FROM companies WHERE id = ?').get(existing.company_id) as { domain: string | null })
      .domain;
    const cls = classifyContact({
      email,
      companyDomain: ownerDomain ?? company.domain,
      evidence: evidence.map<EvidenceInput>((e) => ({
        sourceUrl: e.source_url,
        pageType: e.page_type,
        method: e.method,
        context: e.context_snippet ?? '',
      })),
      mx,
    });
    db.prepare(
      `UPDATE contacts SET name = COALESCE(?, name), role_title = COALESCE(?, role_title), contact_type = ?, syntax_valid = ?,
         domain_matches_company = ?, mx_checked = ?, mx_valid = ?, confidence = ?, confidence_explanation = ?,
         status = ?, last_seen_at = ? WHERE id = ?`,
    ).run(
      cls.name,
      cls.roleTitle,
      cls.contactType,
      cls.syntaxValid ? 1 : 0,
      cls.domainMatchesCompany ? 1 : 0,
      mx.checked ? 1 : 0,
      mx.valid === null ? null : mx.valid ? 1 : 0,
      cls.confidence,
      JSON.stringify(cls.explanation),
      cls.syntaxValid && mx.valid !== false ? 'active' : 'invalid',
      nowIso(),
      existing.id,
    );
    return created;
  })();
}

/** Bump when classification rules change: stored contacts are re-classified from their saved evidence on startup. */
export const CLASSIFIER_VERSION = 2;

/** Re-runs classification for every contact using stored evidence and MX results (no network). */
export function reclassifyAll(): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.id, c.email, c.status, c.mx_checked, c.mx_valid, co.domain, co.scan_error
       FROM contacts c JOIN companies co ON co.id = c.company_id`,
    )
    .all() as { id: number; email: string; status: string; mx_checked: number; mx_valid: number | null; domain: string | null; scan_error: string | null }[];
  const evidenceStmt = db.prepare('SELECT source_url, page_type, method, context_snippet FROM contact_evidence WHERE contact_id = ?');
  const update = db.prepare(
    `UPDATE contacts SET name = ?, role_title = ?, contact_type = ?, syntax_valid = ?, domain_matches_company = ?, confidence = ?,
       confidence_explanation = ?, status = ? WHERE id = ?`,
  );
  db.transaction(() => {
    for (const r of rows) {
      const ev = evidenceStmt.all(r.id) as { source_url: string; page_type: PageType; method: 'mailto' | 'text'; context_snippet: string | null }[];
      const mx = { checked: r.mx_checked === 1, valid: r.mx_valid === null ? null : r.mx_valid === 1 };
      const cls = classifyContact({
        email: r.email,
        companyDomain: r.domain,
        evidence: ev.map((e) => ({ sourceUrl: e.source_url, pageType: e.page_type, method: e.method, context: e.context_snippet ?? '' })),
        mx,
      });
      const institutional = /University \/ government/.test(r.scan_error ?? '');
      const status = institutional ? 'invalid' : cls.syntaxValid && mx.valid !== false ? 'active' : 'invalid';
      update.run(cls.name, cls.roleTitle, cls.contactType, cls.syntaxValid ? 1 : 0, cls.domainMatchesCompany ? 1 : 0, cls.confidence,
        JSON.stringify(cls.explanation), status, r.id);
    }
  })();
  return rows.length;
}

export function reclassifyIfOutdated(): number {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'classifier_version'`).get() as { value: string } | undefined;
  if (row && Number(row.value) >= CLASSIFIER_VERSION) return 0;
  const n = reclassifyAll();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('classifier_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    String(CLASSIFIER_VERSION),
  );
  return n;
}

/** SQL fragment computing a contact's display status / eligibility. Requires aliases c (contacts), s (suppressions). */
export function contactStatusSql(): { sql: string; params: number[] } {
  const { minConfidence, onePerCompany } = getSettings();
  return {
    sql: `CASE
      WHEN s.id IS NOT NULL THEN 'suppressed'
      WHEN ${contactedSql('c')} THEN 'contacted'
      WHEN c.status <> 'active' OR c.syntax_valid = 0 THEN 'invalid'
      ${onePerCompany ? `WHEN ${companyContactedSql('c')} THEN 'company_contacted'` : ''}
      WHEN c.confidence < ? THEN 'low_confidence'
      ELSE 'eligible' END`,
    params: [minConfidence],
  };
}

/** True when this address was emailed here (send_ledger) or on another machine (imported history). */
export function contactedSql(alias: string): string {
  return `(EXISTS (SELECT 1 FROM send_ledger l WHERE l.email = ${alias}.email) OR EXISTS (SELECT 1 FROM contacted_history h WHERE h.email = ${alias}.email))`;
}

/** True when another contact at the same company was already emailed. */
export function companyContactedSql(alias: string): string {
  return `(EXISTS (SELECT 1 FROM contacts c2 WHERE c2.company_id = ${alias}.company_id AND c2.id <> ${alias}.id AND ${contactedSql('c2')})
    OR EXISTS (SELECT 1 FROM contacted_history h2 JOIN companies co2 ON co2.domain = h2.company_domain WHERE co2.id = ${alias}.company_id))`;
}

/** Who to write to first at a company when applying for a job. Lower is better. */
export const CONTACT_TYPE_PRIORITY = ['HR', 'Talent Acquisition', 'Recruiter', 'Recruitment', 'Careers', 'Hiring', 'Founder', 'CEO', 'General Contact', 'Other'];

export function typeRankSql(alias: string): string {
  return `CASE ${alias}.contact_type ${CONTACT_TYPE_PRIORITY.map((t, i) => `WHEN '${t}' THEN ${i}`).join(' ')} ELSE 99 END`;
}

/**
 * Sub-query returning the single best *eligible* contact id per company
 * (by role priority, then confidence, then age). Use as `c.id IN (<sql>)`.
 */
export function bestPerCompanySql(): { sql: string; params: number[] } {
  const st = contactStatusSql();
  return {
    sql: `SELECT id FROM (
      SELECT c.id, ROW_NUMBER() OVER (PARTITION BY c.company_id ORDER BY ${typeRankSql('c')}, c.confidence DESC, c.id) AS rn
      FROM contacts c LEFT JOIN suppressions s ON s.email = c.email
      WHERE (${st.sql}) = 'eligible'
    ) WHERE rn = 1`,
    params: st.params,
  };
}
