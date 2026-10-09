import axios from 'axios';
import { config } from '../../config.js';
import { cacheGet, cacheKey, cacheSet } from '../../lib/apiCache.js';
import { logger } from '../../logger.js';
import {
  locationText,
  ProviderConfigError,
  ProviderError,
  type DiscoveredCompany,
  type DiscoveryCriteria,
  type DiscoveryProvider,
} from '../types.js';

/**
 * OpenStreetMap discovery.
 *
 * 1. Nominatim geocodes the location once (structured city/state/country query) to get its boundary.
 * 2. One Overpass query lists businesses inside that boundary tagged as offices/companies or with
 *    technology-related `company` / `industry` tags. Websites are optional in OSM: companies without
 *    one are still recorded, and those with one are handed to the website crawler.
 * 3. Matching against the requested categories (IT, software, technology, startups) happens locally,
 *    so one cached Overpass response serves many different searches in the same area.
 *
 * Usage-policy compliance (https://operations.osmfoundation.org/policies/nominatim/,
 * https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances):
 * descriptive User-Agent with a contact email, at most 1 Nominatim request per second, results cached
 * (geocoding 30 days, Overpass 24 h), one Overpass query at a time with a server-side timeout,
 * no automatic hammering on 429/504 — the run fails with a clear message instead.
 */

const GEOCODE_TTL_MS = 30 * 24 * 3600 * 1000;
const OVERPASS_TTL_MS = 24 * 3600 * 1000;
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const OVERPASS_MAX_BYTES = 30 * 1024 * 1024;

let nominatimChain: Promise<unknown> = Promise.resolve();
let nominatimLastAt = 0;
let overpassChain: Promise<unknown> = Promise.resolve();

/** Serializes calls and spaces Nominatim requests ≥ 1.1 s apart across the whole process. */
function nominatimSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = nominatimChain.then(async () => {
    const wait = nominatimLastAt + NOMINATIM_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      nominatimLastAt = Date.now();
    }
  });
  nominatimChain = run.catch(() => undefined);
  return run;
}
function overpassSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = overpassChain.then(fn);
  overpassChain = run.catch(() => undefined);
  return run;
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
  lat?: number;
  lon?: number;
}

interface GeocodeResult {
  osm_type?: string;
  osm_id?: number;
  boundingbox?: string[];
  display_name?: string;
}

// ---------- Category matching ----------

export type OsmCategory = 'it' | 'software' | 'technology' | 'startup';

const CATEGORY_WORDS: [RegExp, OsmCategory][] = [
  [/\b(it|information technology|it services?|it companies)\b/i, 'it'],
  [/\b(software|saas)\b/i, 'software'],
  [/\b(tech|technology|technologies|digital)\b/i, 'technology'],
  [/\b(start-?ups?)\b/i, 'startup'],
];

/** Which categories the user asked for (from industry + keywords). Empty = generic company search. */
export function requestedCategories(c: Pick<DiscoveryCriteria, 'industry' | 'keywords'>): Set<OsmCategory> {
  const text = `${c.industry} ${c.keywords}`;
  const out = new Set<OsmCategory>();
  for (const [re, cat] of CATEGORY_WORDS) if (re.test(text)) out.add(cat);
  return out;
}

/** Keywords that are not category words: matched against name/description as whole words. */
export function extraKeywords(c: Pick<DiscoveryCriteria, 'keywords'>): string[] {
  return c.keywords
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k && !CATEGORY_WORDS.some(([re]) => re.test(k)) && !/^(companies|company|firms?|businesses)$/.test(k));
}

const TECH_TAG = /^(it|software|information[_ ]technology|technology|computer|internet|web[_ ]?design|it[_ ]services?)$/i;
const TECH_NAME =
  /\b(software|softwares|softech|technolog(y|ies)|tech|technos?|infotech|infotek|info ?systems?|infosys|it services|it solutions|systems|digital|labs?|cloud|data|analytics|ai|saas|apps?|web|cyber|innovations?|computing|infoway|soft|solutions)\b/i;
const IT_NAME = /\b(IT|infotech|info tech|infotek|it services|it solutions|information technology)\b/;
const SOFTWARE_TEXT = /\b(software|softwares|softech|saas|apps?|soft)\b/i;
const STARTUP_TEXT = /\b(start-?ups?|ventures|incubat\w*|accelerator)\b/i;
/** Addresses inside known IT clusters are weak evidence of a tech company. */
const TECH_ADDRESS = /\b(IT Park|IT SEZ|Tech Park|Software Park|Cyber ?(City|Towers|Gateway)|HITEC City|Hi-?Tech City|Infocity|Tech City)\b/i;
/** Not companies an applicant can join for a tech role: training/education, retail and telecom stores. */
const EXCLUDED_NAME = /\b(college|school|institute|academy|university|training|coaching|tuitions?|classes|store|showroom|mobiles?|recharge|xerox|internet cafe|cyber ?cafe|seva|kendra|meeseva|e-?seva|csc|xerox)\b/i;
const EXCLUDED_KEYS = ['shop', 'amenity', 'tourism', 'leisure', 'healthcare', 'highway', 'railway', 'place', 'landuse'];

function tagValues(t: Record<string, string>, ...keys: string[]): string[] {
  return keys.flatMap((k) => (t[k] ?? '').split(';').map((v) => v.trim()).filter(Boolean));
}

export interface MatchResult {
  matched: boolean;
  score: number;
  reasons: string[];
}

/** Evidence-based category match for one OSM element. */
export function matchElement(t: Record<string, string>, cats: Set<OsmCategory>, keywords: string[]): MatchResult {
  const office = (t.office ?? '').toLowerCase();
  const typed = tagValues(t, 'company', 'industry', 'office', 'craft');
  const text = [t.name, t['name:en'], t.description, t.brand, t.operator].filter(Boolean).join(' ');
  const techTag = typed.some((v) => TECH_TAG.test(v));
  const techName = TECH_NAME.test(text);
  const reasons: string[] = [];
  let score = 0;

  if (keywords.length) {
    const hay = `${text} ${typed.join(' ')}`.toLowerCase();
    const hit = keywords.find((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(hay));
    if (!hit) return { matched: false, score: 0, reasons: [] };
    reasons.push(`matches keyword "${hit}"`);
    score += 2;
  }

  if (cats.size === 0) {
    // Generic search: any company/office record.
    const ok = Boolean(office) || typed.length > 0;
    return { matched: ok, score: score + (ok ? 1 : 0), reasons: ok ? [...reasons, `office=${office || typed[0]}`] : [] };
  }

  if (EXCLUDED_NAME.test(text) || EXCLUDED_KEYS.some((k) => t[k])) return { matched: false, score: 0, reasons: [] };

  // IT, software and technology overlap heavily in practice (an office=it firm is usually a software firm),
  // so any tech evidence matches any of them; an exact category hit ranks higher.
  const isIt = office === 'it' || typed.some((v) => /^(it|information[_ ]technology|it[_ ]services?)$/i.test(v)) || IT_NAME.test(text);
  const isSoftware = office === 'software' || typed.some((v) => /software/i.test(v)) || SOFTWARE_TEXT.test(text);
  const techAddress = TECH_ADDRESS.test([t['addr:street'], t['addr:place'], t['addr:suburb'], t['addr:full']].filter(Boolean).join(' '));
  const isTech = isIt || isSoftware || techTag || techName || (techAddress && Boolean(office));
  const wantsTech = cats.has('it') || cats.has('software') || cats.has('technology');

  if (wantsTech && isTech) {
    if (cats.has('it') && isIt) {
      score += office === 'it' ? 5 : 3;
      reasons.push(office === 'it' ? 'tagged office=it' : 'IT company by tag/name');
    }
    if (cats.has('software') && isSoftware) {
      score += office === 'software' ? 5 : 3;
      reasons.push(office === 'software' ? 'tagged office=software' : 'software company by tag/name');
    }
    if (!reasons.length || cats.has('technology')) {
      score += techTag || isIt || isSoftware ? 3 : techName ? 2 : 1;
      reasons.push(
        office === 'it' ? 'tagged office=it' : techTag ? 'technology tag' : techName ? 'technology name' : 'office located in an IT park',
      );
    }
  }
  if (cats.has('startup') && STARTUP_TEXT.test(`${text} ${typed.join(' ')}`)) {
    score += 3;
    reasons.push('mentions startup/ventures');
  }
  // OSM has no reliable "startup" tag: for startup-only searches, fall back to tech companies.
  if (cats.size === 1 && cats.has('startup') && score === 0 && isTech && Boolean(office || techTag)) {
    score += 1;
    reasons.push('technology company (OSM has no startup tag)');
  }
  return { matched: score > 0, score, reasons: [...new Set(reasons)] };
}

// ---------- Element → company ----------

function firstWebsite(t: Record<string, string>): string | null {
  for (const k of ['website', 'contact:website', 'url', 'operator:website']) {
    const v = t[k]?.split(';')[0]?.trim();
    if (v) return v;
  }
  return null;
}

export function osmSourceUrl(el: Pick<OsmElement, 'type' | 'id'>): string {
  return `https://www.openstreetmap.org/${el.type}/${el.id}`;
}

export function elementToCompany(el: OsmElement, c: DiscoveryCriteria, match: MatchResult): DiscoveredCompany | null {
  const t = el.tags ?? {};
  const name = t.name ?? t['name:en'] ?? t.brand;
  if (!name) return null;
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const address = [street, t['addr:suburb'] ?? t['addr:district'], t['addr:city'], t['addr:postcode']].filter(Boolean).join(', ');
  const lat = el.center?.lat ?? el.lat;
  const lon = el.center?.lon ?? el.lon;
  return {
    providerRef: `${el.type}/${el.id}`,
    name,
    website: firstWebsite(t),
    address: address || null,
    city: t['addr:city'] ?? (c.city || null),
    state: t['addr:state'] ?? (c.state || null),
    country: c.country,
    industry: t.industry ?? t.company ?? (t.office && t.office !== 'company' ? `office=${t.office}` : null) ?? (c.industry || null),
    sourceUrl: osmSourceUrl(el),
    raw: { type: el.type, id: el.id, tags: t, lat: lat ?? null, lon: lon ?? null, match: match.reasons },
  };
}

// ---------- Queries ----------

export function buildOverpassQuery(scope: { areaId: number } | { bbox: [number, number, number, number] }): string {
  const s = 'areaId' in scope ? '(area.a)' : `(${scope.bbox.join(',')})`;
  const head = 'areaId' in scope ? `area(id:${scope.areaId})->.a;\n` : '';
  // Besides office/company/industry tags, many tech firms are mapped with only a name and a website,
  // so also fetch website-bearing objects whose name looks technical, and any office that has a website.
  // (A name regex over *all* objects is too slow for large cities, so it is limited to objects with a website.)
  // Roads, shops, amenities and places are excluded server-side.
  const notFeature = '[!"highway"][!"railway"][!"shop"][!"amenity"][!"place"][!"tourism"]';
  // No [maxsize]: it caps the Overpass server's query memory (not response size). The client caps bytes instead.
  return `[out:json][timeout:90];
${head}(
  nwr["office"~"^(it|IT|software|company|research|engineering|consulting|coworking|yes)$"]["name"]${s};
  nwr["company"]["name"]${s};
  nwr["industry"~"software|information|technology|it",i]["name"]${s};
  nwr["office"]["website"]["name"]${s};
  nwr["website"]["name"~"software|technolog|infotech|infosys|softech|it solutions|it services|systems|labs|digital solutions",i]${notFeature}${s};
);
out center tags;`;
}

export class OsmProvider implements DiscoveryProvider {
  readonly id = 'osm';

  status() {
    const email = config().OSM_CONTACT_EMAIL;
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    return {
      id: this.id,
      label: 'OpenStreetMap (Nominatim + Overpass) — free',
      configured: valid,
      message: valid
        ? `Free public OpenStreetMap services; requests identify themselves with ${email}. No API key needed.`
        : email
          ? `OSM_CONTACT_EMAIL "${email}" is not a valid email address.`
          : 'Set OSM_CONTACT_EMAIL in .env to your email address and restart the server. OpenStreetMap usage policy requires identifying your application; no API key or payment is needed.',
    };
  }

  private headers() {
    return {
      'User-Agent': `SmartApplytick/1.0 (company discovery for individual job applications; contact: ${config().OSM_CONTACT_EMAIL})`,
      Accept: 'application/json',
    };
  }

  async geocode(c: DiscoveryCriteria): Promise<GeocodeResult> {
    const params: Record<string, string | number> = { format: 'jsonv2', limit: 1, country: c.country, email: config().OSM_CONTACT_EMAIL };
    if (c.city) params.city = c.city;
    if (c.state) params.state = c.state;
    const key = cacheKey('nominatim', JSON.stringify([params.city, params.state, params.country]));
    const cached = cacheGet<GeocodeResult>(key);
    if (cached) return cached;

    const results = await nominatimSlot(async () => {
      try {
        const r = await axios.get<GeocodeResult[]>(`${config().OSM_NOMINATIM_URL.replace(/\/+$/, '')}/search`, {
          params,
          headers: this.headers(),
          timeout: 15_000,
        });
        return r.data;
      } catch (e) {
        throw this.httpError('Nominatim geocoding', e);
      }
    });
    const first = results?.[0];
    if (!first?.boundingbox) throw new ProviderError(`OpenStreetMap could not find the location "${locationText(c)}". Check the spelling of city/state/country.`);
    cacheSet(key, first, GEOCODE_TTL_MS);
    return first;
  }

  async overpass(query: string): Promise<OsmElement[]> {
    const key = cacheKey('overpass', query);
    const cached = cacheGet<OsmElement[]>(key);
    if (cached) return cached;
    const elements = await overpassSlot(async () => {
      try {
        const r = await axios.post<{ elements?: OsmElement[]; remark?: string }>(config().OSM_OVERPASS_URL, new URLSearchParams({ data: query }).toString(), {
          headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 120_000, // longer than the server-side [timeout:90] so Overpass can report its own timeout
          maxContentLength: OVERPASS_MAX_BYTES,
        });
        if (r.data.remark && /runtime error|timed out|out of memory/i.test(r.data.remark)) {
          throw new ProviderError(`Overpass could not complete the query: ${r.data.remark.trim().replace(/\.+$/, '')}. Try a smaller area or try again later.`);
        }
        return r.data.elements ?? [];
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        throw this.httpError('Overpass query', e);
      }
    });
    cacheSet(key, elements, OVERPASS_TTL_MS);
    return elements;
  }

  private httpError(what: string, e: unknown): ProviderError {
    if (axios.isAxiosError(e)) {
      // A slow body aborted by the timeout surfaces as ERR_BAD_RESPONSE "stream has been aborted".
      if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' || (e.code === 'ERR_BAD_RESPONSE' && /aborted/i.test(e.message))) return new ProviderError(`${what}: timed out. Try again later or narrow the area.`);
      const status = e.response?.status;
      if (status === 429) return new ProviderError(`${what}: rate limited by the public OpenStreetMap service (HTTP 429). Wait a few minutes and try again.`, 429);
      if (status === 504 || status === 503) return new ProviderError(`${what}: the public service is busy (HTTP ${status}). Try again later.`, status);
      if (status === 403) return new ProviderError(`${what}: request refused (HTTP 403). Check that OSM_CONTACT_EMAIL is set to a real address.`, 403);
      return new ProviderError(`${what} failed${status ? ` (HTTP ${status})` : ''}: ${e.message}`, status);
    }
    return new ProviderError(`${what} failed: ${(e as Error).message}`);
  }

  /** Whole-country/state areas are far too large for the free public Overpass service (it times out). */
  validate(c: DiscoveryCriteria): string | null {
    if (!c.city.trim()) {
      return 'OpenStreetMap searches need a City. A whole country or state is too large for the free public Overpass service and times out. Enter a city (e.g. Hyderabad, Telangana) and run one search per city for wider coverage.';
    }
    return null;
  }

  async *search(c: DiscoveryCriteria, shouldStop: () => boolean, report?: (note: string) => void): AsyncGenerator<DiscoveredCompany> {
    if (!this.status().configured) throw new ProviderConfigError(this.status().message);
    const invalid = this.validate(c);
    if (invalid) throw new ProviderError(invalid);
    const geo = await this.geocode(c);
    if (shouldStop()) return;

    const [south, north, west, east] = geo.boundingbox!.map(Number) as [number, number, number, number];
    const areaId =
      geo.osm_type === 'relation' && geo.osm_id ? 3_600_000_000 + geo.osm_id : geo.osm_type === 'way' && geo.osm_id ? 2_400_000_000 + geo.osm_id : null;
    let elements = areaId ? await this.overpass(buildOverpassQuery({ areaId })) : [];
    // Fall back to the bounding box when no boundary area is available for this place.
    if (elements.length === 0) elements = await this.overpass(buildOverpassQuery({ bbox: [south, west, north, east] }));
    if (shouldStop()) return;

    const cats = requestedCategories(c);
    const kws = extraKeywords(c);
    const candidates: { company: DiscoveredCompany; score: number }[] = [];
    const seen = new Set<string>();
    for (const el of elements) {
      const m = matchElement(el.tags ?? {}, cats, kws);
      if (!m.matched) continue;
      const company = elementToCompany(el, c, m);
      if (!company || seen.has(company.providerRef)) continue;
      seen.add(company.providerRef);
      candidates.push({ company, score: m.score });
    }
    // Companies with a website first (they can be scanned for contacts), then strongest category evidence.
    candidates.sort((a, b) => Number(Boolean(b.company.website)) - Number(Boolean(a.company.website)) || b.score - a.score);
    const withWebsite = candidates.filter((x) => x.company.website).length;
    logger.info({ location: geo.display_name, elements: elements.length, matched: candidates.length, withWebsite }, 'OSM discovery results');
    const asked = [c.industry, c.keywords].filter(Boolean).join(', ') || 'any company';
    const place = locationText(c);
    if (candidates.length === 0) {
      report?.(
        `OpenStreetMap has ${elements.length} business record(s) around ${place}, but none matched "${asked}". ` +
          'OSM coverage of companies is limited in many cities — try leaving Industry empty, a larger nearby city, or the optional Google Places source.',
      );
    } else {
      const shown = Math.min(candidates.length, c.maxCompanies);
      report?.(
        `OpenStreetMap: ${candidates.length} of ${elements.length} business records around ${place} matched "${asked}"` +
          `${shown < candidates.length ? ` (using the top ${shown})` : ''}; ${withWebsite} have a website to scan for public contacts.` +
          (withWebsite === 0 ? ' Companies without a website are saved but cannot be scanned.' : ''),
      );
    }
    for (const { company } of candidates.slice(0, c.maxCompanies)) {
      if (shouldStop()) return;
      yield company;
    }
  }
}
