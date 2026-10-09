import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { approveCampaign, campaignCounts, createCampaign, pauseCampaign, resumeCampaign, startCampaign } from '../src/campaigns/service.js';
import { CampaignWorker } from '../src/campaigns/worker.js';
import { getDb } from '../src/db/index.js';
import { classifySmtpError } from '../src/email/errors.js';
import { setTransportFactory } from '../src/email/transport.js';
import { updateSettings } from '../src/settings.js';
import { defaultTemplateId, insertContact, installMockSmtp, messages, MockSmtp, setupTestEnv } from './helpers.js';

const H = { 'X-Applytick': '1' };

class FakeClock {
  t = Date.parse('2026-01-01T09:00:00Z');
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

function makeCampaign(emails: string[], name = 'Test campaign') {
  const ids = emails.map((email) => insertContact({ email }));
  return createCampaign({ name, templateId: defaultTemplateId(), contactIds: ids, position: 'Software Engineer' });
}
function launch(id: number) {
  const n = messages(id).filter((m) => m.status === 'draft').length;
  approveCampaign(id, { confirm: true, recipientCount: n });
  startCampaign(id);
}
async function runAll(w: CampaignWorker, clock: FakeClock, maxTicks = 200) {
  for (let i = 0; i < maxTicks; i++) {
    await w.tick();
    await w.drain();
    clock.advance(60_000);
    const pending = getDb().prepare(`SELECT COUNT(*) n FROM campaign_messages WHERE status IN ('queued','processing')`).get() as { n: number };
    if (pending.n === 0) {
      await w.tick();
      return;
    }
  }
}

let smtp: MockSmtp;
let clock: FakeClock;
let worker: CampaignWorker;
beforeEach(() => {
  setupTestEnv();
  smtp = installMockSmtp();
  clock = new FakeClock();
  worker = new CampaignWorker(clock.now);
});
afterEach(async () => {
  await worker.stop();
});

describe('campaign creation and approval', () => {
  it('requires explicit approval before anything is queued or sent', async () => {
    const c = makeCampaign(['a@a.com', 'b@b.com']);
    expect(() => startCampaign(c.id)).toThrow(/Approve/);
    await runAll(worker, clock, 3);
    expect(smtp.sent).toHaveLength(0);
    expect(() => approveCampaign(c.id, { confirm: false, recipientCount: 2 })).toThrow(/confirmation/);
    expect(() => approveCampaign(c.id, { confirm: true, recipientCount: 5 })).toThrow(/count changed/);
    approveCampaign(c.id, { confirm: true, recipientCount: 2 });
    await runAll(worker, clock, 3);
    expect(smtp.sent).toHaveLength(0); // approved but not started
    startCampaign(c.id);
    await runAll(worker, clock);
    expect(smtp.sent).toHaveLength(2);
  });

  it('enforces the configured recipient limit', () => {
    updateSettings({ maxRecipientsPerCampaign: 50 });
    const ids = Array.from({ length: 51 }, (_, i) => insertContact({ email: `p${i}@x${i}.com` }));
    expect(() => createCampaign({ name: 'big', templateId: defaultTemplateId(), contactIds: ids })).toThrow(/at most 50/);
  });

  it('skips suppressed, low-confidence and previously contacted recipients at creation', async () => {
    getDb().prepare(`INSERT INTO suppressions (email, reason, source) VALUES ('sup@a.com', 'x', 'manual')`).run();
    const low = insertContact({ email: 'low@a.com', confidence: 10 });
    const first = makeCampaign(['done@a.com']);
    launch(first.id);
    await runAll(worker, clock);
    const ids = [insertContact({ email: 'sup@a.com' }), low, getDb().prepare(`SELECT id FROM contacts WHERE email='done@a.com'`).pluck().get() as number, insertContact({ email: 'ok@a.com' })];
    const c = createCampaign({ name: 'second', templateId: defaultTemplateId(), contactIds: ids });
    const byEmail = Object.fromEntries(messages(c.id).map((m) => [m.email, m]));
    expect(byEmail['sup@a.com']!.status).toBe('skipped');
    expect(byEmail['low@a.com']!.error_message).toMatch(/Confidence/);
    expect(byEmail['done@a.com']!.error_message).toMatch(/Already contacted/);
    expect(byEmail['ok@a.com']!.status).toBe('draft');
  });

  it('reports 0% progress for drafts even when some recipients were auto-skipped', () => {
    getDb().prepare(`INSERT INTO suppressions (email, reason, source) VALUES ('s@a.com', 'x', 'manual')`).run();
    const c = makeCampaign(['s@a.com', 'ok@a.com']);
    expect(campaignCounts(c.id)).toMatchObject({ draft: 1, skipped: 1, progress: 0 });
    launch(c.id);
    expect(campaignCounts(c.id)).toMatchObject({ queued: 1, progress: 50 });
  });

  it('lets the user exclude recipients before approval only', () => {
    const c = makeCampaign(['a@a.com', 'b@b.com']);
    const [m1] = messages(c.id);
    const app = createApp();
    return request(app)
      .patch(`/api/campaigns/${c.id}/messages/${m1!.id}`)
      .set(H)
      .send({ excluded: true })
      .then(async (r) => {
        expect(r.status).toBe(200);
        expect(r.body.counts.excluded).toBe(1);
        expect(r.body.counts.total).toBe(1);
        approveCampaign(c.id, { confirm: true, recipientCount: 1 });
        const again = await request(app).patch(`/api/campaigns/${c.id}/messages/${m1!.id}`).set(H).send({ excluded: false });
        expect(again.status).toBe(409);
      });
  });
});

describe('sending', () => {
  it('sends one separate message per recipient without exposing others', async () => {
    const c = makeCampaign(['a@a.com', 'b@b.com', 'c@c.com']);
    launch(c.id);
    await runAll(worker, clock);
    expect(smtp.sent.map((m) => m.to)).toEqual(['a@a.com', 'b@b.com', 'c@c.com']);
    const all = ['a@a.com', 'b@b.com', 'c@c.com'];
    for (const m of smtp.sent) {
      expect(m.cc).toBeUndefined();
      expect(m.bcc).toBeUndefined();
      for (const other of all.filter((e) => e !== m.to)) {
        expect(String(m.html)).not.toContain(other);
        expect(String(m.text)).not.toContain(other);
      }
      expect(m.text).toBeTruthy();
      expect(m.headers).toHaveProperty('List-Unsubscribe');
    }
    expect(messages(c.id).every((m) => m.status === 'accepted')).toBe(true);
    expect(getDb().prepare('SELECT status FROM campaigns WHERE id = ?').get(c.id)).toEqual({ status: 'completed' });
  });

  it('enforces the per-minute rate limit', async () => {
    updateSettings({ sendRatePerMinute: 2 });
    setupRate();
    const c = makeCampaign(['a@a.com', 'b@b.com', 'c@c.com']);
    launch(c.id);
    await worker.tick();
    await worker.drain();
    await worker.tick();
    await worker.drain();
    expect(smtp.sent).toHaveLength(1); // second tick at the same instant must wait 30 s
    clock.advance(29_000);
    await worker.tick();
    await worker.drain();
    expect(smtp.sent).toHaveLength(1);
    clock.advance(1_000);
    await worker.tick();
    await worker.drain();
    expect(smtp.sent).toHaveLength(2);
    function setupRate() {
      /* settings applied above; env cap in tests is 600/min */
    }
  });

  it('pauses campaigns when the daily provider limit is reached', async () => {
    updateSettings({ sendDailyLimit: 2 });
    const c = makeCampaign(['a@a.com', 'b@b.com', 'c@c.com']);
    launch(c.id);
    await runAll(worker, clock, 10);
    expect(smtp.sent).toHaveLength(2);
    const camp = getDb().prepare('SELECT status, paused_reason FROM campaigns WHERE id = ?').get(c.id) as { status: string; paused_reason: string };
    expect(camp.status).toBe('paused');
    expect(camp.paused_reason).toMatch(/Daily sending limit/);
  });

  it('never sends twice to the same address across campaigns', async () => {
    const c1 = makeCampaign(['dup@a.com']);
    // Second campaign created before the first one sent: both drafts contain the address.
    const contactId = getDb().prepare(`SELECT id FROM contacts WHERE email='dup@a.com'`).pluck().get() as number;
    const c2 = createCampaign({ name: 'c2', templateId: defaultTemplateId(), contactIds: [contactId] });
    launch(c1.id);
    launch(c2.id);
    await runAll(worker, clock);
    expect(smtp.sent.filter((m) => m.to === 'dup@a.com')).toHaveLength(1);
    expect(messages(c2.id)[0]).toMatchObject({ status: 'skipped', error_code: 'DUPLICATE' });
  });

  it('never lets two workers claim the same message', async () => {
    const c = makeCampaign(['a@a.com']);
    launch(c.id);
    const other = new CampaignWorker(clock.now);
    const a = worker.claimNext();
    const b = other.claimNext();
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it('pauses and resumes safely', async () => {
    updateSettings({ sendRatePerMinute: 1 });
    const c = makeCampaign(['a@a.com', 'b@b.com', 'c@c.com']);
    launch(c.id);
    await worker.tick();
    await worker.drain();
    expect(smtp.sent).toHaveLength(1);
    pauseCampaign(c.id);
    clock.advance(120_000);
    await worker.tick();
    await worker.drain();
    expect(smtp.sent).toHaveLength(1);
    expect(messages(c.id).filter((m) => m.status === 'queued')).toHaveLength(2);
    resumeCampaign(c.id);
    await runAll(worker, clock);
    expect(smtp.sent).toHaveLength(3);
  });

  it('marks permanent SMTP failures failed and suppresses rejected recipients', async () => {
    smtp.behaviours.set('bad@a.com', async () => {
      throw Object.assign(new Error('550 5.1.1 User unknown'), { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' });
    });
    const c = makeCampaign(['bad@a.com', 'good@a.com']);
    launch(c.id);
    await runAll(worker, clock);
    const [bad, good] = messages(c.id);
    expect(bad).toMatchObject({ status: 'failed', attempts: 1 });
    expect(good!.status).toBe('accepted');
    expect(getDb().prepare(`SELECT source FROM suppressions WHERE email = 'bad@a.com'`).get()).toEqual({ source: 'bounce' });
    expect(getDb().prepare(`SELECT COUNT(*) n FROM send_ledger WHERE email = 'bad@a.com'`).get()).toEqual({ n: 0 });
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    let calls = 0;
    smtp.behaviours.set('flaky@a.com', async () => {
      if (++calls === 1) throw Object.assign(new Error('421 Try again later'), { responseCode: 421, command: 'MAIL FROM' });
      return { messageId: '<ok@mock>', response: '250 OK' };
    });
    const c = makeCampaign(['flaky@a.com']);
    launch(c.id);
    await worker.tick();
    await worker.drain();
    let [m] = messages(c.id);
    expect(m).toMatchObject({ status: 'queued', attempts: 1 });
    expect(m!.next_attempt_at).toBeTruthy();
    await worker.tick(); // backoff not elapsed
    await worker.drain();
    expect(calls).toBe(1);
    clock.advance(61_000);
    await worker.tick();
    await worker.drain();
    [m] = messages(c.id);
    expect(m).toMatchObject({ status: 'accepted', attempts: 2 });
  });

  it('gives up after the maximum attempts for persistent transient errors', async () => {
    smtp.behaviours.set('busy@a.com', async () => {
      throw Object.assign(new Error('451 busy'), { responseCode: 451, command: 'DATA' });
    });
    const c = makeCampaign(['busy@a.com']);
    launch(c.id);
    await runAll(worker, clock);
    expect(messages(c.id)[0]).toMatchObject({ status: 'failed', attempts: 3 });
    expect(smtp.sent).toHaveLength(3);
  });

  it('parks ambiguous outcomes as unknown and never retries them', async () => {
    smtp.behaviours.set('amb@a.com', async () => {
      throw Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', command: 'DATA' });
    });
    const c = makeCampaign(['amb@a.com']);
    launch(c.id);
    await runAll(worker, clock);
    expect(messages(c.id)[0]).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(smtp.sent).toHaveLength(1);
    expect(getDb().prepare(`SELECT state FROM send_ledger WHERE email = 'amb@a.com'`).get()).toEqual({ state: 'unknown' });
    // Address stays blocked until an operator resolves it.
    const contactId = getDb().prepare(`SELECT id FROM contacts WHERE email='amb@a.com'`).pluck().get() as number;
    const c2 = createCampaign({ name: 'again', templateId: defaultTemplateId(), contactIds: [contactId] });
    expect(messages(c2.id)[0]!.status).toBe('skipped');
  });

  it('pauses on authentication errors without losing the message', async () => {
    smtp.behaviours.set('a@a.com', async () => {
      throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' });
    });
    const c = makeCampaign(['a@a.com']);
    launch(c.id);
    await worker.tick();
    await worker.drain();
    expect(messages(c.id)[0]!.status).toBe('queued');
    expect(getDb().prepare('SELECT status FROM campaigns WHERE id = ?').get(c.id)).toEqual({ status: 'paused' });
  });

  it('recovers after a restart: unsubmitted work is requeued, mid-submission work is unknown', () => {
    const c = makeCampaign(['x@a.com', 'y@a.com']);
    launch(c.id);
    const [m1, m2] = messages(c.id);
    getDb().prepare(`UPDATE campaign_messages SET status = 'processing', attempts = 1 WHERE id = ?`).run(m1!.id);
    getDb().prepare(`UPDATE campaign_messages SET status = 'processing', attempts = 1, submit_started_at = '2026-01-01T00:00:00Z' WHERE id = ?`).run(m2!.id);
    getDb().prepare(`INSERT INTO send_ledger (email, message_id, state) VALUES ('y@a.com', ?, 'reserved')`).run(m2!.id);
    new CampaignWorker(clock.now).recover();
    const [r1, r2] = messages(c.id);
    expect(r1).toMatchObject({ status: 'queued', attempts: 0 });
    expect(r2).toMatchObject({ status: 'unknown', error_code: 'INTERRUPTED' });
  });

  it('classifies SMTP errors', () => {
    expect(classifySmtpError({ responseCode: 550, command: 'RCPT TO' }).kind).toBe('permanent');
    expect(classifySmtpError({ responseCode: 452, command: 'RCPT TO' }).kind).toBe('transient');
    expect(classifySmtpError({ code: 'ECONNECTION', command: 'CONN' }).kind).toBe('transient');
    expect(classifySmtpError({ code: 'ESOCKET', command: 'DATA' }).kind).toBe('ambiguous');
    expect(classifySmtpError({ code: 'ETIMEDOUT' }).kind).toBe('ambiguous');
    expect(classifySmtpError({ code: 'EAUTH', responseCode: 535 }).kind).toBe('config');
  });
});

describe('safety switches', () => {
  it('kill switch stops new submissions immediately and blocks start/resume', async () => {
    updateSettings({ sendRatePerMinute: 1 });
    const c = makeCampaign(['a@a.com', 'b@b.com']);
    launch(c.id);
    await worker.tick();
    await worker.drain();
    expect(smtp.sent).toHaveLength(1);
    updateSettings({ killSwitch: true });
    clock.advance(120_000);
    await runAll(worker, clock, 5);
    expect(smtp.sent).toHaveLength(1);
    expect(messages(c.id)[1]!.status).toBe('queued');
    pauseCampaign(c.id);
    expect(() => resumeCampaign(c.id)).toThrow(/kill switch/);
    const d = makeCampaign(['z@z.com']);
    approveCampaign(d.id, { confirm: true, recipientCount: 1 });
    expect(() => startCampaign(d.id)).toThrow(/kill switch/);
  });

  it('kill switch from .env cannot be released via the API', async () => {
    setupTestEnv({ SENDING_KILL_SWITCH: 'true' });
    const res = await request(createApp()).put('/api/settings').set(H).send({ killSwitch: false });
    expect(res.status).toBe(409);
  });

  it('test mode never touches the real SMTP transport', async () => {
    setupTestEnv({ EMAIL_TEST_MODE: 'true', SMTP_HOST: '', EMAIL_FROM: '', SENDER_NAME: '' });
    let factoryCalls = 0;
    setTransportFactory(() => {
      factoryCalls++;
      throw new Error('real transport must not be created in test mode');
    });
    const c = makeCampaign(['a@a.com', 'b@b.com']);
    launch(c.id);
    await runAll(worker, clock);
    expect(factoryCalls).toBe(0);
    expect(messages(c.id).map((m) => m.status)).toEqual(['simulated', 'simulated']);
    expect(getDb().prepare('SELECT COUNT(*) n FROM send_ledger').get()).toEqual({ n: 0 });
    const res = await request(createApp()).put('/api/settings').set(H).send({ testMode: false });
    expect(res.status).toBe(409);
  });

  it('a campaign created in test mode stays simulated after test mode is turned off', async () => {
    updateSettings({ testMode: true });
    const c = makeCampaign(['a@a.com']);
    updateSettings({ testMode: false });
    launch(c.id);
    await runAll(worker, clock);
    expect(smtp.sent).toHaveLength(0);
    expect(messages(c.id)[0]!.status).toBe('simulated');
  });

  it('suppression added after approval is honoured at send time', async () => {
    const c = makeCampaign(['late@a.com']);
    launch(c.id);
    getDb().prepare(`INSERT INTO suppressions (email, reason, source) VALUES ('late@a.com', 'opted out', 'unsubscribe_link')`).run();
    await runAll(worker, clock);
    expect(smtp.sent).toHaveLength(0);
    expect(messages(c.id)[0]).toMatchObject({ status: 'skipped', error_code: 'SUPPRESSED' });
  });

  it('API requires the CSRF header and rejects foreign Host headers', async () => {
    const app = createApp();
    expect((await request(app).post('/api/suppressions').send({ email: 'a@a.com' })).status).toBe(403);
    expect((await request(app).get('/api/dashboard').set('Host', 'evil.example')).status).toBe(421);
  });

  it('requires ADMIN_TOKEN when configured and never exposes SMTP secrets', async () => {
    setupTestEnv({ ADMIN_TOKEN: 'tok-123' });
    const app = createApp();
    expect((await request(app).get('/api/settings')).status).toBe(401);
    const ok = await request(app).get('/api/settings').set('Authorization', 'Bearer tok-123');
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain('super-secret-password');
    expect(ok.body.smtp.user).not.toBe('user@sender.dev');
  });
});

describe('live progress (SSE)', () => {
  it('streams snapshots until the campaign completes', async () => {
    const c = makeCampaign(['a@a.com', 'b@b.com']);
    launch(c.id);
    const server = http.createServer(createApp()).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const snapshots: { counts: { accepted: number; progress: number }; campaign: { status: string } }[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: `/api/campaigns/${c.id}/events` }, (res) => {
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!data) continue;
            const snap = JSON.parse(data.slice(6));
            snapshots.push(snap);
            if (snap.campaign.status === 'completed') {
              req.destroy();
              resolve();
            }
          }
        });
      });
      req.on('error', (e) => (snapshots.at(-1)?.campaign.status === 'completed' ? resolve() : reject(e)));
    });
    await new Promise((r) => setTimeout(r, 100));
    await runAll(worker, clock);
    await done;
    server.close();
    expect(snapshots[0]!.counts.accepted).toBe(0);
    const last = snapshots.at(-1)!;
    expect(last.counts.accepted).toBe(2);
    expect(last.counts.progress).toBe(100);
  });

  it('unsubscribe link suppresses the recipient', async () => {
    setupTestEnv({ PUBLIC_BASE_URL: 'https://apply.example' });
    installMockSmtp();
    const c = makeCampaign(['u@a.com']);
    const token = getDb().prepare('SELECT unsubscribe_token FROM campaign_messages WHERE campaign_id = ?').pluck().get(c.id) as string;
    const html = getDb().prepare('SELECT html FROM campaign_messages WHERE campaign_id = ?').pluck().get(c.id) as string;
    expect(html).toContain(`https://apply.example/unsubscribe/${token}`);
    const app = createApp();
    expect((await request(app).get(`/unsubscribe/${token}`)).text).toMatch(/Stop receiving/);
    await request(app).post(`/unsubscribe/${token}`);
    expect(getDb().prepare(`SELECT source FROM suppressions WHERE email = 'u@a.com'`).get()).toEqual({ source: 'unsubscribe_link' });
  });
});
