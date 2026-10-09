import fs from 'node:fs';
import { config } from '../config.js';
import { getDb, logEvent } from '../db/index.js';
import { classifySmtpError } from '../email/errors.js';
import { fromHeader, realTransport, simulatedTransport, smtpStatus } from '../email/transport.js';
import { logger } from '../logger.js';
import { getSettings } from '../settings.js';
import { hasResume, publishCampaign, resumePath, unsubscribeUrl, type MessageRow } from './service.js';

type Clock = () => number;

interface ClaimedMessage extends MessageRow {
  campaign_test_mode: number;
  campaign_attach_resume: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Database-backed send queue.
 * - Claims one message at a time with a conditional UPDATE (status queued → processing), so no two workers
 *   (or overlapping ticks) can process the same message.
 * - Reserves the recipient address in `send_ledger` (PRIMARY KEY on email) before SMTP submission, so an
 *   address is never submitted twice across campaigns.
 * - Ambiguous outcomes are parked as `unknown` and never retried automatically.
 * - Survives restarts: on start, messages caught mid-processing are requeued only if submission never began.
 */
export class CampaignWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<Promise<void>>();
  private lastSubmitAt = 0;
  private ticking = false;

  constructor(private readonly clock: Clock = Date.now) {}

  start(): void {
    this.recover();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), config().WORKER_POLL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drain();
  }

  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  recover(): void {
    const db = getDb();
    db.transaction(() => {
      db.prepare(`UPDATE campaign_messages SET status = 'queued', attempts = MAX(attempts - 1, 0) WHERE status = 'processing' AND submit_started_at IS NULL`).run();
      const stuck = db.prepare(`SELECT id FROM campaign_messages WHERE status = 'processing'`).all() as { id: number }[];
      for (const s of stuck) {
        db.prepare(
          `UPDATE campaign_messages SET status = 'unknown', error_code = 'INTERRUPTED',
             error_message = 'Server stopped during SMTP submission; outcome unknown — not retried to avoid duplicates', processed_at = ?
           WHERE id = ?`,
        ).run(iso(this.clock()), s.id);
        db.prepare(`UPDATE send_ledger SET state = 'unknown' WHERE message_id = ?`).run(s.id);
      }
    })();
  }

  /** One scheduling pass. Safe to call concurrently; overlapping calls are ignored. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const s = getSettings();
      if (s.killSwitch) return; // no new submissions at all
      const minInterval = 60_000 / s.sendRatePerMinute;
      while (this.inFlight.size < s.sendConcurrency) {
        const now = this.clock();
        if (this.lastSubmitAt && now - this.lastSubmitAt < minInterval) break;
        if (!s.testMode && this.realSendsLast24h(now) >= s.sendDailyLimit) {
          this.pauseAllSending(`Daily sending limit (${s.sendDailyLimit}) reached — resume later`);
          break;
        }
        const msg = this.claimNext(now);
        if (!msg) break;
        this.lastSubmitAt = now;
        const p = this.process(msg).catch((e) => logger.error({ err: e, messageId: msg.id }, 'worker process error'));
        this.inFlight.add(p);
        void p.finally(() => this.inFlight.delete(p));
      }
      this.finalizeCampaigns();
    } finally {
      this.ticking = false;
    }
  }

  private realSendsLast24h(now: number): number {
    return (
      getDb()
        .prepare(
          `SELECT COUNT(*) n FROM campaign_messages m JOIN campaigns c ON c.id = m.campaign_id
           WHERE c.test_mode = 0 AND m.status IN ('accepted','delivered','bounced','unknown','processing') AND m.submit_started_at >= ?`,
        )
        .get(iso(now - 24 * 3600 * 1000)) as { n: number }
    ).n;
  }

  private pauseAllSending(reason: string): void {
    const db = getDb();
    const ids = db.prepare(`SELECT id FROM campaigns WHERE status = 'sending'`).all() as { id: number }[];
    for (const { id } of ids) {
      db.prepare(`UPDATE campaigns SET status = 'paused', paused_reason = ? WHERE id = ? AND status = 'sending'`).run(reason, id);
      logEvent('campaign.paused', reason, { type: 'campaign', id });
      publishCampaign(id);
    }
  }

  claimNext(now: number = this.clock()): ClaimedMessage | null {
    const db = getDb();
    return db.transaction(() => {
      const row = db
        .prepare(
          `SELECT m.*, c.test_mode AS campaign_test_mode, c.attach_resume AS campaign_attach_resume
           FROM campaign_messages m JOIN campaigns c ON c.id = m.campaign_id
           WHERE c.status = 'sending' AND m.status = 'queued' AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?)
           ORDER BY m.campaign_id, m.id LIMIT 1`,
        )
        .get(iso(now)) as ClaimedMessage | undefined;
      if (!row) return null;
      const r = db
        .prepare(`UPDATE campaign_messages SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'`)
        .run(iso(now), row.id);
      return r.changes === 1 ? { ...row, status: 'processing', attempts: row.attempts + 1 } : null;
    })();
  }

  private finish(m: MessageRow, fields: Record<string, string | number | null>): void {
    const keys = Object.keys(fields);
    getDb()
      .prepare(`UPDATE campaign_messages SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k]!), iso(this.clock()), m.id);
    publishCampaign(m.campaign_id);
  }

  private requeue(m: MessageRow, reason?: string): void {
    // The claim incremented attempts although nothing was submitted.
    getDb()
      .prepare(`UPDATE campaign_messages SET status = 'queued', attempts = MAX(attempts - 1, 0), error_message = COALESCE(?, error_message) WHERE id = ?`)
      .run(reason ?? null, m.id);
    publishCampaign(m.campaign_id);
  }

  async process(m: ClaimedMessage): Promise<void> {
    const db = getDb();
    const now = () => iso(this.clock());
    const settings = getSettings();
    const simulate = m.campaign_test_mode === 1 || settings.testMode;

    // 1. Suppression check at send time (an opt-out may have arrived after approval).
    if (db.prepare('SELECT 1 FROM suppressions WHERE email = ?').get(m.email)) {
      return this.finish(m, { status: 'skipped', error_code: 'SUPPRESSED', error_message: 'Address is suppressed', processed_at: now() });
    }

    // 2. Sender configuration (real sends only).
    if (!simulate && !smtpStatus().configured) {
      this.requeue(m, 'SMTP not configured');
      db.prepare(`UPDATE campaigns SET status = 'paused', paused_reason = 'SMTP configuration incomplete' WHERE id = ? AND status = 'sending'`).run(
        m.campaign_id,
      );
      return publishCampaign(m.campaign_id);
    }

    // 3. Duplicate-send prevention: reserve the address (real sends only).
    if (!simulate) {
      const owner = db.prepare('SELECT message_id, state FROM send_ledger WHERE email = ?').get(m.email) as
        | { message_id: number; state: string }
        | undefined;
      if (owner && owner.message_id !== m.id) {
        return this.finish(m, {
          status: 'skipped',
          error_code: 'DUPLICATE',
          error_message: `Already ${owner.state === 'accepted' ? 'sent' : 'reserved/unresolved'} by message #${owner.message_id}`,
          processed_at: now(),
        });
      }
      if (!owner) {
        try {
          db.prepare(`INSERT INTO send_ledger (email, message_id, state) VALUES (?, ?, 'reserved')`).run(m.email, m.id);
        } catch {
          return this.finish(m, { status: 'skipped', error_code: 'DUPLICATE', error_message: 'Address reserved by another message', processed_at: now() });
        }
      }
    }

    // 4. Last-moment kill-switch / pause check before anything leaves the process.
    const campaignStatus = (db.prepare('SELECT status FROM campaigns WHERE id = ?').get(m.campaign_id) as { status: string }).status;
    if (getSettings().killSwitch || campaignStatus !== 'sending') {
      if (!simulate) db.prepare(`DELETE FROM send_ledger WHERE message_id = ? AND state = 'reserved'`).run(m.id);
      return this.requeue(m);
    }

    const from = fromHeader();
    const unsub = unsubscribeUrl(m.unsubscribe_token);
    const listUnsub = [`<mailto:${from.address || 'unsubscribe@invalid'}?subject=unsubscribe>`, unsub ? `<${unsub}>` : null].filter(Boolean).join(', ');
    const domain = (from.address.split('@')[1] || 'applytick.local').toLowerCase();
    const attachments =
      m.campaign_attach_resume && hasResume()
        ? [{ filename: `${(config().SENDER_NAME || 'Resume').replace(/[^\w .-]/g, '')} - Resume.pdf`, content: fs.readFileSync(resumePath()), contentType: 'application/pdf' }]
        : undefined;

    db.prepare('UPDATE campaign_messages SET submit_started_at = ? WHERE id = ?').run(now(), m.id);
    try {
      const transport = simulate ? simulatedTransport() : realTransport();
      const info = await transport.sendMail({
        from: from.name ? { name: from.name, address: from.address || 'test@applytick.local' } : from.address || 'test@applytick.local',
        to: m.email, // exactly one recipient per message; never cc/bcc others
        subject: m.subject,
        html: m.html,
        text: m.text,
        messageId: `<${m.idempotency_key}@${domain}>`,
        attachments,
        headers: {
          'List-Unsubscribe': listUnsub,
          ...(unsub ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}),
          'X-Applytick-Id': m.idempotency_key,
        },
      });
      const rejected = (info.rejected ?? []).map((r) => (typeof r === 'string' ? r : r.address).toLowerCase());
      if (rejected.includes(m.email)) {
        if (!simulate) db.prepare('DELETE FROM send_ledger WHERE message_id = ?').run(m.id);
        return this.finish(m, { status: 'failed', error_code: 'REJECTED', error_message: info.response ?? 'Recipient rejected', processed_at: now() });
      }
      if (!simulate) db.prepare(`UPDATE send_ledger SET state = 'accepted' WHERE message_id = ?`).run(m.id);
      this.finish(m, {
        status: simulate ? 'simulated' : 'accepted',
        smtp_message_id: info.messageId ?? null,
        smtp_response: simulate ? 'Test mode: message built but not transmitted' : (info.response ?? null),
        error_code: null,
        error_message: null,
        processed_at: now(),
      });
    } catch (err) {
      const c = classifySmtpError(err);
      const maxAttempts = config().SEND_MAX_ATTEMPTS;
      if (c.kind === 'ambiguous') {
        if (!simulate) db.prepare(`UPDATE send_ledger SET state = 'unknown' WHERE message_id = ?`).run(m.id);
        return this.finish(m, {
          status: 'unknown',
          error_code: c.code,
          error_message: `Outcome unknown (${c.message}). Not retried automatically to avoid a duplicate — check your Sent folder and resolve manually.`,
          processed_at: now(),
        });
      }
      if (c.kind === 'config') {
        if (!simulate) db.prepare(`DELETE FROM send_ledger WHERE message_id = ? AND state = 'reserved'`).run(m.id);
        db.prepare('UPDATE campaign_messages SET submit_started_at = NULL WHERE id = ?').run(m.id);
        this.requeue(m, `SMTP authentication failed: ${c.message}`);
        db.prepare(`UPDATE campaigns SET status = 'paused', paused_reason = ? WHERE id = ? AND status = 'sending'`).run(
          `SMTP authentication failed — fix credentials and resume`,
          m.campaign_id,
        );
        logEvent('campaign.paused', 'SMTP authentication failed', { type: 'campaign', id: m.campaign_id });
        return publishCampaign(m.campaign_id);
      }
      if (c.kind === 'transient' && m.attempts < maxAttempts) {
        const backoff = 60_000 * 2 ** (m.attempts - 1);
        db.prepare('UPDATE campaign_messages SET submit_started_at = NULL WHERE id = ?').run(m.id);
        return this.finish(m, {
          status: 'queued',
          error_code: c.code,
          error_message: `Temporary failure (attempt ${m.attempts}/${maxAttempts}): ${c.message}`,
          next_attempt_at: iso(this.clock() + backoff),
        });
      }
      if (!simulate) db.prepare('DELETE FROM send_ledger WHERE message_id = ?').run(m.id);
      if (c.kind === 'permanent' && c.recipientRejected) {
        db.prepare(`INSERT OR IGNORE INTO suppressions (email, reason, source) VALUES (?, ?, 'bounce')`).run(m.email, `SMTP rejected recipient: ${c.message}`);
      }
      this.finish(m, {
        status: 'failed',
        error_code: c.code,
        error_message: c.kind === 'transient' ? `Gave up after ${m.attempts} attempts: ${c.message}` : c.message,
        processed_at: now(),
      });
    }
  }

  finalizeCampaigns(): void {
    const db = getDb();
    const done = db
      .prepare(
        `SELECT id FROM campaigns c WHERE status = 'sending' AND NOT EXISTS (
           SELECT 1 FROM campaign_messages m WHERE m.campaign_id = c.id AND m.status IN ('queued','processing'))`,
      )
      .all() as { id: number }[];
    for (const { id } of done) {
      db.prepare(`UPDATE campaigns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`).run(iso(this.clock()), iso(this.clock()), id);
      logEvent('campaign.completed', 'Campaign finished processing', { type: 'campaign', id });
      publishCampaign(id);
    }
  }
}

export let worker: CampaignWorker | null = null;
export function startWorker(): CampaignWorker {
  worker = new CampaignWorker();
  worker.start();
  return worker;
}
