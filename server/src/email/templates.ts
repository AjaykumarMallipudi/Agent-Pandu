import Handlebars from 'handlebars';
import sanitizeHtml from 'sanitize-html';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

export const PLACEHOLDERS = [
  'name',
  'company',
  'role',
  'position',
  'sender_name',
  'sender_email',
  'phone',
  'linkedin',
  'github',
  'portfolio',
  'unsubscribe_url',
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type TemplateContext = Record<Placeholder, string>;

export const FALLBACK_NAME = 'Hiring Team';

export class TemplateError extends Error {
  readonly status = 400;
}

type Node = { type: string; [k: string]: unknown };

/**
 * Only `{{placeholder}}` (escaped) and `{{#if placeholder}}…{{else}}…{{/if}}` / `{{#unless}}` are allowed.
 * Triple-stash, `{{& }}`, partials, helpers, paths and decorators are rejected.
 */
export function validateTemplateSource(src: string, field: string): void {
  let ast: hbs.AST.Program;
  try {
    ast = Handlebars.parse(src);
  } catch (e) {
    throw new TemplateError(`${field}: template syntax error — ${(e as Error).message.split('\n')[0]}`);
  }
  const allowed = new Set<string>(PLACEHOLDERS);
  const checkPath = (p: Node) => {
    if (p.type !== 'PathExpression') throw new TemplateError(`${field}: only simple placeholders are allowed`);
    const path = p as unknown as hbs.AST.PathExpression;
    if (path.depth !== 0 || path.parts.length !== 1 || !allowed.has(path.original)) {
      throw new TemplateError(`${field}: unknown placeholder {{${path.original}}}. Allowed: ${PLACEHOLDERS.join(', ')}`);
    }
  };
  const visit = (n: Node | null | undefined) => {
    if (!n) return;
    switch (n.type) {
      case 'Program':
        for (const s of (n as unknown as hbs.AST.Program).body) visit(s as unknown as Node);
        return;
      case 'ContentStatement':
      case 'CommentStatement':
        return;
      case 'MustacheStatement': {
        const m = n as unknown as hbs.AST.MustacheStatement;
        if (!m.escaped) throw new TemplateError(`${field}: unescaped output ({{{ }}} or {{& }}) is not allowed`);
        if (m.params.length || (m.hash && m.hash.pairs.length)) throw new TemplateError(`${field}: helpers are not allowed`);
        checkPath(m.path as unknown as Node);
        return;
      }
      case 'BlockStatement': {
        const b = n as unknown as hbs.AST.BlockStatement;
        const helper = (b.path as hbs.AST.PathExpression).original;
        if (helper !== 'if' && helper !== 'unless') throw new TemplateError(`${field}: only #if / #unless blocks are allowed`);
        if (b.params.length !== 1) throw new TemplateError(`${field}: #${helper} needs exactly one placeholder`);
        checkPath(b.params[0] as unknown as Node);
        visit(b.program as unknown as Node);
        visit(b.inverse as unknown as Node);
        return;
      }
      default:
        throw new TemplateError(`${field}: ${n.type} is not allowed in templates`);
    }
  };
  visit(ast as unknown as Node);
}

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a', 'b', 'blockquote', 'br', 'center', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol',
    'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
  ],
  allowedAttributes: {
    '*': ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'role', 'class', 'dir', 'colspan', 'rowspan'],
    a: ['href', 'target', 'rel', 'title', 'style'],
    img: ['src', 'alt', 'width', 'height', 'style'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
  },
};

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTS);
}

const compileOpts = { knownHelpers: { if: true, unless: true }, knownHelpersOnly: true, strict: false } as const;

function httpUrl(v: string): string {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function senderContext(): Pick<TemplateContext, 'sender_name' | 'sender_email' | 'phone' | 'linkedin' | 'github' | 'portfolio'> {
  const c = config();
  return {
    sender_name: c.SENDER_NAME,
    sender_email: c.EMAIL_FROM.replace(/^.*<([^>]+)>.*$/, '$1'),
    phone: c.SENDER_PHONE,
    linkedin: httpUrl(c.SENDER_LINKEDIN),
    github: httpUrl(c.SENDER_GITHUB),
    portfolio: httpUrl(c.SENDER_PORTFOLIO),
  };
}

export function buildContext(input: {
  name?: string | null;
  company?: string | null;
  role?: string | null;
  position?: string | null;
  unsubscribeUrl?: string | null;
}): TemplateContext {
  return {
    ...senderContext(),
    name: oneLine(input.name || FALLBACK_NAME),
    company: oneLine(input.company || 'your company'),
    role: oneLine(input.role || ''),
    position: oneLine(input.position || ''),
    unsubscribe_url: input.unsubscribeUrl ? httpUrl(input.unsubscribeUrl) : '',
  };
}

export interface TemplateSource {
  subject: string;
  html: string;
  text: string;
}
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const OPT_OUT_HTML = `<p style="margin:24px 0 0;font-size:12px;line-height:18px;color:#6b7280;">You are receiving this one-time message because your address is listed publicly on {{company}}'s website. If you would prefer not to hear from me, simply reply "unsubscribe"{{#if unsubscribe_url}} or <a href="{{unsubscribe_url}}" style="color:#6b7280;">opt out here</a>{{/if}} and I will not contact you again.</p>`;
const OPT_OUT_TEXT = `\n\n--\nYou are receiving this one-time message because your address is listed publicly on {{company}}'s website. If you would prefer not to hear from me, reply "unsubscribe"{{#if unsubscribe_url}} or visit {{unsubscribe_url}}{{/if}} and I will not contact you again.`;

/** Wraps sanitized body HTML in a responsive email document shell. */
function shell(body: string, subject: string): string {
  const title = Handlebars.escapeExpression(subject);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${title}</title></head><body style="margin:0;padding:0;background:#f3f4f6;">${body}</body></html>`;
}

/** Validates, sanitizes and renders a template. All interpolated values are HTML-escaped in the HTML part. */
export function renderTemplate(t: TemplateSource, ctx: TemplateContext): RenderedEmail {
  validateTemplateSource(t.subject, 'Subject');
  validateTemplateSource(t.html, 'HTML');
  validateTemplateSource(t.text, 'Plain text');
  let htmlSrc = sanitizeEmailHtml(t.html);
  let textSrc = t.text;
  if (!/unsubscribe|opt[ -]?out/i.test(t.html)) htmlSrc += OPT_OUT_HTML;
  if (!/unsubscribe|opt[ -]?out/i.test(t.text)) textSrc += OPT_OUT_TEXT;

  const subject = oneLine(Handlebars.compile(t.subject, { ...compileOpts, noEscape: true })(ctx));
  const body = Handlebars.compile(htmlSrc, compileOpts)(ctx);
  const text = Handlebars.compile(textSrc, { ...compileOpts, noEscape: true })(ctx).trim();
  // Re-sanitize the rendered output as defence in depth.
  return { subject, html: shell(sanitizeEmailHtml(body), subject), text };
}

export const DEFAULT_TEMPLATE: TemplateSource & { name: string } = {
  name: 'Professional introduction',
  subject: '{{#if position}}{{position}} — {{/if}}Application from {{sender_name}}',
  html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;">
<tr><td style="height:6px;background:#2563eb;border-radius:12px 12px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:32px 32px 8px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:26px;color:#111827;">
<p style="margin:0 0 16px;">Dear {{name}},</p>
<p style="margin:0 0 16px;">I hope you are doing well. I am writing to express my interest in {{#if position}}<strong>{{position}}</strong> opportunities{{else}}suitable opportunities{{/if}} at <strong>{{company}}</strong>. I found this contact address on your company's public website{{#if role}} listed for {{role}}{{/if}}.</p>
<p style="margin:0 0 16px;">I would welcome the chance to learn about any current or upcoming openings where I could contribute. My resume and links to my work are included below for your review.</p>
<p style="margin:0 0 24px;">Thank you for your time and consideration. I would be glad to share any further information you may need.</p>
<p style="margin:0;">Kind regards,</p>
<p style="margin:4px 0 0;font-weight:600;">{{sender_name}}</p>
</td></tr>
<tr><td style="padding:8px 32px 28px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:#374151;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:2px 0;">Email: <a href="mailto:{{sender_email}}" style="color:#2563eb;text-decoration:none;">{{sender_email}}</a></td></tr>
{{#if phone}}<tr><td style="padding:2px 0;">Phone: {{phone}}</td></tr>{{/if}}
</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;"><tr>
{{#if linkedin}}<td style="padding-right:8px;"><a href="{{linkedin}}" style="display:inline-block;padding:8px 14px;border-radius:6px;background:#0a66c2;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;">LinkedIn</a></td>{{/if}}
{{#if github}}<td style="padding-right:8px;"><a href="{{github}}" style="display:inline-block;padding:8px 14px;border-radius:6px;background:#111827;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;">GitHub</a></td>{{/if}}
{{#if portfolio}}<td><a href="{{portfolio}}" style="display:inline-block;padding:8px 14px;border-radius:6px;background:#2563eb;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;">Portfolio</a></td>{{/if}}
</tr></table>
<p style="margin:24px 0 0;font-size:12px;line-height:18px;color:#6b7280;">You are receiving this one-time message because your address is listed publicly on {{company}}'s website. If you would prefer not to hear from me, simply reply "unsubscribe"{{#if unsubscribe_url}} or <a href="{{unsubscribe_url}}" style="color:#6b7280;">opt out here</a>{{/if}} and I will not contact you again.</p>
</td></tr>
</table>
</td></tr>
</table>`,
  text: `Dear {{name}},

I hope you are doing well. I am writing to express my interest in {{#if position}}{{position}} opportunities{{else}}suitable opportunities{{/if}} at {{company}}. I found this contact address on your company's public website{{#if role}} listed for {{role}}{{/if}}.

I would welcome the chance to learn about any current or upcoming openings where I could contribute. My resume and links to my work are included below for your review.

Thank you for your time and consideration.

Kind regards,
{{sender_name}}
Email: {{sender_email}}
{{#if phone}}Phone: {{phone}}
{{/if}}{{#if linkedin}}LinkedIn: {{linkedin}}
{{/if}}{{#if github}}GitHub: {{github}}
{{/if}}{{#if portfolio}}Portfolio: {{portfolio}}
{{/if}}
--
You are receiving this one-time message because your address is listed publicly on {{company}}'s website. If you would prefer not to hear from me, reply "unsubscribe"{{#if unsubscribe_url}} or visit {{unsubscribe_url}}{{/if}} and I will not contact you again.`,
};

export function ensureDefaultTemplate(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) n FROM email_templates').get() as { n: number }).n;
  if (count === 0) {
    db.prepare('INSERT INTO email_templates (name, subject, html, text, attach_resume) VALUES (?, ?, ?, ?, 0)').run(
      DEFAULT_TEMPLATE.name,
      DEFAULT_TEMPLATE.subject,
      DEFAULT_TEMPLATE.html,
      DEFAULT_TEMPLATE.text,
    );
  }
}

export const SAMPLE_CONTEXT_INPUT = { name: 'Priya Sharma', company: 'Example Technologies', role: 'Talent Acquisition', position: '' };
