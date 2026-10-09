import crypto from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { publishCampaign } from '../campaigns/service.js';
import { config } from '../config.js';
import { getDb, logEvent, nowIso } from '../db/index.js';
import { parse } from '../http/middleware.js';

/** Unauthenticated endpoints: recipient opt-out and provider delivery webhooks. */
export const publicRouter = Router();

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;background:#f3f4f6;margin:0;padding:48px 16px;"><div style="max-width:480px;margin:auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">${body}</div></body></html>`;

function messageByToken(token: string) {
  return getDb().prepare('SELECT id, campaign_id, email FROM campaign_messages WHERE unsubscribe_token = ?').get(token) as
    | { id: number; campaign_id: number; email: string }
    | undefined;
}

publicRouter.get('/unsubscribe/:token', (req, res) => {
  const m = messageByToken(req.params.token);
  if (!m) {
    res.status(404).send(page('Not found', '<h1 style="font-size:20px">Link not recognised</h1><p>Reply "unsubscribe" to the email instead and you will be removed.</p>'));
    return;
  }
  // Confirmation step avoids link scanners unsubscribing people; RFC 8058 one-click clients POST directly.
  res.send(
    page(
      'Unsubscribe',
      `<h1 style="font-size:20px;margin-top:0">Stop receiving messages?</h1><p>Confirm to stop all further messages to this address.</p>
       <form method="post"><button style="background:#111827;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer">Unsubscribe</button></form>`,
    ),
  );
});

publicRouter.post('/unsubscribe/:token', express.urlencoded({ extended: false }), (req, res) => {
  const m = messageByToken(req.params.token);
  if (m) {
    getDb().prepare(`INSERT OR IGNORE INTO suppressions (email, reason, source) VALUES (?, 'Recipient opted out via link', 'unsubscribe_link')`).run(m.email);
    logEvent('suppression.unsubscribe', 'Recipient opted out via unsubscribe link', { type: 'campaign_message', id: m.id });
    publishCampaign(m.campaign_id);
  }
  res.send(page('Unsubscribed', '<h1 style="font-size:20px;margin-top:0">You have been unsubscribed</h1><p>You will not receive further messages.</p>'));
});

/**
 * Delivery evidence from an email provider (or a relay you control). SMTP acceptance is not delivery;
 * a message only becomes "delivered" when evidence arrives here. Requires WEBHOOK_SECRET.
 */
publicRouter.post('/api/webhooks/delivery', express.json({ limit: '100kb' }), (req, res) => {
  const secret = config().WEBHOOK_SECRET;
  const given = String(req.headers['x-webhook-secret'] ?? '');
  if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const b = parse(
    z.object({ idempotencyKey: z.string().max(200), event: z.enum(['delivered', 'bounced', 'complained']), detail: z.string().max(500).optional() }),
    req.body,
  );
  const db = getDb();
  const m = db.prepare('SELECT id, campaign_id, email, status FROM campaign_messages WHERE idempotency_key = ?').get(b.idempotencyKey) as
    | { id: number; campaign_id: number; email: string; status: string }
    | undefined;
  if (!m) {
    res.status(404).json({ error: 'Unknown message' });
    return;
  }
  if (!['accepted', 'delivered', 'unknown'].includes(m.status)) {
    res.status(409).json({ error: `Message status is ${m.status}` });
    return;
  }
  if (b.event === 'delivered') {
    db.prepare(`UPDATE campaign_messages SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), m.id);
    db.prepare(`UPDATE send_ledger SET state = 'accepted' WHERE message_id = ?`).run(m.id);
  } else {
    if (b.event === 'bounced') {
      db.prepare(`UPDATE campaign_messages SET status = 'bounced', error_message = ?, updated_at = ? WHERE id = ?`).run(b.detail ?? 'Bounced', nowIso(), m.id);
    }
    db.prepare(`INSERT OR IGNORE INTO suppressions (email, reason, source) VALUES (?, ?, ?)`).run(
      m.email,
      b.detail ?? b.event,
      b.event === 'bounced' ? 'bounce' : 'complaint',
    );
  }
  logEvent(`delivery.${b.event}`, `${b.event} for message ${m.id}`, { type: 'campaign_message', id: m.id });
  publishCampaign(m.campaign_id);
  res.json({ ok: true });
});
