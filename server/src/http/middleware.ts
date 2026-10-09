import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../campaigns/service.js';
import { config } from '../config.js';
import { ProviderConfigError } from '../discovery/types.js';
import { ConflictError } from '../discovery/runner.js';
import { TemplateError } from '../email/templates.js';
import { logger } from '../logger.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return r.data;
}

export const idParam = z.coerce.number().int().positive();

/**
 * Rejects requests whose Host header is not an expected local/allowed host. This blocks DNS-rebinding
 * attacks where a malicious web page resolves its own domain to 127.0.0.1 to reach this API.
 */
export function hostGuard(req: Request, res: Response, next: NextFunction): void {
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  const extra = config()
    .ALLOWED_HOSTS.split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (['localhost', '127.0.0.1', '[::1]', ...extra].includes(host)) return next();
  res.status(421).json({ error: `Host "${host}" is not allowed. Add it to ALLOWED_HOSTS if this deployment is intentional.` });
}

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Optional bearer-token auth (required whenever the server binds to a non-loopback address). */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = config().ADMIN_TOKEN;
  if (!expected) return next();
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : typeof req.query.token === 'string' ? req.query.token : '';
  if (given && tokenMatches(given, expected)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * CSRF protection for state-changing API calls: a custom header forces a CORS preflight, which this
 * server never approves for foreign origins, so other websites cannot trigger sends from the browser.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-applytick'] === '1') return next();
  res.status(403).json({ error: 'Missing X-Applytick header' });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof TemplateError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof ProviderConfigError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  const e = err as { type?: string; status?: number; message?: string };
  if (e.type === 'entity.parse.failed' || e.type === 'entity.too.large') {
    res.status(e.status ?? 400).json({ error: e.message });
    return;
  }
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}

/** Server-Sent Events helper: sends a snapshot immediately and whenever the channel fires (throttled). */
export function sse(req: Request, res: Response, subscribe: (cb: () => void) => () => void, snapshot: () => unknown): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let pending: NodeJS.Timeout | null = null;
  const send = () => {
    pending = null;
    try {
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`);
    }
  };
  const schedule = () => {
    if (!pending) pending = setTimeout(send, 200);
  };
  send();
  const unsubscribe = subscribe(schedule);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    if (pending) clearTimeout(pending);
    unsubscribe();
  });
}
