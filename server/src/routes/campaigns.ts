import { Router } from 'express';
import { z } from 'zod';
import {
  approveCampaign,
  campaignCounts,
  campaignSnapshot,
  cancelCampaign,
  createCampaign,
  getCampaign,
  HttpError,
  pauseCampaign,
  resolveUnknown,
  resumeCampaign,
  setExcluded,
  startCampaign,
  type CampaignRow,
} from '../campaigns/service.js';
import { worker } from '../campaigns/worker.js';
import { getDb } from '../db/index.js';
import { bus, channels } from '../events.js';
import { idParam, parse, sse } from '../http/middleware.js';

export const campaignsRouter = Router();

campaignsRouter.get('/campaigns', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM campaigns ORDER BY id DESC').all() as CampaignRow[];
  res.json(rows.map((c) => ({ ...c, counts: campaignCounts(c.id) })));
});

campaignsRouter.post('/campaigns', (req, res) => {
  const b = parse(
    z.object({
      name: z.string().trim().min(1).max(120),
      templateId: z.number().int().positive(),
      position: z.string().trim().max(120).optional(),
      attachResume: z.boolean().optional(),
      contactIds: z.array(z.number().int().positive()).min(1).max(100),
    }),
    req.body,
  );
  const c = createCampaign(b);
  res.status(201).json(campaignSnapshot(c.id));
});

campaignsRouter.get('/campaigns/:id', (req, res) => {
  res.json(campaignSnapshot(parse(idParam, req.params.id)));
});

/** Full personalized preview of one message (subject, HTML, plain text). */
campaignsRouter.get('/campaigns/:id/messages/:mid', (req, res) => {
  const id = parse(idParam, req.params.id);
  const mid = parse(idParam, req.params.mid);
  const m = getDb()
    .prepare('SELECT id, email, recipient_name, company_name, contact_type, subject, html, text, status, error_message FROM campaign_messages WHERE id = ? AND campaign_id = ?')
    .get(mid, id);
  if (!m) throw new HttpError(404, 'Message not found');
  res.json(m);
});

campaignsRouter.patch('/campaigns/:id/messages/:mid', (req, res) => {
  const b = parse(z.object({ excluded: z.boolean() }), req.body);
  setExcluded(parse(idParam, req.params.id), parse(idParam, req.params.mid), b.excluded);
  res.json(campaignSnapshot(parse(idParam, req.params.id)));
});

campaignsRouter.post('/campaigns/:id/messages/:mid/resolve', (req, res) => {
  const b = parse(z.object({ outcome: z.enum(['accepted', 'failed']) }), req.body);
  resolveUnknown(parse(idParam, req.params.id), parse(idParam, req.params.mid), b.outcome);
  res.json(campaignSnapshot(parse(idParam, req.params.id)));
});

campaignsRouter.post('/campaigns/:id/approve', (req, res) => {
  const b = parse(z.object({ confirm: z.boolean(), recipientCount: z.number().int().min(0) }), req.body);
  approveCampaign(parse(idParam, req.params.id), b);
  res.json(campaignSnapshot(parse(idParam, req.params.id)));
});

campaignsRouter.post('/campaigns/:id/start', (req, res) => {
  const id = parse(idParam, req.params.id);
  startCampaign(id);
  void worker?.tick();
  res.json(campaignSnapshot(id));
});

campaignsRouter.post('/campaigns/:id/pause', (req, res) => {
  const id = parse(idParam, req.params.id);
  pauseCampaign(id);
  res.json(campaignSnapshot(id));
});

campaignsRouter.post('/campaigns/:id/resume', (req, res) => {
  const id = parse(idParam, req.params.id);
  resumeCampaign(id);
  void worker?.tick();
  res.json(campaignSnapshot(id));
});

campaignsRouter.post('/campaigns/:id/cancel', (req, res) => {
  const id = parse(idParam, req.params.id);
  cancelCampaign(id);
  res.json(campaignSnapshot(id));
});

campaignsRouter.get('/campaigns/:id/events', (req, res) => {
  const id = parse(idParam, req.params.id);
  getCampaign(id);
  sse(
    req,
    res,
    (cb) => {
      bus.on(channels.campaign(id), cb);
      return () => bus.off(channels.campaign(id), cb);
    },
    () => campaignSnapshot(id),
  );
});
