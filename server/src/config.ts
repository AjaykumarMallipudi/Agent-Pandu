import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (works from both src/ and dist/). */
export const ROOT_DIR = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));
const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));
const str = (def = '') => z.string().optional().transform((v) => (v ?? def).trim());

const schema = z.object({
  NODE_ENV: str('development'),
  HOST: str('127.0.0.1'),
  PORT: int(4000, 1, 65535),
  ADMIN_TOKEN: str(),
  ALLOWED_HOSTS: str(),
  DATA_DIR: str('data'),
  DATABASE_PATH: str(''),
  LOG_LEVEL: str('info'),

  DISCOVERY_PROVIDER: z.enum(['google_places', 'osm']).optional().default('osm'),
  GOOGLE_PLACES_API_KEY: str(),
  OSM_CONTACT_EMAIL: str(),
  OSM_NOMINATIM_URL: str('https://nominatim.openstreetmap.org'),
  OSM_OVERPASS_URL: str('https://overpass-api.de/api/interpreter'),

  CRAWL_USER_AGENT: str('SmartApplytickBot/1.0 (+public contact discovery; respects robots.txt)'),
  CRAWL_TIMEOUT_MS: int(10000, 1000, 60000),
  CRAWL_MAX_BYTES: int(2_000_000, 10_000, 10_000_000),
  CRAWL_MAX_REDIRECTS: int(5, 0, 10),
  CRAWL_HOST_DELAY_MS: int(1500, 0, 60000),
  CRAWL_CONCURRENCY: int(3, 1, 10),
  CRAWL_CHECK_MX: bool(true),

  SMTP_HOST: str(),
  SMTP_PORT: int(587, 1, 65535),
  SMTP_SECURE: bool(false),
  SMTP_USER: str(),
  SMTP_PASSWORD: str(),
  EMAIL_FROM: str(),
  SENDER_NAME: str(),
  SENDER_PHONE: str(),
  SENDER_LINKEDIN: str(),
  SENDER_GITHUB: str(),
  SENDER_PORTFOLIO: str(),
  TEST_EMAIL_ADDRESS: str(),

  EMAIL_TEST_MODE: bool(true),
  SENDING_KILL_SWITCH: bool(false),
  SEND_RATE_PER_MINUTE: int(10, 1, 600),
  SEND_CONCURRENCY: int(1, 1, 10),
  SEND_DAILY_LIMIT: int(200, 1, 100000),
  SEND_MAX_ATTEMPTS: int(3, 1, 10),
  MAX_RECIPIENTS_PER_CAMPAIGN: int(50, 1, 100),
  MIN_CONFIDENCE: int(40, 0, 100),
  WORKER_POLL_MS: int(1000, 50, 60000),

  PUBLIC_BASE_URL: str(),
  WEBHOOK_SECRET: str(),
});

export type AppConfig = z.infer<typeof schema> & { dataDir: string; databasePath: string };

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  const dataDir = path.resolve(ROOT_DIR, c.DATA_DIR);
  const databasePath =
    c.DATABASE_PATH === ':memory:' ? ':memory:' : path.resolve(ROOT_DIR, c.DATABASE_PATH || path.join(c.DATA_DIR, 'applytick.db'));
  return { ...c, dataDir, databasePath };
}

let current: AppConfig | null = null;
export function config(): AppConfig {
  if (!current) current = loadConfig();
  return current;
}
/** Test hook: replace the active configuration. */
export function setConfig(next: AppConfig): void {
  current = next;
}

export function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}
