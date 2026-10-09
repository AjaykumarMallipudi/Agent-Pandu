import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, setConfig } from '../src/config.js';
import { getDb, initDb } from '../src/db/index.js';
import { ensureDefaultTemplate } from '../src/email/templates.js';
import { setTransportFactory, type MailTransport } from '../src/email/transport.js';
import { setResolver } from '../src/lib/ssrf.js';
import { clearRobotsCache } from '../src/lib/robots.js';
import { setMxResolver } from '../src/crawler/mx.js';
import { setProviderOverride } from '../src/discovery/runner.js';
import type Mail from 'nodemailer/lib/mailer';

export function setupTestEnv(overrides: Record<string, string> = {}): { dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'applytick-test-'));
  setConfig(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      DATA_DIR: dataDir,
      EMAIL_TEST_MODE: 'false',
      SENDING_KILL_SWITCH: 'false',
      SMTP_HOST: 'smtp.mock.invalid',
      SMTP_PORT: '587',
      SMTP_USER: 'user@sender.dev',
      SMTP_PASSWORD: 'super-secret-password',
      EMAIL_FROM: 'jane@sender.dev',
      SENDER_NAME: 'Jane Applicant',
      SENDER_LINKEDIN: 'https://linkedin.com/in/jane',
      SENDER_GITHUB: 'https://github.com/jane',
      TEST_EMAIL_ADDRESS: 'jane+test@sender.dev',
      CRAWL_HOST_DELAY_MS: '0',
      CRAWL_CHECK_MX: 'false',
      SEND_RATE_PER_MINUTE: '600',
      SEND_DAILY_LIMIT: '1000',
      SEND_CONCURRENCY: '1',
      MAX_RECIPIENTS_PER_CAMPAIGN: '100',
      MIN_CONFIDENCE: '40',
      GOOGLE_PLACES_API_KEY: '',
      OSM_CONTACT_EMAIL: '',
      ...overrides,
    }),
  );
  initDb(':memory:');
  ensureDefaultTemplate();
  // Every hostname resolves to a public documentation address unless a test says otherwise.
  setResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
  setMxResolver(async () => true);
  clearRobotsCache();
  setProviderOverride(null);
  return { dataDir };
}

export type Behaviour = (msg: Mail.Options) => Promise<{ messageId?: string; response?: string; rejected?: string[] }>;

/** Records every message; behaviour per recipient can be scripted. Never touches the network. */
export class MockSmtp implements MailTransport {
  sent: Mail.Options[] = [];
  behaviours = new Map<string, Behaviour>();
  verifyCalls = 0;
  async sendMail(msg: Mail.Options) {
    this.sent.push(msg);
    const b = this.behaviours.get(String(msg.to));
    if (b) return b(msg);
    return { messageId: `<mock-${this.sent.length}@mock>`, response: '250 2.0.0 OK queued', accepted: [String(msg.to)], rejected: [] };
  }
  async verify() {
    this.verifyCalls++;
    return true;
  }
}

export function installMockSmtp(): MockSmtp {
  const m = new MockSmtp();
  setTransportFactory(() => m);
  return m;
}

let companySeq = 0;
export function insertContact(opts: { email: string; name?: string; type?: string; confidence?: number; company?: string } ): number {
  const db = getDb();
  companySeq++;
  const companyId = Number(
    db
      .prepare(`INSERT INTO companies (name, domain, website_url, discovery_status, country) VALUES (?, ?, ?, 'scanned', 'India')`)
      .run(opts.company ?? `Company ${companySeq}`, `company${companySeq}-${Math.random().toString(36).slice(2, 7)}.com`, 'https://x.com/')
      .lastInsertRowid,
  );
  return Number(
    db
      .prepare(
        `INSERT INTO contacts (company_id, email, name, contact_type, syntax_valid, domain_matches_company, confidence, confidence_explanation)
         VALUES (?, ?, ?, ?, 1, 1, ?, '[]')`,
      )
      .run(companyId, opts.email, opts.name ?? null, opts.type ?? 'HR', opts.confidence ?? 80).lastInsertRowid,
  );
}

export function defaultTemplateId(): number {
  return (getDb().prepare('SELECT id FROM email_templates LIMIT 1').get() as { id: number }).id;
}

export function messages(campaignId: number) {
  return getDb().prepare('SELECT * FROM campaign_messages WHERE campaign_id = ? ORDER BY id').all(campaignId) as {
    id: number;
    email: string;
    status: string;
    attempts: number;
    error_code: string | null;
    error_message: string | null;
    next_attempt_at: string | null;
  }[];
}
