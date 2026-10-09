import pLimit from 'p-limit';
import { HttpError } from '../campaigns/service.js';
import { config } from '../config.js';
import { recordFinding } from '../contacts/repo.js';
import { crawlCompany } from '../crawler/crawler.js';
import { getDb, logEvent, nowIso } from '../db/index.js';
import { bus, channels } from '../events.js';
import { clearRobotsCache } from '../lib/robots.js';
import { isNonOfficialDomain, normalizeWebsite, UrlError } from '../lib/url.js';
import { logger } from '../logger.js';
import { GooglePlacesProvider } from './providers/googlePlaces.js';
import { OsmProvider } from './providers/osm.js';
import { ProviderConfigError, type DiscoveredCompany, type DiscoveryCriteria, type DiscoveryProvider } from './types.js';

const providers: Record<string, DiscoveryProvider> = {
  google_places: new GooglePlacesProvider(),
  osm: new OsmProvider(),
};
let override: DiscoveryProvider | null = null;

/** Test hook. */
export function setProviderOverride(p: DiscoveryProvider | null): void {
  override = p;
}
export function allProviders(): DiscoveryProvider[] {
  return Object.values(providers);
}
export function getProvider(id?: string): DiscoveryProvider {
  if (override) return override;
  const p = providers[id ?? config().DISCOVERY_PROVIDER];
  if (!p) throw new ProviderConfigError(`Unknown discovery provider ${id}`);
  return p;
}

export class ConflictError extends Error {
  readonly status = 409;
}

export interface DiscoveryRunRow {
  id: number;
  status: string;
  provider: string;
  criteria_json: string;
  current_step: string | null;
  companies_found: number;
  companies_scanned: number;
  contacts_found: number;
  error_count: number;
  errors_json: string;
  cancel_requested: number;
  started_at: string;
  finished_at: string | null;
}

const RESCAN_AFTER_MS = 7 * 24 * 3600 * 1000;
const active = new Map<number, Promise<void>>();

export function getRun(id: number): DiscoveryRunRow | undefined {
  return getDb().prepare('SELECT * FROM discovery_runs WHERE id = ?').get(id) as DiscoveryRunRow | undefined;
}

function publish(runId: number): void {
  const run = getRun(runId);
  if (run) bus.emit(channels.discovery(runId), run);
}

function addError(runId: number, message: string): void {
  const db = getDb();
  const run = getRun(runId);
  if (!run) return;
  const errors = JSON.parse(run.errors_json) as string[];
  if (errors.length < 200) errors.push(message);
  db.prepare('UPDATE discovery_runs SET errors_json = ?, error_count = error_count + 1 WHERE id = ?').run(JSON.stringify(errors), runId);
}

function step(runId: number, text: string): void {
  getDb().prepare('UPDATE discovery_runs SET current_step = ? WHERE id = ?').run(text, runId);
  publish(runId);
}

/** Validates criteria/provider and starts a background run. Only one run may be active at a time. */
export function startDiscovery(criteria: DiscoveryCriteria, providerId?: string): number {
  const provider = getProvider(providerId);
  const st = provider.status();
  if (!st.configured) throw new ProviderConfigError(st.message);
  const invalid = provider.validate?.(criteria);
  if (invalid) throw new HttpError(400, invalid);
  const db = getDb();
  let runId: number;
  try {
    runId = Number(
      db
        .prepare(`INSERT INTO discovery_runs (status, provider, criteria_json, current_step) VALUES ('running', ?, ?, 'Starting')`)
        .run(provider.id, JSON.stringify(criteria)).lastInsertRowid,
    );
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) throw new ConflictError('A discovery run is already in progress.');
    throw e;
  }
  logEvent('discovery.started', `Discovery run ${runId} started`, { type: 'discovery_run', id: runId }, criteria);
  const p = executeRun(runId, provider, criteria).finally(() => active.delete(runId));
  active.set(runId, p);
  return runId;
}

export function cancelDiscovery(runId: number): boolean {
  const r = getDb().prepare(`UPDATE discovery_runs SET cancel_requested = 1 WHERE id = ? AND status = 'running'`).run(runId);
  return r.changes > 0;
}

/** Waits for a background run (tests / graceful shutdown). */
export async function waitForRun(runId: number): Promise<void> {
  await active.get(runId);
}

function upsertCompany(runId: number, providerId: string, d: DiscoveredCompany): { id: number; domain: string | null; scan: boolean } {
  const db = getDb();
  return db.transaction(() => {
    const src = db
      .prepare('SELECT company_id FROM company_sources WHERE provider = ? AND provider_ref = ?')
      .get(providerId, d.providerRef) as { company_id: number } | undefined;

    let website: string | null = null;
    let domain: string | null = null;
    let status = 'discovered';
    let scanError: string | null = null;
    if (!d.website) {
      status = 'no_website';
    } else {
      try {
        const n = normalizeWebsite(d.website);
        if (isNonOfficialDomain(n.domain)) {
          status = 'invalid_website';
          scanError = `Listed website ${n.domain} is a social/directory page, not an official site`;
        } else {
          website = n.url;
          domain = n.domain;
        }
      } catch (e) {
        status = 'invalid_website';
        scanError = e instanceof UrlError ? e.message : 'Invalid website';
      }
    }

    let companyId: number | undefined = src?.company_id;
    if (!companyId && domain) {
      companyId = (db.prepare('SELECT id FROM companies WHERE domain = ?').get(domain) as { id: number } | undefined)?.id;
    }
    if (companyId) {
      db.prepare(
        `UPDATE companies SET address = COALESCE(address, ?), city = COALESCE(city, ?), state = COALESCE(state, ?),
           country = COALESCE(country, ?), industry = COALESCE(industry, ?), last_run_id = ?, updated_at = ? WHERE id = ?`,
      ).run(d.address, d.city, d.state, d.country, d.industry, runId, nowIso(), companyId);
    } else {
      companyId = Number(
        db
          .prepare(
            `INSERT INTO companies (name, domain, website_url, country, state, city, address, industry, discovery_status, scan_error, last_run_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(d.name, domain, website, d.country, d.state, d.city, d.address, d.industry, status, scanError, runId).lastInsertRowid,
      );
    }
    db.prepare(
      'INSERT OR IGNORE INTO company_sources (company_id, provider, provider_ref, run_id, raw_json, source_url) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(companyId, providerId, d.providerRef, runId, JSON.stringify(d.raw).slice(0, 20000), d.sourceUrl ?? null);

    const row = db.prepare('SELECT domain, discovery_status, last_scanned_at FROM companies WHERE id = ?').get(companyId) as {
      domain: string | null;
      discovery_status: string;
      last_scanned_at: string | null;
    };
    const recentlyScanned = row.last_scanned_at && Date.now() - Date.parse(row.last_scanned_at) < RESCAN_AFTER_MS;
    const scan = Boolean(row.domain) && !recentlyScanned && row.discovery_status !== 'invalid_website';
    return { id: companyId, domain: row.domain, scan };
  })();
}

async function executeRun(runId: number, provider: DiscoveryProvider, criteria: DiscoveryCriteria): Promise<void> {
  const db = getDb();
  const cancelled = () => (getRun(runId)?.cancel_requested ?? 1) === 1;
  const toScan: { id: number; domain: string; website: string }[] = [];
  let providerNote: string | null = null;
  try {
    step(runId, `Searching ${provider.status().label}`);
    const report = (note: string) => {
      providerNote = note;
      step(runId, note);
    };
    for await (const d of provider.search(criteria, cancelled, report)) {
      const c = upsertCompany(runId, provider.id, d);
      db.prepare('UPDATE discovery_runs SET companies_found = companies_found + 1 WHERE id = ?').run(runId);
      if (c.scan && c.domain) {
        const w = db.prepare('SELECT website_url FROM companies WHERE id = ?').get(c.id) as { website_url: string };
        toScan.push({ id: c.id, domain: c.domain, website: w.website_url });
      }
      publish(runId);
    }

    step(runId, `Scanning ${toScan.length} websites`);
    const limit = pLimit(config().CRAWL_CONCURRENCY);
    await Promise.all(
      toScan.map((co) =>
        limit(async () => {
          if (cancelled()) return;
          db.prepare(`UPDATE companies SET discovery_status = 'scanning', updated_at = ? WHERE id = ?`).run(nowIso(), co.id);
          let newContacts = 0;
          try {
            const res = await crawlCompany(co.website, co.domain, { maxPages: criteria.maxPagesPerCompany, shouldStop: cancelled });
            for (const page of res.pages) {
              for (const f of page.findings) {
                if (await recordFinding({ id: co.id, domain: co.domain }, f, page, runId)) newContacts++;
              }
            }
            const note = res.status === 'scanned' ? (res.errors.length ? res.errors.slice(0, 5).join('; ') : null) : [res.note, ...res.errors].filter(Boolean).join('; ');
            db.prepare(
              `UPDATE companies SET discovery_status = ?, scan_error = ?, pages_scanned = ?, last_scanned_at = ?, updated_at = ? WHERE id = ?`,
            ).run(res.status, note, res.pagesFetched, nowIso(), nowIso(), co.id);
            if (res.status !== 'scanned') addError(runId, `${co.domain}: ${res.status}${note ? ` — ${note}` : ''}`);
          } catch (e) {
            db.prepare(`UPDATE companies SET discovery_status = 'scan_failed', scan_error = ?, updated_at = ? WHERE id = ?`).run(
              (e as Error).message,
              nowIso(),
              co.id,
            );
            addError(runId, `${co.domain}: ${(e as Error).message}`);
          }
          db.prepare('UPDATE discovery_runs SET companies_scanned = companies_scanned + 1, contacts_found = contacts_found + ? WHERE id = ?').run(
            newContacts,
            runId,
          );
          publish(runId);
        }),
      ),
    );
    const final = cancelled() ? 'cancelled' : 'completed';
    db.prepare(`UPDATE discovery_runs SET status = ?, current_step = ?, finished_at = ? WHERE id = ?`).run(
      final,
      final === 'cancelled' ? 'Cancelled — results so far were kept' : providerNote ? `Done. ${providerNote}` : 'Done',
      nowIso(),
      runId,
    );
    logEvent(`discovery.${final}`, `Discovery run ${runId} ${final}`, { type: 'discovery_run', id: runId });
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn({ runId, err: msg }, 'discovery run failed');
    addError(runId, msg);
    db.prepare(`UPDATE discovery_runs SET status = 'failed', current_step = ?, finished_at = ? WHERE id = ?`).run(
      e instanceof ProviderConfigError ? `Setup required: ${msg}` : `Failed: ${msg}`,
      nowIso(),
      runId,
    );
    logEvent('discovery.failed', msg, { type: 'discovery_run', id: runId });
  } finally {
    db.prepare(`UPDATE companies SET discovery_status = 'discovered' WHERE discovery_status = 'scanning' AND last_run_id = ?`).run(runId);
    clearRobotsCache();
    publish(runId);
  }
}

/** On boot: runs left "running" by a crash/restart are marked interrupted; their saved results remain. */
export function recoverInterruptedRuns(): void {
  const db = getDb();
  db.prepare(`UPDATE discovery_runs SET status = 'interrupted', current_step = 'Interrupted by server restart — results so far were kept', finished_at = ? WHERE status = 'running'`).run(nowIso());
  db.prepare(`UPDATE companies SET discovery_status = 'discovered' WHERE discovery_status = 'scanning'`).run();
}
