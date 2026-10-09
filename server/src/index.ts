import { createApp } from './app.js';
import { startWorker } from './campaigns/worker.js';
import { config, isLoopbackHost } from './config.js';
import { closeDb, initDb } from './db/index.js';
import { recoverInterruptedRuns } from './discovery/runner.js';
import { ensureDefaultTemplate } from './email/templates.js';
import { logger } from './logger.js';
import { getSettings } from './settings.js';

const cfg = config();

if (!isLoopbackHost(cfg.HOST) && !cfg.ADMIN_TOKEN) {
  logger.fatal(`Refusing to bind to ${cfg.HOST} without ADMIN_TOKEN. Set ADMIN_TOKEN (and ALLOWED_HOSTS) before exposing the server beyond localhost.`);
  process.exit(1);
}

initDb(cfg.databasePath);
ensureDefaultTemplate();
recoverInterruptedRuns();
const worker = startWorker();

const app = createApp();
const server = app.listen(cfg.PORT, cfg.HOST, () => {
  const s = getSettings();
  logger.info(`Smart Applytick API listening on http://${cfg.HOST}:${cfg.PORT}`);
  logger.info(`Database: ${cfg.databasePath}`);
  logger.info(`Test mode: ${s.testMode ? 'ON (campaign messages are simulated, nothing is transmitted)' : 'OFF (live sending)'}; kill switch: ${s.killSwitch ? 'ON' : 'off'}`);
});

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close();
  await worker.stop();
  closeDb();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
