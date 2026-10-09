import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import axios from 'axios';
import { config } from '../config.js';
import { assertPublicUrl, safeLookup } from './ssrf.js';

export class FetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20, lookup: safeLookup as never });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, lookup: safeLookup as never });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serializes requests per host and enforces a minimum delay between them. */
export class HostThrottle {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly lastAt = new Map<string, number>();

  async run<T>(host: string, delayMs: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.chains.set(host, prev.then(() => mine));
    await prev;
    try {
      const wait = (this.lastAt.get(host) ?? 0) + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      return await fn();
    } finally {
      this.lastAt.set(host, Date.now());
      release();
    }
  }
}

export const hostThrottle = new HostThrottle();

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
  redirects: number;
}

export interface SafeFetchOptions {
  accept?: RegExp; // allowed content types
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  hostDelayMs?: number;
}

async function readLimited(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += b.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new FetchError(`Response exceeded ${maxBytes} bytes`, 'TOO_LARGE');
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/**
 * GET with SSRF validation on every hop, manual redirect handling, a hard response-size cap,
 * a timeout, content-type filtering and per-host politeness delays.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<FetchResult> {
  const cfg = config();
  const maxRedirects = opts.maxRedirects ?? cfg.CRAWL_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? cfg.CRAWL_MAX_BYTES;
  const timeout = opts.timeoutMs ?? cfg.CRAWL_TIMEOUT_MS;
  const accept = opts.accept ?? /^(text\/html|application\/xhtml\+xml)/i;
  const delay = opts.hostDelayMs ?? cfg.CRAWL_HOST_DELAY_MS;

  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const u = await assertPublicUrl(current);
    const res = await hostThrottle.run(u.host, delay, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const r = await axios.get<Readable>(u.toString(), {
          responseType: 'stream',
          maxRedirects: 0,
          timeout,
          signal: controller.signal,
          validateStatus: () => true,
          httpAgent,
          httpsAgent,
          headers: { 'User-Agent': cfg.CRAWL_USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' },
          decompress: true,
        });
        const status = r.status;
        const location = typeof r.headers.location === 'string' ? r.headers.location : undefined;
        const contentType = String(r.headers['content-type'] ?? '');
        const declared = Number(r.headers['content-length'] ?? 0);
        if (status >= 300 && status < 400) {
          r.data.destroy();
          return { status, location, contentType, body: '' };
        }
        if (status >= 400) {
          r.data.destroy();
          return { status, contentType, body: '' };
        }
        if (!accept.test(contentType)) {
          r.data.destroy();
          throw new FetchError(`Unsupported content type "${contentType}"`, 'BAD_CONTENT_TYPE');
        }
        if (declared > maxBytes) {
          r.data.destroy();
          throw new FetchError(`Response exceeded ${maxBytes} bytes`, 'TOO_LARGE');
        }
        const buf = await readLimited(r.data, maxBytes);
        return { status, contentType, body: buf.toString('utf8') };
      } catch (e) {
        if (e instanceof FetchError) throw e;
        if (axios.isCancel(e) || (e as { code?: string }).code === 'ECONNABORTED' || controller.signal.aborted) {
          throw new FetchError(`Timed out after ${timeout} ms`, 'TIMEOUT');
        }
        if ((e as Error).name === 'SsrfError' || (e as { code?: string }).code === 'SSRF_BLOCKED') throw e;
        throw new FetchError((e as Error).message, (e as { code?: string }).code ?? 'NETWORK');
      } finally {
        clearTimeout(timer);
      }
    });

    if (res.status >= 300 && res.status < 400 && 'location' in res && res.location) {
      if (hop >= maxRedirects) throw new FetchError(`Too many redirects (>${maxRedirects})`, 'TOO_MANY_REDIRECTS');
      current = new URL(res.location, u).toString();
      continue;
    }
    return { url: u.toString(), status: res.status, contentType: res.contentType, body: res.body, redirects: hop };
  }
}
