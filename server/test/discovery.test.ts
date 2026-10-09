import nock from 'nock';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { recordFinding } from '../src/contacts/repo.js';
import { getDb } from '../src/db/index.js';
import { GooglePlacesProvider } from '../src/discovery/providers/googlePlaces.js';
import { OsmProvider } from '../src/discovery/providers/osm.js';
import { getRun, recoverInterruptedRuns, setProviderOverride, startDiscovery, waitForRun } from '../src/discovery/runner.js';
import { criteriaSchema, ProviderConfigError, ProviderError, type DiscoveredCompany, type DiscoveryProvider } from '../src/discovery/types.js';
import { setupTestEnv } from './helpers.js';

const criteria = criteriaSchema.parse({ country: 'India', state: 'Karnataka', city: 'Bengaluru', industry: 'software', maxCompanies: 10, maxPagesPerCompany: 3 });
const HTML = { 'Content-Type': 'text/html' };
const H = { 'X-Applytick': '1' };

async function drain(gen: AsyncGenerator<DiscoveredCompany>) {
  const out: DiscoveredCompany[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

function fakeProvider(companies: DiscoveredCompany[], opts: { failAfter?: number; delayMs?: number } = {}): DiscoveryProvider {
  return {
    id: 'fake',
    status: () => ({ id: 'fake', label: 'Fake', configured: true, message: 'ok' }),
    async *search(_c, shouldStop) {
      let i = 0;
      for (const c of companies) {
        if (shouldStop()) return;
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.failAfter !== undefined && i++ >= opts.failAfter) throw new ProviderError('upstream exploded', 500);
        yield c;
      }
    },
  };
}
const company = (ref: string, name: string, website: string | null): DiscoveredCompany => ({
  providerRef: ref, name, website, address: null, city: 'Bengaluru', state: 'Karnataka', country: 'India', industry: 'software', raw: {},
});

describe('Google Places provider', () => {
  beforeEach(() => {
    setupTestEnv();
  });

  it('reports missing credentials clearly and never invents results', async () => {
    const p = new GooglePlacesProvider();
    expect(p.status().configured).toBe(false);
    expect(p.status().message).toMatch(/GOOGLE_PLACES_API_KEY/);
    await expect(drain(p.search(criteria, () => false))).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it('maps API results and follows pagination', async () => {
    setupTestEnv({ GOOGLE_PLACES_API_KEY: 'test-key' });
    nock('https://places.googleapis.com')
      .post('/v1/places:searchText', (b) => !b.pageToken)
      .matchHeader('X-Goog-Api-Key', 'test-key')
      .reply(200, {
        places: [
          {
            id: 'p1', displayName: { text: 'Acme Soft' }, websiteUri: 'https://acme.example/', formattedAddress: 'MG Road',
            addressComponents: [{ longText: 'Bengaluru', types: ['locality'] }, { longText: 'Karnataka', types: ['administrative_area_level_1'] }],
          },
        ],
        nextPageToken: 'next',
      })
      .post('/v1/places:searchText', (b) => b.pageToken === 'next')
      .reply(200, { places: [{ id: 'p2', displayName: { text: 'NoSite Ltd' } }] });
    const res = await drain(new GooglePlacesProvider().search(criteria, () => false));
    expect(res.map((r) => [r.name, r.website, r.city])).toEqual([
      ['Acme Soft', 'https://acme.example/', 'Bengaluru'],
      ['NoSite Ltd', null, 'Bengaluru'],
    ]);
  });

  it('turns auth errors into setup errors and server errors into provider errors', async () => {
    setupTestEnv({ GOOGLE_PLACES_API_KEY: 'bad' });
    nock('https://places.googleapis.com').post('/v1/places:searchText').reply(403, { error: { message: 'API key not valid' } });
    await expect(drain(new GooglePlacesProvider().search(criteria, () => false))).rejects.toThrow(/API key not valid/);
    nock('https://places.googleapis.com').post('/v1/places:searchText').reply(503, { error: { message: 'backend' } });
    await expect(drain(new GooglePlacesProvider().search(criteria, () => false))).rejects.toBeInstanceOf(ProviderError);
  });

  it('OSM provider requires a contact email', async () => {
    await expect(drain(new OsmProvider().search(criteria, () => false))).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it('API refuses to start a Google run without credentials (400, setup message)', async () => {
    const res = await request(createApp()).post('/api/discovery/runs').set(H).send({ criteria, provider: 'google_places' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/GOOGLE_PLACES_API_KEY/);
    expect(getDb().prepare('SELECT COUNT(*) n FROM discovery_runs').get()).toEqual({ n: 0 });
  });
});

describe('discovery runs', () => {
  beforeEach(() => {
    setupTestEnv();
  });

  it('discovers companies, crawls sites and stores contacts with evidence', async () => {
    nock('https://acme.example')
      .get('/robots.txt').reply(404)
      .get('/').reply(200, '<body><a href="/careers">Careers</a></body>', HTML)
      .get('/careers').reply(200, '<body><h2>Careers</h2><p>Email your CV to <a href="mailto:careers@acme.example">careers@acme.example</a></p></body>', HTML);
    setProviderOverride(
      fakeProvider([company('a', 'Acme', 'https://acme.example'), company('b', 'Facebook Only', 'https://facebook.com/x'), company('c', 'No Site', null)]),
    );
    const id = startDiscovery(criteria);
    await waitForRun(id);
    const run = getRun(id)!;
    expect(run.status).toBe('completed');
    expect(run.companies_found).toBe(3);
    expect(run.companies_scanned).toBe(1);
    expect(run.contacts_found).toBe(1);
    const statuses = getDb().prepare('SELECT name, discovery_status FROM companies ORDER BY id').all();
    expect(statuses).toEqual([
      { name: 'Acme', discovery_status: 'scanned' },
      { name: 'Facebook Only', discovery_status: 'invalid_website' },
      { name: 'No Site', discovery_status: 'no_website' },
    ]);
    const contact = getDb().prepare('SELECT email, contact_type, confidence FROM contacts').get() as { email: string; contact_type: string; confidence: number };
    expect(contact).toMatchObject({ email: 'careers@acme.example', contact_type: 'Careers' });
    const evidence = getDb().prepare('SELECT source_url, method FROM contact_evidence').all();
    expect(evidence).toEqual([{ source_url: 'https://acme.example/careers', method: 'mailto' }]);
  });

  it('records provider failures and keeps partial results', async () => {
    setProviderOverride(fakeProvider([company('a', 'A', null), company('b', 'B', null)], { failAfter: 1 }));
    const id = startDiscovery(criteria);
    await waitForRun(id);
    const run = getRun(id)!;
    expect(run.status).toBe('failed');
    expect(run.errors_json).toContain('upstream exploded');
    expect(getDb().prepare('SELECT COUNT(*) n FROM companies').get()).toEqual({ n: 1 });
  });

  it('prevents conflicting simultaneous runs', async () => {
    setProviderOverride(fakeProvider([company('a', 'A', null)], { delayMs: 200 }));
    const app = createApp();
    const first = await request(app).post('/api/discovery/runs').set(H).send({ criteria });
    expect(first.status).toBe(202);
    const second = await request(app).post('/api/discovery/runs').set(H).send({ criteria });
    expect(second.status).toBe(409);
    await waitForRun(first.body.id);
  });

  it('marks runs interrupted by a restart without losing results', () => {
    getDb().prepare(`INSERT INTO discovery_runs (status, provider, criteria_json) VALUES ('running', 'fake', '{}')`).run();
    getDb().prepare(`INSERT INTO companies (name, domain, discovery_status) VALUES ('Kept', 'kept.example', 'scanning')`).run();
    recoverInterruptedRuns();
    expect(getRun(1)!.status).toBe('interrupted');
    expect(getDb().prepare('SELECT discovery_status FROM companies').get()).toEqual({ discovery_status: 'discovered' });
  });
});

describe('deduplication', () => {
  beforeEach(() => {
    setupTestEnv();
  });

  it('merges the same address across pages/case and aggregates evidence', async () => {
    const co = Number(getDb().prepare(`INSERT INTO companies (name, domain) VALUES ('Acme', 'acme.com')`).run().lastInsertRowid);
    const f = { email: 'HR@Acme.com', method: 'mailto' as const, context: 'HR team' };
    expect(await recordFinding({ id: co, domain: 'acme.com' }, f, { url: 'https://acme.com/contact', pageType: 'contact' }, null)).toBe(true);
    expect(await recordFinding({ id: co, domain: 'acme.com' }, { ...f, email: 'hr@acme.com' }, { url: 'https://acme.com/careers', pageType: 'careers' }, null)).toBe(false);
    expect(await recordFinding({ id: co, domain: 'acme.com' }, f, { url: 'https://acme.com/contact', pageType: 'contact' }, null)).toBe(false);
    expect(getDb().prepare('SELECT COUNT(*) n FROM contacts').get()).toEqual({ n: 1 });
    expect(getDb().prepare('SELECT COUNT(*) n FROM contact_evidence').get()).toEqual({ n: 2 });
    const c = getDb().prepare('SELECT confidence_explanation FROM contacts').get() as { confidence_explanation: string };
    expect(c.confidence_explanation).toContain('seen on 2 pages');
  });

  it('de-duplicates companies by normalized domain across providers', async () => {
    setProviderOverride(fakeProvider([company('x1', 'Acme', 'https://www.ACME.example/home'), company('x2', 'Acme Pvt Ltd', 'acme.example')]));
    nock('https://www.acme.example').get('/robots.txt').reply(404).get('/').reply(200, '<body>hi</body>', HTML);
    const id = startDiscovery(criteria);
    await waitForRun(id);
    expect(getDb().prepare('SELECT COUNT(*) n FROM companies').get()).toEqual({ n: 1 });
    expect(getDb().prepare('SELECT COUNT(*) n FROM company_sources').get()).toEqual({ n: 2 });
  });
});
