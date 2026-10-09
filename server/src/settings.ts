import { z } from 'zod';
import { config } from './config.js';
import { getDb } from './db/index.js';

/**
 * Non-secret runtime settings editable from the UI. SMTP credentials are never stored here.
 * Safety flags combine with the environment so the UI can only make sending *safer*:
 * - EMAIL_TEST_MODE=true in .env cannot be switched off from the UI.
 * - SENDING_KILL_SWITCH=true in .env cannot be released from the UI.
 */
export const settingsSchema = z.object({
  maxRecipientsPerCampaign: z.union([z.literal(50), z.literal(100)]),
  sendRatePerMinute: z.number().int().min(1).max(600),
  sendDailyLimit: z.number().int().min(1).max(100000),
  sendConcurrency: z.number().int().min(1).max(10),
  minConfidence: z.number().int().min(0).max(100),
  testMode: z.boolean(),
  killSwitch: z.boolean(),
});
export type RuntimeSettings = z.infer<typeof settingsSchema>;

function defaults(): RuntimeSettings {
  const c = config();
  return {
    maxRecipientsPerCampaign: c.MAX_RECIPIENTS_PER_CAMPAIGN > 50 ? 100 : 50,
    sendRatePerMinute: c.SEND_RATE_PER_MINUTE,
    sendDailyLimit: c.SEND_DAILY_LIMIT,
    sendConcurrency: c.SEND_CONCURRENCY,
    minConfidence: c.MIN_CONFIDENCE,
    testMode: c.EMAIL_TEST_MODE,
    killSwitch: c.SENDING_KILL_SWITCH,
  };
}

export function getSettings(): RuntimeSettings & { testModeLockedByEnv: boolean; killSwitchLockedByEnv: boolean } {
  const c = config();
  const stored: Record<string, unknown> = {};
  for (const row of getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      /* ignore corrupt values */
    }
  }
  const merged = settingsSchema.partial().safeParse(stored);
  const s: RuntimeSettings = { ...defaults(), ...(merged.success ? merged.data : {}) };
  // Provider limits from the environment are hard caps.
  s.sendRatePerMinute = Math.min(s.sendRatePerMinute, c.SEND_RATE_PER_MINUTE);
  s.sendDailyLimit = Math.min(s.sendDailyLimit, c.SEND_DAILY_LIMIT);
  s.sendConcurrency = Math.min(s.sendConcurrency, c.SEND_CONCURRENCY);
  return {
    ...s,
    testMode: c.EMAIL_TEST_MODE || s.testMode,
    killSwitch: c.SENDING_KILL_SWITCH || s.killSwitch,
    testModeLockedByEnv: c.EMAIL_TEST_MODE,
    killSwitchLockedByEnv: c.SENDING_KILL_SWITCH,
  };
}

export function updateSettings(patch: Partial<RuntimeSettings>): void {
  const parsed = settingsSchema.partial().parse(patch);
  const stmt = getDb().prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  getDb().transaction(() => {
    for (const [k, v] of Object.entries(parsed)) if (v !== undefined) stmt.run(k, JSON.stringify(v));
  })();
}
