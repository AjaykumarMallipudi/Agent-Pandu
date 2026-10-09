import crypto from 'node:crypto';
import { getDb } from '../db/index.js';

/** Persistent response cache for public APIs, so repeated searches do not re-query the service. */
export function cacheKey(namespace: string, input: string): string {
  return `${namespace}:${crypto.createHash('sha256').update(input).digest('hex')}`;
}

export function cacheGet<T>(key: string): T | undefined {
  const row = getDb().prepare('SELECT value, expires_at FROM api_cache WHERE key = ?').get(key) as
    | { value: string; expires_at: string }
    | undefined;
  if (!row) return undefined;
  if (Date.parse(row.expires_at) <= Date.now()) {
    getDb().prepare('DELETE FROM api_cache WHERE key = ?').run(key);
    return undefined;
  }
  return JSON.parse(row.value) as T;
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  getDb()
    .prepare('INSERT INTO api_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at')
    .run(key, JSON.stringify(value), new Date(Date.now() + ttlMs).toISOString());
}
