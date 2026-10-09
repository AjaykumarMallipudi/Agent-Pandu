import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../campaigns/service.js';
import { getDb } from '../db/index.js';
import { allProviders, cancelDiscovery, getProvider, getRun, startDiscovery } from '../discovery/runner.js';
import { criteriaSchema } from '../discovery/types.js';
import { bus, channels } from '../events.js';
import { idParam, parse, sse } from '../http/middleware.js';
import { config } from '../config.js';

export const discoveryRouter = Router();

function present(run: ReturnType<typeof getRun>) {
  if (!run) return null;
  return { ...run, criteria: JSON.parse(run.criteria_json), errors: JSON.parse(run.errors_json) as string[] };
}

discoveryRouter.get('/discovery/providers', (_req, res) => {
  res.json({ active: config().DISCOVERY_PROVIDER, providers: allProviders().map((p) => p.status()), current: getProvider().status() });
});

discoveryRouter.get('/discovery/runs', (_req, res) => {
  const runs = getDb().prepare('SELECT * FROM discovery_runs ORDER BY id DESC LIMIT 50').all() as NonNullable<ReturnType<typeof getRun>>[];
  res.json(runs.map(present));
});

discoveryRouter.post('/discovery/runs', (req, res) => {
  const body = parse(z.object({ criteria: criteriaSchema, provider: z.enum(['google_places', 'osm']).optional() }), req.body);
  const id = startDiscovery(body.criteria, body.provider);
  res.status(202).json(present(getRun(id)));
});

discoveryRouter.get('/discovery/runs/:id', (req, res) => {
  const run = getRun(parse(idParam, req.params.id));
  if (!run) throw new HttpError(404, 'Run not found');
  res.json(present(run));
});

discoveryRouter.post('/discovery/runs/:id/cancel', (req, res) => {
  const id = parse(idParam, req.params.id);
  if (!cancelDiscovery(id)) throw new HttpError(409, 'Run is not active');
  res.json(present(getRun(id)));
});

discoveryRouter.get('/discovery/runs/:id/events', (req, res) => {
  const id = parse(idParam, req.params.id);
  if (!getRun(id)) throw new HttpError(404, 'Run not found');
  sse(
    req,
    res,
    (cb) => {
      bus.on(channels.discovery(id), cb);
      return () => bus.off(channels.discovery(id), cb);
    },
    () => present(getRun(id)),
  );
});
