import { config } from '../config.js';
import { FetchError, safeFetch } from '../lib/http.js';
import { getRobots } from '../lib/robots.js';
import { canonicalPageUrl, isSameSite, normalizeHost } from '../lib/url.js';
import { classifyPage, extractCandidateLinks, extractEmails, pageTitle, type EmailFinding, type PageType } from './extract.js';

export interface PageResult {
  url: string;
  pageType: PageType;
  findings: EmailFinding[];
}

export interface CrawlResult {
  status: 'scanned' | 'blocked_robots' | 'invalid_website' | 'scan_failed';
  finalDomain: string | null;
  pages: PageResult[];
  pagesFetched: number;
  errors: string[];
  note?: string;
}

const FALLBACK_PATHS = ['/contact', '/contact-us', '/careers', '/about', '/about-us'];

/**
 * Crawls a company's public website: homepage first, then the highest-priority same-site
 * contact/careers/about/team pages, up to `maxPages`. Honors robots.txt and never leaves the site.
 */
export async function crawlCompany(
  websiteUrl: string,
  domain: string,
  opts: { maxPages: number; shouldStop?: () => boolean },
): Promise<CrawlResult> {
  const cfg = config();
  const errors: string[] = [];
  const pages: PageResult[] = [];
  let fetched = 0;

  const startOrigin = new URL(websiteUrl).origin;
  const robots = await getRobots(startOrigin);
  if (!robots.isAllowed(websiteUrl)) {
    return { status: 'blocked_robots', finalDomain: domain, pages, pagesFetched: 0, errors, note: robots.note };
  }
  const hostDelayMs = Math.max(cfg.CRAWL_HOST_DELAY_MS, robots.crawlDelayMs ?? 0);

  let home;
  try {
    home = await safeFetch(websiteUrl, { hostDelayMs });
    fetched++;
  } catch (e) {
    return { status: 'scan_failed', finalDomain: domain, pages, pagesFetched: fetched, errors: [`${websiteUrl}: ${(e as Error).message}`] };
  }
  if (home.status >= 400) {
    return { status: 'scan_failed', finalDomain: domain, pages, pagesFetched: fetched, errors: [`${websiteUrl}: HTTP ${home.status}`] };
  }
  const finalHost = normalizeHost(new URL(home.url).hostname);
  // A homepage that redirects off-site (e.g. to a social profile) is not a usable official website.
  if (!isSameSite(home.url, domain)) {
    return { status: 'invalid_website', finalDomain: finalHost, pages, pagesFetched: fetched, errors: [`Redirected off-site to ${home.url}`] };
  }
  const siteDomain = finalHost;
  const finalRobots = new URL(home.url).origin === startOrigin ? robots : await getRobots(new URL(home.url).origin);

  pages.push({ url: home.url, pageType: 'home', findings: extractEmails(home.body) });

  const visited = new Set([canonicalPageUrl(websiteUrl), canonicalPageUrl(home.url)]);
  const queue = extractCandidateLinks(home.body, home.url, siteDomain);
  if (queue.length < opts.maxPages - 1) {
    for (const p of FALLBACK_PATHS) {
      const u = canonicalPageUrl(new URL(p, home.url).toString());
      if (!queue.some((q) => q.url === u)) queue.push({ url: u, score: 10 });
    }
  }

  while (queue.length && fetched < opts.maxPages) {
    if (opts.shouldStop?.()) break;
    const next = queue.shift()!;
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    if (!finalRobots.isAllowed(next.url)) {
      errors.push(`${next.url}: disallowed by robots.txt (skipped)`);
      continue;
    }
    try {
      const res = await safeFetch(next.url, { hostDelayMs });
      fetched++;
      if (res.status >= 400) {
        if (next.score > 10) errors.push(`${next.url}: HTTP ${res.status}`);
        continue;
      }
      if (!isSameSite(res.url, siteDomain)) continue;
      const pageType = classifyPage(res.url, pageTitle(res.body));
      pages.push({ url: res.url, pageType, findings: extractEmails(res.body) });
      for (const l of extractCandidateLinks(res.body, res.url, siteDomain)) {
        if (!visited.has(l.url) && !queue.some((q) => q.url === l.url)) queue.push({ ...l, score: l.score - 5 });
      }
      queue.sort((a, b) => b.score - a.score);
    } catch (e) {
      fetched++;
      if (!(e instanceof FetchError && e.code === 'BAD_CONTENT_TYPE')) errors.push(`${next.url}: ${(e as Error).message}`);
    }
  }
  return { status: 'scanned', finalDomain: siteDomain, pages, pagesFetched: fetched, errors, note: finalRobots.note };
}
