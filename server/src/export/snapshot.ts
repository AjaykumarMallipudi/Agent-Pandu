import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb, logEvent, nowIso } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Git-friendly data snapshot in data/snapshot/*.json.
 *
 * Commit these files to carry scraped companies/contacts (with evidence), opt-outs, the list of
 * addresses already emailed, and your templates to another machine. On a fresh clone the server
 * imports them automatically into an empty database; `npm run data:import` merges them any time.
 *
 * Files are sorted and pretty-printed so diffs stay small. Secrets (.env, SMTP) are never included.
 */

export const SNAPSHOT_VERSION = 1;
export function snapshotDir(): string {
  return path.join(config().dataDir, 'snapshot');
}

interface SnapshotCompany {
  key: string;
  name: string;
  domain: string | null;
  website_url: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  industry: string | null;
  discovery_status: string;
  scan_error: string | null;
  pages_scanned: number;
  last_scanned_at: string | null;
  created_at: string;
  sources: { provider: string; provider_ref: string; source_url: string | null }[];
}
interface SnapshotContact {
  email: string;
  company_key: string;
  name: string | null;
  role_title: string | null;
  contact_type: string;
  syntax_valid: number;
  domain_matches_company: number;
  mx_checked: number;
  mx_valid: number | null;
  confidence: number;
  confidence_explanation: string[];
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  evidence: { source_url: string; page_type: string; method: string; context_snippet: string | null }[];
}
interface SnapshotSuppression {
  email: string;
  reason: string;
  source: string;
  created_at: string;
}
interface SnapshotContacted {
  email: string;
  company_domain: string | null;
  contacted_at: string;
  source: string;
}
interface SnapshotTemplate {
  name: string;
  subject: string;
  html: string;
  text: string;
  attach_resume: number;
}

export interface SnapshotCounts {
  companies: number;
  contacts: number;
  suppressions: number;
  contacted: number;
  templates: number;
}

const companyKey = (domain: string | null, sources: { provider: string; provider_ref: string }[]) =>
  domain ?? (sources[0] ? `${sources[0].provider}:${sources[0].provider_ref}` : null);

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file); // atomic replace: a crash never leaves a half-written file
}
function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function exportSnapshot(): SnapshotCounts & { dir: string } {
  const db = getDb();
  const dir = snapshotDir();
  fs.mkdirSync(dir, { recursive: true });

  const sourcesBy = new Map<number, SnapshotCompany['sources']>();
  for (const s of db.prepare('SELECT company_id, provider, provider_ref, source_url FROM company_sources ORDER BY provider, provider_ref').all() as {
    company_id: number;
    provider: string;
    provider_ref: string;
    source_url: string | null;
  }[]) {
    const list = sourcesBy.get(s.company_id) ?? [];
    list.push({ provider: s.provider, provider_ref: s.provider_ref, source_url: s.source_url });
    sourcesBy.set(s.company_id, list);
  }

  const keyById = new Map<number, string>();
  const companies: SnapshotCompany[] = [];
  for (const c of db.prepare('SELECT * FROM companies').all() as (Omit<SnapshotCompany, 'key' | 'sources'> & { id: number })[]) {
    const sources = sourcesBy.get(c.id) ?? [];
    const key = companyKey(c.domain, sources) ?? `company:${c.name}`;
    keyById.set(c.id, key);
    companies.push({
      key,
      name: c.name,
      domain: c.domain,
      website_url: c.website_url,
      country: c.country,
      state: c.state,
      city: c.city,
      address: c.address,
      industry: c.industry,
      discovery_status: c.discovery_status === 'scanning' ? 'discovered' : c.discovery_status,
      scan_error: c.scan_error,
      pages_scanned: c.pages_scanned,
      last_scanned_at: c.last_scanned_at,
      created_at: c.created_at,
      sources,
    });
  }
  companies.sort((a, b) => a.key.localeCompare(b.key));

  const evidenceBy = new Map<number, SnapshotContact['evidence']>();
  for (const e of db
    .prepare('SELECT contact_id, source_url, page_type, method, context_snippet FROM contact_evidence ORDER BY source_url, method')
    .all() as ({ contact_id: number } & SnapshotContact['evidence'][number])[]) {
    const list = evidenceBy.get(e.contact_id) ?? [];
    list.push({ source_url: e.source_url, page_type: e.page_type, method: e.method, context_snippet: e.context_snippet });
    evidenceBy.set(e.contact_id, list);
  }
  const contacts: SnapshotContact[] = (
    db.prepare('SELECT * FROM contacts').all() as (Omit<SnapshotContact, 'company_key' | 'evidence' | 'confidence_explanation'> & {
      id: number;
      company_id: number;
      confidence_explanation: string;
    })[]
  )
    .map((c) => ({
      email: c.email,
      company_key: keyById.get(c.company_id)!,
      name: c.name,
      role_title: c.role_title,
      contact_type: c.contact_type,
      syntax_valid: c.syntax_valid,
      domain_matches_company: c.domain_matches_company,
      mx_checked: c.mx_checked,
      mx_valid: c.mx_valid,
      confidence: c.confidence,
      confidence_explanation: JSON.parse(c.confidence_explanation) as string[],
      status: c.status,
      first_seen_at: c.first_seen_at,
      last_seen_at: c.last_seen_at,
      evidence: evidenceBy.get(c.id) ?? [],
    }))
    .sort((a, b) => a.email.localeCompare(b.email));

  const suppressions = db.prepare('SELECT email, reason, source, created_at FROM suppressions ORDER BY email').all() as SnapshotSuppression[];

  // Everyone emailed for real (accepted, delivered, bounced or unknown outcome) plus previously imported history.
  const contacted = db
    .prepare(
      `SELECT email, company_domain, MIN(contacted_at) AS contacted_at, MIN(source) AS source FROM (
         SELECT l.email, co.domain AS company_domain, COALESCE(m.submit_started_at, l.created_at) AS contacted_at, 'campaign' AS source
         FROM send_ledger l JOIN campaign_messages m ON m.id = l.message_id
         LEFT JOIN contacts c ON c.id = m.contact_id LEFT JOIN companies co ON co.id = c.company_id
         WHERE l.state IN ('accepted', 'unknown')
         UNION ALL
         SELECT email, company_domain, contacted_at, source FROM contacted_history
       ) GROUP BY email ORDER BY email`,
    )
    .all() as SnapshotContacted[];

  const templates = db.prepare('SELECT name, subject, html, text, attach_resume FROM email_templates ORDER BY name').all() as SnapshotTemplate[];

  writeJson(path.join(dir, 'companies.json'), companies);
  writeJson(path.join(dir, 'contacts.json'), contacts);
  writeJson(path.join(dir, 'suppressions.json'), suppressions);
  writeJson(path.join(dir, 'contacted.json'), contacted);
  writeJson(path.join(dir, 'templates.json'), templates);
  const counts = { companies: companies.length, contacts: contacts.length, suppressions: suppressions.length, contacted: contacted.length, templates: templates.length };
  writeJson(path.join(dir, 'meta.json'), { version: SNAPSHOT_VERSION, counts });
  return { ...counts, dir };
}

export function snapshotExists(): boolean {
  return fs.existsSync(path.join(snapshotDir(), 'companies.json'));
}

/** Merges the snapshot into the database. Existing rows win; nothing is deleted. */
export function importSnapshot(): SnapshotCounts & { added: SnapshotCounts } {
  const db = getDb();
  const dir = snapshotDir();
  const companies = readJson<SnapshotCompany[]>(path.join(dir, 'companies.json'), []);
  const contacts = readJson<SnapshotContact[]>(path.join(dir, 'contacts.json'), []);
  const suppressions = readJson<SnapshotSuppression[]>(path.join(dir, 'suppressions.json'), []);
  const contacted = readJson<SnapshotContacted[]>(path.join(dir, 'contacted.json'), []);
  const templates = readJson<SnapshotTemplate[]>(path.join(dir, 'templates.json'), []);
  const added: SnapshotCounts = { companies: 0, contacts: 0, suppressions: 0, contacted: 0, templates: 0 };

  db.transaction(() => {
    const idByKey = new Map<string, number>();
    for (const c of companies) {
      let id: number | undefined;
      if (c.domain) id = (db.prepare('SELECT id FROM companies WHERE domain = ?').get(c.domain) as { id: number } | undefined)?.id;
      for (const s of c.sources) {
        if (id) break;
        id = (db.prepare('SELECT company_id AS id FROM company_sources WHERE provider = ? AND provider_ref = ?').get(s.provider, s.provider_ref) as
          | { id: number }
          | undefined)?.id;
      }
      if (!id) {
        id = Number(
          db
            .prepare(
              `INSERT INTO companies (name, domain, website_url, country, state, city, address, industry, discovery_status, scan_error,
                 pages_scanned, last_scanned_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(c.name, c.domain, c.website_url, c.country, c.state, c.city, c.address, c.industry, c.discovery_status, c.scan_error, c.pages_scanned,
              c.last_scanned_at, c.created_at).lastInsertRowid,
        );
        added.companies++;
      }
      for (const s of c.sources) {
        db.prepare('INSERT OR IGNORE INTO company_sources (company_id, provider, provider_ref, source_url) VALUES (?, ?, ?, ?)').run(
          id,
          s.provider,
          s.provider_ref,
          s.source_url,
        );
      }
      idByKey.set(c.key, id);
    }

    for (const c of contacts) {
      const companyId = idByKey.get(c.company_key);
      if (!companyId) continue;
      let id = (db.prepare('SELECT id FROM contacts WHERE email = ?').get(c.email) as { id: number } | undefined)?.id;
      if (!id) {
        id = Number(
          db
            .prepare(
              `INSERT INTO contacts (company_id, email, name, role_title, contact_type, syntax_valid, domain_matches_company, mx_checked, mx_valid,
                 confidence, confidence_explanation, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(companyId, c.email, c.name, c.role_title, c.contact_type, c.syntax_valid, c.domain_matches_company, c.mx_checked, c.mx_valid,
              c.confidence, JSON.stringify(c.confidence_explanation), c.status, c.first_seen_at, c.last_seen_at).lastInsertRowid,
        );
        added.contacts++;
      }
      for (const e of c.evidence) {
        db.prepare(
          'INSERT OR IGNORE INTO contact_evidence (contact_id, source_url, page_type, method, context_snippet) VALUES (?, ?, ?, ?, ?)',
        ).run(id, e.source_url, e.page_type, e.method, e.context_snippet);
      }
    }

    for (const s of suppressions) {
      added.suppressions += db
        .prepare('INSERT OR IGNORE INTO suppressions (email, reason, source, created_at) VALUES (?, ?, ?, ?)')
        .run(s.email, s.reason, s.source, s.created_at).changes;
    }
    for (const h of contacted) {
      // Already emailed from this machine: the ledger has it.
      if (db.prepare('SELECT 1 FROM send_ledger WHERE email = ?').get(h.email)) continue;
      added.contacted += db
        .prepare('INSERT OR IGNORE INTO contacted_history (email, company_domain, contacted_at, source) VALUES (?, ?, ?, ?)')
        .run(h.email, h.company_domain, h.contacted_at, h.source === 'campaign' ? 'snapshot' : h.source).changes;
    }
    for (const t of templates) {
      added.templates += db
        .prepare('INSERT OR IGNORE INTO email_templates (name, subject, html, text, attach_resume) VALUES (?, ?, ?, ?, ?)')
        .run(t.name, t.subject, t.html, t.text, t.attach_resume).changes;
    }
  })();

  logEvent('snapshot.imported', `Imported data snapshot`, undefined, added);
  return {
    companies: companies.length,
    contacts: contacts.length,
    suppressions: suppressions.length,
    contacted: contacted.length,
    templates: templates.length,
    added,
  };
}

/** On first start of a fresh clone: load the committed snapshot into the empty database. */
export function importSnapshotIfEmpty(): void {
  const empty = (getDb().prepare('SELECT COUNT(*) n FROM companies').get() as { n: number }).n === 0;
  if (!empty || !snapshotExists()) return;
  const r = importSnapshot();
  logger.info(r.added, `Loaded data snapshot from ${snapshotDir()}`);
}

let timer: NodeJS.Timeout | null = null;
/** Debounced auto-export after data changes (discovery runs, sends, opt-outs, template edits). */
export function scheduleSnapshot(): void {
  if (process.env.NODE_ENV === 'test' || config().SNAPSHOT_AUTO === false) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try {
      const r = exportSnapshot();
      logger.info({ companies: r.companies, contacts: r.contacts }, `Data snapshot saved to ${r.dir} (${nowIso()})`);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'Data snapshot export failed');
    }
  }, 3000);
  timer.unref();
}
