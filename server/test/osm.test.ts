import nock from 'nock';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getDb } from '../src/db/index.js';
import {
  buildOverpassQuery,
  extraKeywords,
  matchElement,
  OsmProvider,
  requestedCategories,
  type OsmElement,
} from '../src/discovery/providers/osm.js';
import { getRun, setProviderOverride, startDiscovery, waitForRun } from '../src/discovery/runner.js';
import { criteriaSchema, ProviderConfigError, ProviderError, type DiscoveredCompany } from '../src/discovery/types.js';
import { setupTestEnv } from './helpers.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS = 'https://overpass-api.de';
const EMAIL = 'tester@example.org';
const HYD_RELATION = 7868535;
const H = { 'X-Applytick': '1' };

const hyderabad = criteriaSchema.parse({
  country: 'India',
  state: 'Telangana',
  city: 'Hyderabad',
  industry: 'IT, software, technology',
  keywords: 'startups',
  maxCompanies: 20,
  maxPagesPerCompany: 2,
});

const ELEMENTS: OsmElement[] = [
  { type: 'node', id: 1, tags: { name: 'Cyber Soft Solutions', office: 'company' } },
  { type: 'node', id: 2, tags: { name: 'Hitech Infotech', office: 'it', website: 'https://hitech.example', 'addr:street': 'Hitech City Road', 'addr:city': 'Hyderabad', 'addr:postcode': '500081' } },
  { type: 'way', id: 3, tags: { name: 'Sharma & Co Advocates', office: 'lawyer', website: 'https://law.example' } },
  { type: 'node', id: 4, tags: { name: 'Deccan Ventures Labs', office: 'company', description: 'Early-stage startup studio', 'contact:website': 'deccan.example;https://other.example' } },
  { type: 'node', id: 5, tags: { name: 'Paradise Biryani Corp', office: 'company', website: 'https://food.example' } },
  { type: 'relation', id: 6, tags: { name: 'Gachibowli Software Park', company: 'software', website: 'https://park.example' } },
  { type: 'node', id: 7, tags: { office: 'it' } }, // no name: ignored
];

function mockNominatim(result: object[] = [{ osm_type: 'relation', osm_id: HYD_RELATION, boundingbox: ['17.2', '17.6', '78.2', '78.7'], display_name: 'Hyderabad, Telangana, India' }]) {
  return nock(NOMINATIM)
    .matchHeader('user-agent', new RegExp(`SmartApplytick/1\\.0 .*contact: ${EMAIL.replace('.', '\\.')}`))
    .get('/search')
    .query((q) => q.city === 'Hyderabad' && q.state === 'Telangana' && q.country === 'India' && q.format === 'jsonv2' && q.email === EMAIL)
    .reply(200, result);
}
function mockOverpass(match: (body: string) => boolean, elements: OsmElement[] = ELEMENTS, status = 200) {
  return nock(OVERPASS)
    .matchHeader('user-agent', /SmartApplytick/)
    // nock hands form-encoded bodies to matchers already parsed ({ data: '...' }).
    .post('/api/interpreter', (b: unknown) => match(typeof b === 'string' ? (new URLSearchParams(b).get('data') ?? '') : String((b as { data?: string }).data ?? '')))
    .reply(status, status === 200 ? { elements } : 'busy');
}
async function drain(gen: AsyncGenerator<DiscoveredCompany>) {
  const out: DiscoveredCompany[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe('OSM provider configuration', () => {
  it('needs only a valid contact email, no API key', () => {
    setupTestEnv();
    const p = new OsmProvider();
    expect(p.status().configured).toBe(false);
    expect(p.status().message).toMatch(/OSM_CONTACT_EMAIL/);
    setupTestEnv({ OSM_CONTACT_EMAIL: 'not-an-email' });
    expect(new OsmProvider().status().configured).toBe(false);
    setupTestEnv({ OSM_CONTACT_EMAIL: EMAIL });
    expect(new OsmProvider().status()).toMatchObject({ configured: true });
  });

  it('is the default provider and does not require Google credentials', async () => {
    setupTestEnv({ OSM_CONTACT_EMAIL: EMAIL, GOOGLE_PLACES_API_KEY: '' });
    const res = await request(createApp()).get('/api/discovery/providers');
    expect(res.body.active).toBe('osm');
    expect(res.body.current).toMatchObject({ id: 'osm', configured: true });
    expect(res.body.providers.find((p: { id: string }) => p.id === 'google_places').configured).toBe(false);
  });

  it('rejects country/state-only searches up front (whole-India query timed out live)', async () => {
    setupTestEnv({ OSM_CONTACT_EMAIL: EMAIL });
    const indiaOnly = criteriaSchema.parse({ country: 'India', industry: 'Software' });
    const res = await request(createApp()).post('/api/discovery/runs').set(H).send({ criteria: indiaOnly, provider: 'osm' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/need a City/);
    expect(getDb().prepare('SELECT COUNT(*) n FROM discovery_runs').get()).toEqual({ n: 0 });
    // No request reaches Nominatim/Overpass (real network is disabled in tests; nothing is mocked here).
    await expect(drain(new OsmProvider().search({ ...indiaOnly, state: 'Telangana' }, () => false))).rejects.toThrow(/need a City/);
  });

  it('refuses to run without OSM_CONTACT_EMAIL', async () => {
    setupTestEnv();
    await expect(drain(new OsmProvider().search(hyderabad, () => false))).rejects.toBeInstanceOf(ProviderConfigError);
  });
});

describe('category matching', () => {
  const cats = requestedCategories(hyderabad);
  it('reads categories from industry and keywords', () => {
    expect([...cats].sort()).toEqual(['it', 'software', 'startup', 'technology']);
    expect([...requestedCategories({ industry: 'Information Technology', keywords: '' })]).toContain('it');
    expect([...requestedCategories({ industry: 'Software', keywords: '' })]).toEqual(['software']);
    expect(requestedCategories({ industry: '', keywords: '' }).size).toBe(0);
    expect(extraKeywords({ keywords: 'startups, fintech, companies' })).toEqual(['fintech']);
  });

  it('matches by OSM tags and names, rejects unrelated businesses', () => {
    expect(matchElement({ name: 'X', office: 'it' }, new Set(['it']), [])).toMatchObject({ matched: true, reasons: ['tagged office=it'] });
    expect(matchElement({ name: 'Acme Technologies', office: 'company' }, new Set(['technology']), []).matched).toBe(true);
    expect(matchElement({ name: 'Y', company: 'software' }, new Set(['software']), []).matched).toBe(true);
    expect(matchElement({ name: 'Law Firm', office: 'lawyer' }, cats, []).matched).toBe(false);
    expect(matchElement({ name: 'Paradise Biryani Corp', office: 'company' }, cats, []).matched).toBe(false);
    // "IT" must be a whole word in the right case: "Digital Prints" is not an IT company for an IT-only search.
    expect(matchElement({ name: 'Digital Prints', shop: 'copyshop' }, new Set(['it']), []).matched).toBe(false);
    expect(matchElement({ name: 'Nova Ventures', office: 'company', description: 'startup' }, new Set(['startup']), []).matched).toBe(true);
  });

  it('applies extra keywords as whole words', () => {
    expect(matchElement({ name: 'PayFin Fintech', office: 'company' }, new Set(), ['fintech']).matched).toBe(true);
    expect(matchElement({ name: 'Acme Company', office: 'company' }, new Set(), ['fintech']).matched).toBe(false);
  });

  it('builds area and bounding-box Overpass queries with office/company/industry tags', () => {
    const q = buildOverpassQuery({ areaId: 3600000000 + HYD_RELATION });
    expect(q).toContain(`area(id:${3600000000 + HYD_RELATION})`);
    expect(q).toMatch(/\[timeout:90\]/);
    expect(q).not.toContain('maxsize'); // maxsize limits server memory; 30 MB made Hyderabad fail
    expect(q).toContain('"office"~"^(it|IT|software|company');
    expect(q).toContain('nwr["company"]');
    expect(q).toContain('out center tags;');
    expect(buildOverpassQuery({ bbox: [17.2, 78.2, 17.6, 78.7] })).toContain('(17.2,78.2,17.6,78.7)');
  });
});

describe('OSM search (mocked Nominatim + Overpass)', () => {
  beforeEach(() => {
    setupTestEnv({ OSM_CONTACT_EMAIL: EMAIL });
  });

  it('finds IT/software/tech/startup companies in Hyderabad with website, location and source URL', async () => {
    const n = mockNominatim();
    const o = mockOverpass((b) => b.includes(`area(id:${3600000000 + HYD_RELATION})`));
    const res = await drain(new OsmProvider().search(hyderabad, () => false));
    expect(n.isDone() && o.isDone()).toBe(true);
    expect(res.map((r) => r.name)).toEqual(['Hitech Infotech', 'Gachibowli Software Park', 'Deccan Ventures Labs', 'Cyber Soft Solutions']);
    const hitech = res[0]!;
    expect(hitech).toMatchObject({
      providerRef: 'node/2',
      website: 'https://hitech.example',
      address: 'Hitech City Road, Hyderabad, 500081',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
      industry: 'office=it',
      sourceUrl: 'https://www.openstreetmap.org/node/2',
    });
    expect(res.find((r) => r.name === 'Deccan Ventures Labs')!.website).toBe('deccan.example'); // first of multi-valued tag
    expect(res.find((r) => r.name === 'Cyber Soft Solutions')!.website).toBeNull(); // OSM often lacks websites
    expect(res.find((r) => r.name === 'Gachibowli Software Park')!.sourceUrl).toBe('https://www.openstreetmap.org/relation/6');
  });

  it('respects maxCompanies, keeping companies with websites first', async () => {
    mockNominatim();
    mockOverpass(() => true);
    const res = await drain(new OsmProvider().search({ ...hyderabad, maxCompanies: 2 }, () => false));
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.website)).toBe(true);
  });

  it('caches geocoding and Overpass results (no repeat requests)', async () => {
    mockNominatim();
    mockOverpass(() => true);
    const first = await drain(new OsmProvider().search(hyderabad, () => false));
    // nock interceptors are consumed and real network is disabled: a second request would throw.
    const second = await drain(new OsmProvider().search(hyderabad, () => false));
    expect(second).toEqual(first);
    expect(getDb().prepare('SELECT COUNT(*) n FROM api_cache').get()).toEqual({ n: 2 });
  });

  it('falls back to the bounding box when the area query is empty', async () => {
    mockNominatim();
    mockOverpass((b) => b.includes('area(id:'), []);
    const bbox = mockOverpass((b) => b.includes('(17.2,78.2,17.6,78.7)'));
    const res = await drain(new OsmProvider().search(hyderabad, () => false));
    expect(bbox.isDone()).toBe(true);
    expect(res.length).toBeGreaterThan(0);
  });

  it('reports unknown locations clearly', async () => {
    mockNominatim([]);
    await expect(drain(new OsmProvider().search(hyderabad, () => false))).rejects.toThrow(/could not find the location "Hyderabad, Telangana, India"/);
  });

  it('reports Overpass rate limiting without retrying', async () => {
    mockNominatim();
    const o = mockOverpass(() => true, [], 429);
    await expect(drain(new OsmProvider().search(hyderabad, () => false))).rejects.toThrow(/rate limited.*429/);
    expect(o.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('reports Overpass server-side timeouts', async () => {
    mockNominatim();
    nock(OVERPASS).post('/api/interpreter').reply(200, { elements: [], remark: 'runtime error: Query timed out in "query" at line 3' });
    await expect(drain(new OsmProvider().search(hyderabad, () => false))).rejects.toBeInstanceOf(ProviderError);
  });

  it('times out slow Nominatim responses', async () => {
    nock(NOMINATIM).get('/search').query(true).delay(16_000).reply(200, []);
    await expect(drain(new OsmProvider().search(hyderabad, () => false))).rejects.toThrow(/timed out/);
  }, 25_000);

  it('spaces Nominatim requests at least 1 second apart', async () => {
    const times: number[] = [];
    nock(NOMINATIM)
      .get('/search')
      .query(true)
      .times(2)
      .reply(200, () => {
        times.push(Date.now());
        return [{ osm_type: 'node', osm_id: 1, boundingbox: ['1', '2', '3', '4'] }];
      });
    const p = new OsmProvider();
    await Promise.all([p.geocode({ ...hyderabad, city: 'Secunderabad' }), p.geocode({ ...hyderabad, city: 'Gachibowli' })]);
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000);
  });
});

// The exact records OpenStreetMap returned for a real "Guntur, Andhra Pradesh, India" + "Software" search.
const GUNTUR: OsmElement[] = [
  { type: 'node', id: 4487306091, tags: { 'addr:city': 'Guntur', name: 'Southern Power Distrubution Company of Andhra Pradesh', office: 'company' } },
  { type: 'node', id: 5030732982, tags: { name: 'Jio', office: 'telecommunication' } },
  { type: 'node', id: 5030744826, tags: { name: 'Airtel shp', office: 'telecommunication' } },
  { type: 'node', id: 5030747317, tags: { name: 'Vodafone Store', office: 'telecommunication' } },
  { type: 'node', id: 5640986432, tags: { name: 'Chanbhi Agency', office: 'telecommunication' } },
  { type: 'node', id: 5642901621, tags: { name: 'Blue Dart', office: 'company' } },
  { type: 'node', id: 7116267004, tags: { name: 'Satya Regalia', office: 'company', description: 'Premium Luxury Gated Community Residential Apartments', website: 'http://www.satyaregalia.com/' } },
  { type: 'node', id: 9886961528, tags: { name: 'Phoenix Overseas Education Services', office: 'consulting' } },
  { type: 'node', id: 12995224038, tags: { name: 'Companies', office: 'company' } },
  { type: 'node', id: 13188000082, tags: { name: 'ITC Agri Business Division', office: 'company' } },
  { type: 'node', id: 13232198610, tags: { 'addr:city': 'Mangalagiri', 'addr:street': 'IT Park', name: 'Efftronics Systems Pvt Ltd', office: 'company' } },
  { type: 'way', id: 410569243, tags: { 'addr:city': 'GUNTUR', 'addr:street': 'Vidyanagar 1st line', building: 'yes', name: 'Veda', office: 'it' } },
  { type: 'way', id: 411685973, tags: { building: 'commercial', name: 'BSNL office', office: 'telecommunication' } },
];

describe('regression: sparse city (Guntur) with a "Software" search', () => {
  const guntur = criteriaSchema.parse({ country: 'India', state: 'Andhra Pradesh', city: 'GUNTUR', industry: 'Software', keywords: '', maxCompanies: 25, maxPagesPerCompany: 6 });
  beforeEach(() => {
    setupTestEnv({ OSM_CONTACT_EMAIL: EMAIL });
  });

  it('finds the IT/software firms and ignores telecom stores, utilities and real estate', async () => {
    nock(NOMINATIM)
      .get('/search')
      .query(true)
      .reply(200, [{ osm_type: 'node', osm_id: 571469929, boundingbox: ['16.13', '16.45', '80.29', '80.61'], display_name: 'Guntur, Andhra Pradesh, 522001, India' }]);
    nock(OVERPASS).post('/api/interpreter').reply(200, { elements: GUNTUR });
    const notes: string[] = [];
    const res = await drain(new OsmProvider().search(guntur, () => false, (n) => notes.push(n)));
    expect(res.map((r) => r.name).sort()).toEqual(['Efftronics Systems Pvt Ltd', 'Veda']);
    expect(notes[0]).toMatch(/2 of 13 business records around GUNTUR, Andhra Pradesh, India matched "Software"; 0 have a website/);
  });

  it('explains an empty result instead of silently finishing', async () => {
    nock(NOMINATIM).get('/search').query(true).reply(200, [{ osm_type: 'node', osm_id: 1, boundingbox: ['16.1', '16.4', '80.2', '80.6'], display_name: 'Guntur' }]);
    nock(OVERPASS).post('/api/interpreter').reply(200, { elements: GUNTUR.filter((e) => e.tags!.office === 'telecommunication') });
    setProviderOverride(null);
    const id = startDiscovery(guntur, 'osm');
    await waitForRun(id);
    const run = getRun(id)!;
    expect(run.status).toBe('completed');
    expect(run.current_step).toMatch(/^Done\. OpenStreetMap has 5 business record\(s\) around GUNTUR, Andhra Pradesh, India, but none matched "Software".*try leaving Industry empty/);
  });

  it('excludes training institutes, shops and roads even with technical names', () => {
    const cats = new Set(['software'] as const);
    expect(matchElement({ name: 'Java Software Training Institute', office: 'company' }, cats, []).matched).toBe(false);
    expect(matchElement({ name: 'Softech Computers', shop: 'computer' }, cats, []).matched).toBe(false);
    expect(matchElement({ name: 'Software Park Road', highway: 'primary' }, cats, []).matched).toBe(false);
    // Real false positive from a live Guntur run: a government MeeSeva service centre.
    expect(matchElement({ name: 'Digital Seva', office: 'yes', website: 'https://www.meeseva.in/' }, new Set(['technology'] as const), []).matched).toBe(false);
    expect(matchElement({ name: 'Acme Softech Pvt Ltd', building: 'office' }, cats, []).matched).toBe(true);
  });
});

describe('OSM discovery run feeds the website crawler', () => {
  beforeEach(() => {
    setupTestEnv({ OSM_CONTACT_EMAIL: EMAIL });
  });

  it('stores companies with OSM source URLs and crawls only those with websites', async () => {
    mockNominatim();
    mockOverpass(() => true, [ELEMENTS[0]!, ELEMENTS[1]!]);
    nock('https://hitech.example')
      .get('/robots.txt')
      .reply(404)
      .get('/')
      .reply(200, '<body><a href="/careers">Careers</a></body>', { 'Content-Type': 'text/html' })
      .get('/careers')
      .reply(200, '<body><h2>Careers</h2><p>Send your resume to <a href="mailto:careers@hitech.example">careers@hitech.example</a></p></body>', {
        'Content-Type': 'text/html',
      });

    const res = await request(createApp()).post('/api/discovery/runs').set(H).send({ criteria: hyderabad, provider: 'osm' });
    expect(res.status).toBe(202);
    await waitForRun(res.body.id);
    const run = getRun(res.body.id)!;
    expect(run).toMatchObject({ status: 'completed', provider: 'osm', companies_found: 2, companies_scanned: 1, contacts_found: 1 });

    const companies = getDb()
      .prepare('SELECT c.name, c.discovery_status, c.website_url, s.source_url FROM companies c JOIN company_sources s ON s.company_id = c.id ORDER BY c.id')
      .all();
    expect(companies).toEqual([
      { name: 'Hitech Infotech', discovery_status: 'scanned', website_url: 'https://hitech.example/', source_url: 'https://www.openstreetmap.org/node/2' },
      { name: 'Cyber Soft Solutions', discovery_status: 'no_website', website_url: null, source_url: 'https://www.openstreetmap.org/node/1' },
    ]);
    expect(getDb().prepare('SELECT email, contact_type FROM contacts').all()).toEqual([{ email: 'careers@hitech.example', contact_type: 'Careers' }]);

    const detail = await request(createApp()).get('/api/companies/1');
    expect(detail.body.sources[0].source_url).toBe('https://www.openstreetmap.org/node/2');
  });
});
