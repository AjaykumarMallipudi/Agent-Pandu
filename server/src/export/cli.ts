import { config } from '../config.js';
import { closeDb, initDb } from '../db/index.js';
import { ensureDefaultTemplate } from '../email/templates.js';
import { reclassifyIfOutdated } from '../contacts/repo.js';
import { exportSnapshot, importSnapshot, snapshotDir, snapshotExists } from './snapshot.js';

// Usage: tsx src/export/cli.ts export|import
const cmd = process.argv[2];
const cfg = config();
initDb(cfg.databasePath);
try {
  if (cmd === 'export') {
    reclassifyIfOutdated();
    ensureDefaultTemplate();
    const r = exportSnapshot();
    console.log(`Saved ${r.companies} companies, ${r.contacts} contacts, ${r.suppressions} opt-outs, ${r.contacted} contacted, ${r.templates} templates to ${r.dir}`);
  } else if (cmd === 'import') {
    if (!snapshotExists()) {
      console.error(`No snapshot in ${snapshotDir()}`);
      process.exitCode = 1;
    } else {
      const r = importSnapshot();
      ensureDefaultTemplate();
      console.log(
        `Snapshot has ${r.companies} companies / ${r.contacts} contacts. Added: ${r.added.companies} companies, ${r.added.contacts} contacts, ` +
          `${r.added.suppressions} opt-outs, ${r.added.contacted} contacted, ${r.added.templates} templates.`,
      );
    }
  } else {
    console.error('Usage: npm run data:export | npm run data:import');
    process.exitCode = 1;
  }
} finally {
  closeDb();
}
