import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ROOT_DIR } from './config.js';
import { adminAuth, csrfGuard, errorHandler, hostGuard } from './http/middleware.js';
import { campaignsRouter } from './routes/campaigns.js';
import { dataRouter } from './routes/data.js';
import { discoveryRouter } from './routes/discovery.js';
import { publicRouter } from './routes/public.js';
import { settingsRouter } from './routes/settings.js';
import { templatesRouter } from './routes/templates.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(hostGuard);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  app.use(publicRouter);

  const api = express.Router();
  api.use(adminAuth, csrfGuard, express.json({ limit: '1mb' }));
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use(dataRouter, discoveryRouter, templatesRouter, campaignsRouter, settingsRouter);
  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use('/api', api);

  // Serve the built frontend (production). In development Vite serves it and proxies /api.
  const webDist = path.join(ROOT_DIR, 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
