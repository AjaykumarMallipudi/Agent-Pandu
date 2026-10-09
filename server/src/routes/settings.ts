import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { HttpError, hasResume, resumePath } from '../campaigns/service.js';
import { config, isLoopbackHost } from '../config.js';
import { logEvent } from '../db/index.js';
import { allProviders, getProvider } from '../discovery/runner.js';
import { realTransport, smtpStatus } from '../email/transport.js';
import { parse } from '../http/middleware.js';
import { getSettings, settingsSchema, updateSettings } from '../settings.js';

export const settingsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

function view() {
  const c = config();
  const s = getSettings();
  return {
    runtime: s,
    smtp: smtpStatus(), // masked; never includes the password
    discovery: { active: getProvider().status(), providers: allProviders().map((p) => p.status()) },
    crawl: {
      userAgent: c.CRAWL_USER_AGENT,
      timeoutMs: c.CRAWL_TIMEOUT_MS,
      maxBytes: c.CRAWL_MAX_BYTES,
      maxRedirects: c.CRAWL_MAX_REDIRECTS,
      hostDelayMs: c.CRAWL_HOST_DELAY_MS,
      concurrency: c.CRAWL_CONCURRENCY,
      checkMx: c.CRAWL_CHECK_MX,
    },
    limits: { envRatePerMinute: c.SEND_RATE_PER_MINUTE, envDailyLimit: c.SEND_DAILY_LIMIT, envConcurrency: c.SEND_CONCURRENCY },
    resume: hasResume() ? { uploaded: true, size: fs.statSync(resumePath()).size, updatedAt: fs.statSync(resumePath()).mtime.toISOString() } : { uploaded: false },
    security: { host: c.HOST, loopbackOnly: isLoopbackHost(c.HOST), adminTokenSet: Boolean(c.ADMIN_TOKEN) },
    publicBaseUrl: c.PUBLIC_BASE_URL || null,
    sender: { name: c.SENDER_NAME, phone: c.SENDER_PHONE, linkedin: c.SENDER_LINKEDIN, github: c.SENDER_GITHUB, portfolio: c.SENDER_PORTFOLIO },
  };
}

settingsRouter.get('/settings', (_req, res) => {
  res.json(view());
});

settingsRouter.put('/settings', (req, res) => {
  const patch = parse(settingsSchema.partial(), req.body);
  const c = config();
  if (patch.testMode === false && c.EMAIL_TEST_MODE) throw new HttpError(409, 'Test mode is locked on by EMAIL_TEST_MODE=true in .env');
  if (patch.killSwitch === false && c.SENDING_KILL_SWITCH) throw new HttpError(409, 'Kill switch is locked on by SENDING_KILL_SWITCH=true in .env');
  updateSettings(patch);
  logEvent('settings.updated', 'Settings updated', undefined, patch);
  res.json(view());
});

/** SMTP diagnostics: opens a connection and authenticates without sending anything. */
settingsRouter.post('/settings/smtp/verify', async (_req, res) => {
  const s = smtpStatus();
  if (!s.configured) {
    res.json({ ok: false, error: `Missing configuration: ${s.missing.join(', ')}` });
    return;
  }
  const started = Date.now();
  try {
    await realTransport().verify();
    res.json({ ok: true, ms: Date.now() - started, host: s.host, port: s.port, secure: s.secure });
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; message: string };
    res.json({ ok: false, code: err.code ?? null, responseCode: err.responseCode ?? null, error: err.message, ms: Date.now() - started });
  }
});

settingsRouter.post('/settings/resume', upload.single('resume'), (req, res) => {
  const f = req.file;
  if (!f) throw new HttpError(400, 'Upload a PDF in the "resume" field');
  if (f.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'File is not a PDF');
  fs.mkdirSync(path.dirname(resumePath()), { recursive: true });
  fs.writeFileSync(resumePath(), f.buffer);
  logEvent('resume.uploaded', `Resume uploaded (${f.size} bytes)`);
  res.json(view());
});

settingsRouter.delete('/settings/resume', (_req, res) => {
  if (hasResume()) fs.unlinkSync(resumePath());
  res.json(view());
});
