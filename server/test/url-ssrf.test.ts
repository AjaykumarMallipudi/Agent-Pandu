import nock from 'nock';
import { beforeEach, describe, expect, it } from 'vitest';
import { safeFetch } from '../src/lib/http.js';
import { assertPublicUrl, isPublicIp, setResolver, SsrfError } from '../src/lib/ssrf.js';
import { canonicalPageUrl, emailDomainMatchesCompany, isNonOfficialDomain, normalizeWebsite, registrableDomain, UrlError } from '../src/lib/url.js';
import { setupTestEnv } from './helpers.js';

describe('URL normalization', () => {
  it('adds a scheme, lower-cases and strips www', () => {
    expect(normalizeWebsite('WWW.Example.COM/about?x=1')).toEqual({ url: 'https://www.example.com/', domain: 'example.com' });
    expect(normalizeWebsite('http://Shop.Example.co.in')).toEqual({ url: 'http://shop.example.co.in/', domain: 'shop.example.co.in' });
  });
  it('rejects non-http schemes, credentials and bare hosts', () => {
    expect(() => normalizeWebsite('ftp://example.com')).toThrow(UrlError);
    expect(() => normalizeWebsite('https://user:pw@example.com')).toThrow(UrlError);
    expect(() => normalizeWebsite('intranet')).toThrow(UrlError);
    expect(() => normalizeWebsite('')).toThrow(UrlError);
  });
  it('computes registrable domains including multi-label suffixes', () => {
    expect(registrableDomain('careers.acme.com')).toBe('acme.com');
    expect(registrableDomain('www.acme.co.in')).toBe('acme.co.in');
    expect(registrableDomain('acme.co.uk')).toBe('acme.co.uk');
    expect(emailDomainMatchesCompany('mail.acme.co.in', 'acme.co.in')).toBe(true);
    expect(emailDomainMatchesCompany('gmail.com', 'acme.com')).toBe(false);
  });
  it('flags social and directory sites as non-official', () => {
    expect(isNonOfficialDomain('facebook.com')).toBe(true);
    expect(isNonOfficialDomain('in.linkedin.com')).toBe(true);
    expect(isNonOfficialDomain('acme.com')).toBe(false);
  });
  it('canonicalizes page URLs for de-duplication', () => {
    expect(canonicalPageUrl('https://a.com/contact/?utm_source=x#top')).toBe('https://a.com/contact');
    expect(canonicalPageUrl('https://a.com/')).toBe('https://a.com/');
  });
});

describe('SSRF prevention', () => {
  beforeEach(() => {
    setupTestEnv();
  });

  it('classifies IP ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    expect(isPublicIp('93.184.216.34')).toBe(true);
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
  });

  it('rejects private, loopback, metadata, odd ports and non-http URLs', async () => {
    const bad = [
      'http://127.0.0.1/',
      'http://localhost/',
      'http://2130706433/', // decimal 127.0.0.1
      'http://[::1]/',
      'http://[::ffff:7f00:1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://printer.local/',
      'https://example.com:8443/',
      'file:///etc/passwd',
      'gopher://example.com/',
      'https://user:pw@example.com/',
    ];
    for (const u of bad) await expect(assertPublicUrl(u), u).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('https://example.com/contact')).resolves.toBeInstanceOf(URL);
  });

  it('rejects hostnames that resolve to private addresses (any record)', async () => {
    setResolver(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.0.10', family: 4 },
    ]);
    await expect(assertPublicUrl('https://sneaky.example/')).rejects.toThrow(/non-public/);
  });

  it('validates every redirect hop', async () => {
    nock('https://public.example').get('/').reply(302, '', { Location: 'http://127.0.0.1/admin' });
    await expect(safeFetch('https://public.example/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('blocks redirects to hosts resolving privately', async () => {
    setResolver(async (h) => (h === 'internal.example' ? [{ address: '10.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]));
    nock('https://public.example').get('/').reply(301, '', { Location: 'https://internal.example/' });
    await expect(safeFetch('https://public.example/')).rejects.toThrow(/non-public/);
  });
});
