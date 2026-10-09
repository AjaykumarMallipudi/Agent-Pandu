import { config } from '../config.js';
import { initDb, closeDb } from './index.js';
import { ensureDefaultTemplate } from '../email/templates.js';

const cfg = config();
initDb(cfg.databasePath);
ensureDefaultTemplate();
closeDb();
console.log(`Database ready at ${cfg.databasePath}`);
