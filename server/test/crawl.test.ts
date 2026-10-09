import nock from 'nock';
import { beforeEach, describe, expect, it } from 'vitest';
import { crawlCompany } from '../src/crawler/crawler.js';
import { FetchError, HostThrottle, safeFetch } from '../src/lib/http.js';
import { setupTestEnv } from './helpers.js';

const html = (body: string, title = 'Page') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const HTML = { 'Content-Type': 'text/html; charset=utf-8' };

describe('safeFetch limits', () => {
  beforeEach(() => {
    setupTestEnv();
  });

  it('enforces the response size limit', async () => {
    nock('https://big.example').get('/').reply(200, 'x'.repeat(50_000), HTML);
    await expect(safeFetch('https://big.example/', { maxBytes: 10_000 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('enforces the redirect limit', async () => {
    const scope = nock('https://loop.example');
    for (let i = 0; i < 5; i++) scope.get(`/r${i}`).reply(302, '', { Location: `/r${i + 1}` });
    await expect(safeFetch('https://loop.example/r0', { maxRedirects: 3 })).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
  });

  it('rejects non-HTML content', async () => {
    nock('https://bin.example').get('/').reply(200, Buffer.from([1, 2, 3]), { 'Content-Type': 'application/octet-stream' });
    await expect(safeFetch('https://bin.example/')).rejects.toBeInstanceOf(FetchError);
  });

  it('times out slow responses', async () => {
    nock('https://slow.example').get('/').delay(2000).reply(200, html('slow'), HTML);
    await expect(safeFetch('https://slow.example/', { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('spaces requests to the same host', async () => {
    const t = new HostThrottle();
    const times: number[] = [];
    await Promise.all([1, 2, 3].map(() => t.run('h', 100, async () => times.push(Date.now()))));
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(90);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(90);
  });
});

describe('crawlCompany', () => {
  beforeEach(() => {
    setupTestEnv();
  });

  it('crawls priority pages, stays on-site and respects maxPages', async () => {
    const site = nock('https://acme.example')
      .get('/robots.txt')
      .reply(200, 'User-agent: *\nDisallow: /private', { 'Content-Type': 'text/plain' })
      .get('/')
      .reply(
        200,
        html(`<a href="/contact">Contact</a><a href="/careers">Careers</a><a href="/about">About</a><a href="/team">Team</a>
              <a href="https://other.example/contact">Partner</a><a href="/private/contact">Private contact</a>`),
        HTML,
      )
      .get('/contact')
      .reply(200, html('<p>Write to <a href="mailto:info@acme.example">info@acme.example</a></p>', 'Contact'), HTML)
      .get('/careers')
      .reply(200, html('<p>Send your resume to careers@acme.example</p>', 'Careers'), HTML);

    const res = await crawlCompany('https://acme.example/', 'acme.example', { maxPages: 3 });
    expect(res.status).toBe('scanned');
    expect(res.pagesFetched).toBe(3);
    expect(res.pages.map((p) => p.pageType)).toEqual(['home', 'contact', 'careers']);
    const emails = res.pages.flatMap((p) => p.findings.map((f) => f.email));
    // info@ appears both as a mailto link and as visible text: two pieces of evidence, one address.
    expect([...new Set(emails)]).toEqual(['info@acme.example', 'careers@acme.example']);
    expect(site.isDone()).toBe(true); // about/team/other-site/private were never requested
  });

  it('skips URLs disallowed by robots.txt', async () => {
    nock('https://robo.example')
      .get('/robots.txt')
      .reply(200, 'User-agent: SmartApplytickBot\nDisallow: /contact', { 'Content-Type': 'text/plain' })
      .get('/')
      .reply(200, html('<a href="/contact">Contact</a>'), HTML);
    const res = await crawlCompany('https://robo.example/', 'robo.example', { maxPages: 5 });
    expect(res.errors.some((e) => e.includes('disallowed by robots.txt'))).toBe(true);
    expect(res.pages).toHaveLength(1);
  });

  it('does not crawl a site whose robots.txt disallows everything', async () => {
    nock('https://closed.example').get('/robots.txt').reply(200, 'User-agent: *\nDisallow: /', { 'Content-Type': 'text/plain' });
    const res = await crawlCompany('https://closed.example/', 'closed.example', { maxPages: 5 });
    expect(res.status).toBe('blocked_robots');
    expect(res.pagesFetched).toBe(0);
  });

  it('treats an unreachable robots.txt (5xx) as disallow', async () => {
    nock('https://down.example').get('/robots.txt').reply(503, 'down');
    const res = await crawlCompany('https://down.example/', 'down.example', { maxPages: 5 });
    expect(res.status).toBe('blocked_robots');
  });

  it('marks homepages that redirect off-site as invalid', async () => {
    nock('https://moved.example')
      .get('/robots.txt')
      .reply(404)
      .get('/')
      .reply(302, '', { Location: 'https://www.facebook.com/moved' });
    nock('https://www.facebook.com').get('/moved').reply(200, html('fb'), HTML);
    const res = await crawlCompany('https://moved.example/', 'moved.example', { maxPages: 5 });
    expect(res.status).toBe('invalid_website');
  });
});
