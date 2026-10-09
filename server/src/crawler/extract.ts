import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { canonicalPageUrl, isSameSite } from '../lib/url.js';

export type PageType = 'contact' | 'careers' | 'about' | 'team' | 'leadership' | 'home' | 'other';
export type ExtractionMethod = 'mailto' | 'text';

export interface EmailFinding {
  email: string; // normalized lower-case
  method: ExtractionMethod;
  context: string; // nearby visible text (evidence)
  heading?: string;
}

const EMAIL_RE = /[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}/g;

const PLACEHOLDER_DOMAINS = /(^|\.)(example\.(com|org|net)|domain\.com|email\.com|yourdomain\.\w+|yourcompany\.\w+|company\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|test\.com|localhost)$/i;
const ASSET_TLDS = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|pdf|zip|mp4|webm|woff2?|ttf)$/i;
const NON_CONTACT_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce[s]?|unsubscribe|abuse)$/i;

/** RFC-5321-ish syntax check. Syntax validity alone never makes an address "verified". */
export function isValidEmailSyntax(email: string): boolean {
  if (email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Za-z0-9._%+-]+$/.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l))) return false;
  return /^[A-Za-z]{2,24}$/.test(labels[labels.length - 1]!);
}

export function normalizeEmail(email: string): string {
  return email.trim().replace(/^mailto:/i, '').toLowerCase();
}

export function isUsableFinding(email: string): boolean {
  const [local = '', domain = ''] = email.split('@');
  if (ASSET_TLDS.test(email)) return false;
  if (PLACEHOLDER_DOMAINS.test(domain)) return false;
  if (NON_CONTACT_LOCAL.test(local)) return false;
  return isValidEmailSyntax(email);
}

const BLOCK = 'p,li,td,th,dd,dt,address,section,article,div,footer,header,aside,blockquote,figure,span';

function squash(s: string, max = 300): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function contextFor($: cheerio.CheerioAPI, node: AnyNode): { context: string; heading?: string } {
  let el = $(node).closest(BLOCK);
  // Expand to a parent while the block is too small to carry meaning (e.g. a lone <span>email</span>).
  for (let i = 0; i < 3 && el.length && el.text().replace(/\s+/g, ' ').trim().length < 40; i++) {
    const p = el.parent();
    if (!p.length || p.is('body')) break;
    el = p;
  }
  let heading: string | undefined;
  let cur = el.length ? el : $(node).parent();
  for (let i = 0; i < 5 && cur.length && !heading; i++) {
    const h = cur.prevAll('h1,h2,h3,h4,h5').first();
    if (h.length) heading = squash(h.text(), 120);
    else {
      const inner = cur.find('h1,h2,h3,h4,h5').first();
      if (inner.length) heading = squash(inner.text(), 120);
    }
    cur = cur.parent();
  }
  return { context: squash(el.length ? el.text() : $(node).text()), heading };
}

/** Extracts publicly displayed addresses: mailto links and plain visible text. No guessing or de-obfuscation. */
export function extractEmails(html: string): EmailFinding[] {
  const $ = cheerio.load(html);
  $('script,style,noscript,template,svg').remove();
  const out = new Map<string, EmailFinding>();
  const add = (f: EmailFinding) => {
    const key = `${f.email}|${f.method}`;
    if (!out.has(key)) out.set(key, f);
  };

  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').trim();
    if (!/^mailto:/i.test(href)) return;
    let target = href.slice(7).split('?')[0] ?? '';
    try {
      target = decodeURIComponent(target);
    } catch {
      /* keep raw */
    }
    for (const part of target.split(/[,;]/)) {
      const email = normalizeEmail(part);
      if (!isUsableFinding(email)) continue;
      add({ email, method: 'mailto', ...contextFor($, a) });
    }
  });

  const walk = (node: AnyNode) => {
    if (node.type === 'text') {
      const text = (node as unknown as { data: string }).data;
      // Visible text of a mailto link is the same evidence as the link itself.
      const mailtoHref = ($((node as unknown as { parent: Element }).parent).closest('a[href]').attr('href') ?? '').toLowerCase();
      for (const m of text.matchAll(EMAIL_RE)) {
        const email = normalizeEmail(m[0]);
        if (!isUsableFinding(email)) continue;
        if (mailtoHref.startsWith('mailto:') && mailtoHref.includes(email)) continue;
        add({ email, method: 'text', ...contextFor($, node) });
      }
      return;
    }
    for (const child of (node as Element).children ?? []) walk(child);
  };
  const body = $('body').get(0);
  if (body) walk(body);
  return [...out.values()];
}

const LINK_PRIORITY: [RegExp, number, PageType][] = [
  [/(contact|reach-?us|get-?in-?touch|enquir|inquir)/i, 100, 'contact'],
  [/(career|jobs?\b|join-?us|join-?our-?team|work-?with-?us|hiring|vacanc|openings|recruit)/i, 95, 'careers'],
  [/(leadership|management|founders?|board|directors|executive)/i, 80, 'leadership'],
  [/(team|people|our-?team|who-?we-?are)/i, 75, 'team'],
  [/(about|company|overview)/i, 70, 'about'],
];

export function classifyPage(url: string, title = ''): PageType {
  let path = '/';
  try {
    path = new URL(url).pathname;
  } catch {
    /* ignore */
  }
  if (path === '/' || path === '') return 'home';
  const hay = `${path} ${title}`;
  for (const [re, , type] of LINK_PRIORITY) if (re.test(hay)) return type;
  return 'other';
}

export interface CandidateLink {
  url: string;
  score: number;
}

/** Same-site links that look like contact/careers/about/team pages, best first. */
export function extractCandidateLinks(html: string, baseUrl: string, domain: string): CandidateLink[] {
  const $ = cheerio.load(html);
  const found = new Map<string, number>();
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:/i.test(abs) || !isSameSite(abs, domain)) return;
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|pptx?|mp4|mp3)(\?|$)/i.test(abs)) return;
    const text = squash($(a).text(), 80);
    const hay = `${new URL(abs).pathname} ${text}`;
    let score = 0;
    for (const [re, s] of LINK_PRIORITY) if (re.test(hay)) score = Math.max(score, s);
    if (score === 0) return;
    const key = canonicalPageUrl(abs);
    found.set(key, Math.max(found.get(key) ?? 0, score));
  });
  return [...found.entries()].map(([url, score]) => ({ url, score })).sort((a, b) => b.score - a.score);
}

export function pageTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? squash(m[1]!, 150) : '';
}
