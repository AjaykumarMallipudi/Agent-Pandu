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

/** SQL fragment computing a contact's display status / eligibility. Requires aliases c (contacts), s (suppressions). */
export function contactStatusSql(): { sql: string; params: number[] } {
  const min = getSettings().minConfidence;
  return {
    sql: `CASE
      WHEN s.id IS NOT NULL THEN 'suppressed'
      WHEN EXISTS (SELECT 1 FROM send_ledger l WHERE l.email = c.email) THEN 'contacted'
      WHEN c.status <> 'active' OR c.syntax_valid = 0 THEN 'invalid'
      WHEN c.confidence < ? THEN 'low_confidence'
      ELSE 'eligible' END`,
    params: [min],
  };
}
