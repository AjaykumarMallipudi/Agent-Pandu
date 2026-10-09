/** URL / domain normalization helpers. */

const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'gov.in',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.kr', 'com.br', 'com.mx', 'com.sg', 'com.my', 'co.za', 'com.cn',
  'com.hk', 'com.tr', 'com.ar', 'com.pk', 'com.bd', 'com.ng', 'co.id', 'com.ph', 'com.vn', 'co.th', 'com.sa', 'ae.org',
]);

/** Hosts that are never a company's official website (social networks, directories, link shorteners). */
const NON_OFFICIAL_DOMAINS = [
  'facebook.com', 'fb.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com',
  'pinterest.com', 'wa.me', 'whatsapp.com', 't.me', 'linktr.ee', 'bit.ly', 'goo.gl', 'g.page', 'google.com',
  'business.site', 'justdial.com', 'indiamart.com', 'sulekha.com', 'yelp.com', 'yellowpages.com', 'tradeindia.com',
  'glassdoor.com', 'glassdoor.co.in', 'naukri.com', 'indeed.com', 'ambitionbox.com', 'crunchbase.com', 'zaubacorp.com',
  'tofler.in', 'wikipedia.org', 'blogspot.com', 'medium.com', 'github.io',
];

export class UrlError extends Error {}

export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/** Lower-cases the host, strips "www." and trailing dots. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

/** Normalizes a website reference into an absolute http(s) URL and its canonical domain. */
export function normalizeWebsite(input: string): { url: string; domain: string } {
  let raw = input.trim();
  if (!raw) throw new UrlError('Empty URL');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw.replace(/^\/+/, '')}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlError(`Invalid URL: ${input}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UrlError(`Unsupported protocol: ${u.protocol}`);
  if (u.username || u.password) throw new UrlError('URLs with credentials are not allowed');
  const domain = normalizeHost(u.hostname);
  if (!domain.includes('.') && !/^\[/.test(u.hostname)) throw new UrlError(`Not a public domain: ${domain}`);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  return { url: `${u.protocol}//${u.host}/`, domain };
}

export function isNonOfficialDomain(domain: string): boolean {
  const d = normalizeHost(domain);
  return NON_OFFICIAL_DOMAINS.some((n) => d === n || d.endsWith(`.${n}`));
}

/** True if `url` is on the company's site (same registrable domain). */
export function isSameSite(url: string, domain: string): boolean {
  try {
    const host = normalizeHost(new URL(url).hostname);
    return registrableDomain(host) === registrableDomain(domain);
  } catch {
    return false;
  }
}

/** Canonical form used to de-duplicate crawled pages. */
export function canonicalPageUrl(url: string): string {
  const u = new URL(url);
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
  let s = u.toString();
  if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
}

export function emailDomainMatchesCompany(emailDomain: string, companyDomain: string): boolean {
  return registrableDomain(normalizeHost(emailDomain)) === registrableDomain(normalizeHost(companyDomain));
}
