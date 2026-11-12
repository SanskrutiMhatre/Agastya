'use strict';
/*
  The backup command (decisions.md K11), for the server machine:

    npm run backup -- list
    npm run backup -- create [--note "text"]
    npm run backup -- verify <backup id>
    npm run backup -- restore <backup id> --confirm <backup id>

  list and verify can run at any time. create and restore need the server to
  be stopped, because only the server can pause its own writes; this command
  refuses while a server is using the data folder (its server.pid names a
  live process). It uses the same code as the administrator's Backups screen,
  reads AGASTYA_DATA_DIR, AGASTYA_BACKUP_DIR and AGASTYA_BACKUP_KEY like the
  server (.env included), and records what it does in the audit log as "cli".
  A restore made here also takes a recovery point first and ends every
  session.
*/

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/db/store');
const { createAudit } = require('../server/audit');
const { createBackupService } = require('../server/backup/service');
const { recoverInterruptedRestore } = require('../server/backup/recovery');

const dataDir = path.resolve(process.env.AGASTYA_DATA_DIR || path.join(__dirname, '..', 'data'));
const backupDir = process.env.AGASTYA_BACKUP_DIR || `${dataDir}-backups`;
const CLI = { id: null, username: 'cli' };
const say = (s) => process.stdout.write(`${s}\n`);
const fail = (s) => { process.stderr.write(`${s}\n`); process.exitCode = 1; };

function serverRunning() {
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir, 'server.pid'), 'utf8'));
    if (!Number.isInteger(pid) || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) { return e.code === 'EPERM'; }
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function main() {
  // Flags are read wherever they are: create has no backup id before them.
  const [cmd, ...args] = process.argv.slice(2);
  const id = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const flag = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
  if (!['list', 'create', 'verify', 'restore'].includes(cmd)) {
    say('Usage: npm run backup -- list | create [--note "text"] | verify <id> | restore <id> --confirm <id>');
    process.exitCode = cmd ? 1 : 0;
    return;
  }
  if ((cmd === 'create' || cmd === 'restore') && serverRunning()) return fail('The Agastya server is running on this data folder. Stop it first, or use the Backups screen.');
  if (!fs.existsSync(path.join(dataDir, 'agastya.db')) && cmd !== 'list' && cmd !== 'verify') return fail(`No Agastya database in ${dataDir}.`);
  if (cmd === 'create' || cmd === 'restore') recoverInterruptedRestore(dataDir, { log: say });
  const store = new Store(path.join(dataDir, 'agastya.db'));
  store.migrate(new Date().toISOString());
  const audit = createAudit({ store, log: { error: () => {} } });
  const svc = createBackupService({ store, dataDir, backupDir, env: process.env, audit, log: { log: () => {}, error: () => {} } });
  try {
    if (svc.configProblem()) return fail(svc.configProblem());
    if (cmd === 'list') {
      const all = svc.list();
      if (!all.length) say(`No backups in ${path.resolve(backupDir)}.`);
      for (const b of all) say(`${b.id}  ${(b.kind || '?').padEnd(11)}  ${b.status.padEnd(7)}  ${b.size != null ? mb(b.size).padStart(9) : '        ?'}  ${b.encrypted ? 'encrypted' : 'plain    '}  ${b.createdAt || ''}${b.note ? `  ${b.note}` : ''}`);
      return;
    }
    if (cmd === 'create') {
      const b = await svc.create({ kind: 'manual', actor: CLI, note: flag('note') || 'created with the backup command' });
      say(`Created ${b.id}: ${b.files} files, ${mb(b.size)}${b.encrypted ? ', encrypted' : ''}. Verified.`);
      return;
    }
    if (!id) return fail('Name the backup id.');
    if (cmd === 'verify') {
      const r = await svc.verify(id, { actor: CLI });
      if (r.ok) say(`${id}: OK. Every file matches its checksum and the database passes its integrity check.`);
      else { fail(`${id}: FAILED`); for (const p of r.problems) fail(`  - ${p}`); }
      return;
    }
    if (flag('confirm') !== id) return fail('A restore replaces all data. Repeat the backup id after --confirm to go ahead.');
    const r = await svc.restore(id, { actor: CLI, reason: flag('reason') || 'restored with the backup command' });
    say(`Restored ${id}. Recovery point of the previous data: ${r.recoveryPoint.id}. ${r.sessionsEnded} session(s) ended; ${r.carriedAuditRows} audit record(s) carried over.`);
  } catch (e) {
    fail(e.message || String(e));
    if (e.problems) for (const p of e.problems.slice(0, 20)) fail(`  - ${p}`);
  } finally {
    try { store.close(); } catch { /* closed */ }
  }
}

main();
