'use strict';
/*
  Backup and restore (Phase 5, decisions.md K1-K12).

  One logical recovery unit: the database (accounts, sessions, audit log,
  projects, documents, immutable revisions and their content, requests,
  drafts, notifications), the project workspaces on disk (data modules,
  publication module, project.json, front matter, graphics, soft-deleted
  modules) and the frozen submission snapshots. Build outputs, the preview
  cache and temporary files are left out (the next build makes them again);
  .env, vendor/ and the client build are not data and are never included.

  Backup
    1. space check; a unique id; a temporary folder <backupDir>/.tmp-<id>
    2. the maintenance gate holds off writes and lets in-flight ones finish
    3. VACUUM INTO (a consistent database copy) and every file copied, each
       hashed (and encrypted with AES-256-GCM when AGASTYA_BACKUP_KEY is set)
    4. writes resume; manifest.json and its seal written
    5. every stored file re-read and checked against the manifest
    6. the folder renamed to <backupDir>/<id>: only now does the backup exist
    Any failure removes the temporary folder; an interrupted run leaves only a
    .tmp- folder, which is never listed and is removed at the next start.

  Restore
    1. the backup verified in full (seal, every hash, no unlisted or unsafe
       file, the database's own integrity check, a known schema)
    2. staged beside the data (decrypted, re-hashed), the staged database
       checked and migrated forward
    3. a recovery point (a pre-restore backup of the current state) taken and
       verified; without it, nothing is replaced
    4. the gate holds off every request and waits for PDF builds to finish
    5. audit rows written since the backup are carried into the staged
       database, so the audit trail stays continuous
    6. swap under a journal: current data moved aside, staged data moved in,
       database reopened and migrated
    7. the restored state verified (integrity, counts, every file's hash);
       on any failure the original data is moved back
    8. every session is ended; the outcome is audited
    A crash during the swap is undone at the next start from the journal
    (recovery.js), before the database is opened.

  Only one backup or restore runs at a time, in this process (op) and across
  processes (the lock file), so the command-line tool cannot race the server.
*/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const F = require('./format');
const { MIGRATIONS } = require('../db/migrations');
const { JOURNAL, ITEMS, renameRetry } = require('./recovery');

const VERSION = (() => { try { return require('../../package.json').version; } catch { return 'unknown'; } })();
const SCHEDULE_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_KEEP = 14;
const KEEP_PRE_RESTORE = 3;
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;

class BackupError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// A filesystem error as a code and a message with no path in it.
function fsError(e, what) {
  if (e instanceof BackupError) return e;
  const code = e && e.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return new BackupError(507, 'INSUFFICIENT_STORAGE', `There is not enough disk space to ${what}.`);
  if (code === 'EBUSY') return new BackupError(503, 'FILE_BUSY', `A file was held by another program (an antivirus scanner or indexer, for example) while trying to ${what}. Nothing was replaced; try again, and consider excluding the data and backup folders from real-time scanning.`);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new BackupError(500, 'PERMISSION_DENIED', `Agastya is not allowed to write where it needs to ${what}. Check the folder permissions.`);
  if (code === 'DECRYPT_FAILED' || code === 'CORRUPT') return new BackupError(409, 'BACKUP_INVALID', 'A file in the backup failed its check (damaged, or the backup key is wrong).');
  return new BackupError(500, 'BACKUP_IO_ERROR', `A file operation failed while trying to ${what}.`);
}

// Remove a tree, making read-only files writable first (snapshots are 0444; Windows refuses otherwise).
function removeTree(target) {
  if (!fs.existsSync(target)) return;
  try { fs.rmSync(target, { recursive: true, force: true }); return; } catch { /* retry after chmod */ }
  (function unlock(p) {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    try { fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600); } catch { /* best effort */ }
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) unlock(path.join(p, e));
  })(target);
  fs.rmSync(target, { recursive: true, force: true });
}

function makeReadOnly(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) makeReadOnly(p); else { try { fs.chmodSync(p, 0o444); } catch { /* best effort */ } }
  }
}

// bk-20261028-143005-xxxxxx -> 2026-10-28T14:30:05 (for folders whose manifest cannot be read).
const isoFromId = (id) => id.replace(/^bk-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-.*$/, '$1-$2-$3T$4:$5:$6.000Z');

function writeAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

/*
  Whether two folders are the same or one lies inside the other. Windows paths
  are compared without regard to case, as NTFS treats them: D:\Agastya\data
  and d:\agastya\DATA\backups overlap.
*/
function foldersOverlap(a, b, p = path) {
  const norm = (x) => { const r = p.resolve(x); return p === path.win32 ? r.toLowerCase() : r; };
  const x = norm(a); const y = norm(b);
  return x === y || x.startsWith(y.endsWith(p.sep) ? y : y + p.sep) || y.startsWith(x.endsWith(p.sep) ? x : x + p.sep);
}

function createBackupService({
  store, dataDir, backupDir, env = {}, now = () => new Date(), log = console, audit = () => {}, maintenance = null,
  activeBuilds = () => [], onRestored = () => {}, hooks = {}, freeSpace = null,
}) {
  const nowIso = () => now().toISOString();
  const keyInfo = F.parseKey(env.AGASTYA_BACKUP_KEY);
  const key = keyInfo.key || null;
  const schedule = SCHEDULE_RE.test(String(env.AGASTYA_BACKUP_SCHEDULE || '')) ? env.AGASTYA_BACKUP_SCHEDULE : null;
  const scheduleProblem = env.AGASTYA_BACKUP_SCHEDULE && !schedule && env.AGASTYA_BACKUP_SCHEDULE !== 'off'
    ? 'AGASTYA_BACKUP_SCHEDULE must be a time of day as HH:MM (24-hour, server time), or "off".' : null;
  const keepRaw = Number(env.AGASTYA_BACKUP_KEEP);
  const keep = Number.isInteger(keepRaw) && keepRaw >= 1 && keepRaw <= 1000 ? keepRaw : DEFAULT_KEEP;
  const root = path.resolve(backupDir);
  const dataRoot = path.resolve(dataDir);
  const configProblem = keyInfo.error || scheduleProblem
    || (foldersOverlap(root, dataRoot) ? 'The backup folder must not be inside the data folder, or contain it.' : null);
  const verified = new Map(); // id -> { at, ok }
  let op = null;
  let lastScheduledFailure = 0;
  let timer = null;

  const spaceOf = freeSpace || ((dir) => { try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; } });
  const finalDir = (id) => path.join(root, id);
  const lockFile = path.join(root, '.lock');
  const dbFile = store.file;

  function ensureRoot() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(root, 0o700); } catch { /* best effort (Windows) */ }
  }

  // ---- one operation at a time, in-process and across processes -----------------

  function begin(kind) {
    if (configProblem) throw new BackupError(500, 'BACKUP_NOT_CONFIGURED', configProblem);
    if (op) throw new BackupError(409, 'OPERATION_IN_PROGRESS', `A ${op.kind} is already in progress.`);
    ensureRoot();
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, kind, at: nowIso() }), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw fsError(e, 'start the operation');
      let other = null;
      try { other = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { other = null; }
      const alive = other && Number.isInteger(other.pid) && (() => { try { process.kill(other.pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } })();
      if (alive && other.pid !== process.pid) throw new BackupError(409, 'OPERATION_IN_PROGRESS', 'Another process (the command-line tool or a second server) is running a backup or restore.');
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, kind, at: nowIso() }), { mode: 0o600 }); // a stale lock from a crashed run
    }
    op = { kind, startedAt: nowIso() };
  }
  function end() {
    op = null;
    try { fs.unlinkSync(lockFile); } catch { /* gone */ }
  }

  // ---- what goes into a backup ------------------------------------------------------

  /*
    Every file of the workspaces and snapshots, as { abs, rel }. Symbolic
    links and anything that is not a regular file are skipped and counted:
    a workspace never contains them, and following one could read outside
    the data folder.
  */
  function walkData() {
    const out = [];
    let skipped = 0;
    const walk = (absDir, relDir, top) => {
      let entries;
      try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (top && F.EXCLUDED_TOP.test(e.name)) continue;
        if (F.isTempFile(e.name)) continue;
        const abs = path.join(absDir, e.name);
        const rel = `${relDir}/${e.name}`;
        let st;
        try { st = fs.lstatSync(abs); } catch { continue; }
        if (st.isSymbolicLink()) { skipped++; continue; }
        if (st.isDirectory()) walk(abs, rel, false);
        else if (st.isFile()) {
          if (!F.safeBackupPath(rel)) { skipped++; continue; }
          out.push({ abs, rel, size: st.size });
        } else skipped++;
      }
    };
    for (const kind of ['projects', 'snapshots']) {
      const base = path.join(dataRoot, kind);
      let ids = [];
      try { ids = fs.readdirSync(base, { withFileTypes: true }); } catch { ids = []; }
      for (const d of ids) {
        const ok = kind === 'projects' ? /^prj-[0-9a-f]{10}$/.test(d.name) : /^[0-9a-f-]{36}$/.test(d.name);
        if (!ok || !d.isDirectory()) { skipped++; continue; }
        walk(path.join(base, d.name), `${kind}/${d.name}`, kind === 'projects');
      }
    }
    return { files: out, skipped };
  }

  const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

  // ---- reading and checking a backup -----------------------------------------------

  function readManifest(dir, id) {
    const mf = path.join(dir, F.MANIFEST);
    const sf = path.join(dir, F.SEAL);
    for (const f of [mf, sf]) {
      let st;
      try { st = fs.lstatSync(f); } catch { throw new BackupError(409, 'BACKUP_INVALID', 'The backup is incomplete: its manifest is missing.'); }
      if (!st.isFile() || st.size > F.MAX_MANIFEST_BYTES) throw new BackupError(409, 'BACKUP_INVALID', 'The backup manifest is not a regular file of a sensible size.');
    }
    const bytes = fs.readFileSync(mf);
    const seal = fs.readFileSync(sf, 'utf8').trim();
    const keyed = seal.startsWith('hmac-sha256:');
    if (keyed && !key) throw new BackupError(409, 'BACKUP_KEY_REQUIRED', 'This backup is encrypted. Set AGASTYA_BACKUP_KEY to the key it was made with.');
    const expected = F.sealOf(bytes, keyed ? key : null);
    if (seal.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(seal), Buffer.from(expected))) {
      throw new BackupError(409, keyed ? 'BACKUP_KEY_MISMATCH' : 'BACKUP_INVALID', keyed ? 'The backup was sealed with a different key, or its manifest was changed.' : 'The backup manifest was changed or damaged.');
    }
    let m;
    try { m = JSON.parse(bytes.toString('utf8')); } catch { throw new BackupError(409, 'BACKUP_INVALID', 'The backup manifest is not valid JSON.'); }
    const problems = F.checkManifest(m, id);
    if (!problems.length && !!m.encryption !== keyed) problems.push('the seal does not match the encryption setting');
    if (!problems.length && m.encryption && m.encryption.keyId !== keyInfo.keyId) problems.push('the backup was made with a different key');
    if (problems.length) throw new BackupError(409, 'BACKUP_INVALID', `The backup manifest is not acceptable: ${problems.slice(0, 3).join('; ')}.`, { problems });
    return m;
  }

  const known = new Set(MIGRATIONS.map((x) => x.name));
  const incompatible = (m) => m.schema.migrations.filter((x) => !known.has(x));

  // Locate a backup folder by id: validated id, a real directory inside the backup folder.
  function backupDirFor(id) {
    if (!F.ID_RE.test(String(id))) throw new BackupError(404, 'NOT_FOUND', 'Not found.');
    const dir = finalDir(id);
    let st;
    try { st = fs.lstatSync(dir); } catch { throw new BackupError(404, 'NOT_FOUND', 'Not found.'); }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new BackupError(404, 'NOT_FOUND', 'Not found.');
    return dir;
  }

  /*
    Full verification: the manifest and its seal, every listed file (a regular
    file of the listed size and hash, inside the folder), nothing unlisted,
    a schema this version knows, and with `deep` the database opened and
    checked. Returns { ok, problems, manifest }.
  */
  async function verifyDir(dir, id, { deep = true } = {}) {
    const problems = [];
    let m;
    try { m = readManifest(dir, id); } catch (e) { return { ok: false, code: e.code, problems: [e.message], manifest: null }; }
    const unknown = incompatible(m);
    if (unknown.length) problems.push(`made by a newer version of Agastya (unknown schema steps: ${unknown.slice(0, 3).join(', ')})`);
    const listed = new Set(m.files.map((f) => f.path));
    // Nothing unlisted, no links, nothing odd.
    (function scan(abs, rel) {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        const p = path.join(abs, e.name);
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) problems.push(`a link is not allowed in a backup (${r})`);
        else if (st.isDirectory()) scan(p, r);
        else if (!st.isFile()) problems.push(`not a regular file: ${r}`);
        else if (!listed.has(r) && r !== F.MANIFEST && r !== F.SEAL) problems.push(`a file not in the manifest: ${r.slice(0, 120)}`);
      }
    })(dir, '');
    for (const f of m.files) {
      const abs = F.resolveInside(dir, f.path);
      if (!abs) { problems.push(`unsafe path ${f.path}`); continue; }
      let st;
      try { st = fs.lstatSync(abs); } catch { problems.push(`missing: ${f.path}`); continue; }
      if (!st.isFile()) { problems.push(`not a regular file: ${f.path}`); continue; }
      if (st.size !== f.size) { problems.push(`wrong size: ${f.path}`); continue; }
      const h = await F.hashFile(abs);
      if (h.sha256 !== f.sha256) problems.push(`checksum mismatch: ${f.path}`);
    }
    if (deep && !problems.length) {
      const tmp = path.join(root, `.tmp-verify-${crypto.randomBytes(4).toString('hex')}`);
      try {
        fs.mkdirSync(tmp, { mode: 0o700 });
        const db = path.join(tmp, 'agastya.db');
        const r = await F.extractFile(path.join(dir, 'db', 'agastya.db'), db, key);
        if (r.sha256 !== m.files.find((x) => x.path === 'db/agastya.db').plainSha256) problems.push('the database does not match its checksum');
        else {
          const sdb = new DatabaseSync(db, { readOnly: true });
          try {
            const ic = sdb.prepare('PRAGMA integrity_check').all().map((x) => x.integrity_check);
            if (ic.length !== 1 || ic[0] !== 'ok') problems.push('the database failed its integrity check');
            if (sdb.prepare('PRAGMA foreign_key_check').all().length) problems.push('the database has broken references');
          } finally { sdb.close(); }
        }
      } catch (e) {
        problems.push(e.code === 'DECRYPT_FAILED' ? 'the database failed decryption (damaged, or a different key)' : 'the database could not be opened');
      } finally { removeTree(tmp); }
    }
    return { ok: !problems.length, problems, manifest: m };
  }

  function summaryOf(m, { status = 'ok', problems = [] } = {}) {
    if (!m) return null;
    return {
      id: m.id, kind: m.kind, createdAt: m.createdAt, note: m.note || null,
      createdBy: m.createdBy || null, appVersion: m.app && m.app.version, encrypted: !!m.encryption,
      size: m.files.reduce((n, f) => n + f.size, 0), files: m.files.length, stats: m.stats,
      components: m.components, status, problems,
      lastVerified: verified.get(m.id) || null,
    };
  }

  // ---- create -------------------------------------------------------------------------

  async function createLocked({ kind, actor = null, note = '', owner = null, ip = null }) {
    if (!F.KINDS.includes(kind)) throw new BackupError(400, 'VALIDATION', 'Unknown backup kind.');
    ensureRoot();
    const pre = walkData();
    const estimate = sizeOf(dbFile) + sizeOf(`${dbFile}-wal`) + pre.files.reduce((n, f) => n + f.size, 0);
    const need = Math.ceil(estimate * 1.2) + 5 * 1024 * 1024;
    if (spaceOf(root) < need) throw new BackupError(507, 'INSUFFICIENT_STORAGE', `There is not enough free space in the backup folder (about ${Math.ceil(need / 1048576)} MB needed).`);

    let id, tmp;
    for (let tries = 0; ; tries++) {
      id = F.newBackupId(now());
      tmp = path.join(root, `.tmp-${id}`);
      if (fs.existsSync(finalDir(id))) { if (tries > 20) throw new BackupError(500, 'BACKUP_IO_ERROR', 'Could not choose a unique backup id.'); continue; }
      try { fs.mkdirSync(tmp, { mode: 0o700 }); break; } catch (e) {
        if (e.code !== 'EEXIST' || tries > 20) throw fsError(e, 'create the backup');
      }
    }
    try {
      const files = [];
      let stats, migrations, skipped;
      const dbPlain = path.join(tmp, '.db-plain');
      if (maintenance) await maintenance.enter('backup', { owner });
      try {
        store.vacuumInto(dbPlain);
        // Counted from the copy itself, so the numbers describe exactly what was saved.
        {
          const { Store } = require('../db/store');
          const copy = new DatabaseSync(dbPlain, { readOnly: true });
          try {
            stats = Store.statsOf(copy);
            migrations = copy.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name);
          } finally { copy.close(); }
        }
        const w = walkData();
        skipped = w.skipped;
        if (hooks.afterDatabase) await hooks.afterDatabase();
        for (const f of w.files) {
          const dest = F.resolveInside(tmp, f.rel);
          if (!dest) { skipped++; continue; }
          const r = await F.storeFile(f.abs, dest, key);
          files.push({ path: f.rel, ...r });
          if (hooks.afterFile) await hooks.afterFile(files.length, f.rel);
        }
      } finally {
        if (maintenance) maintenance.exit();
      }
      const dbStored = await F.storeFile(dbPlain, path.join(tmp, 'db', 'agastya.db'), key);
      fs.unlinkSync(dbPlain);
      files.unshift({ path: 'db/agastya.db', ...dbStored });
      const count = (prefix) => files.filter((f) => f.path.startsWith(prefix));
      const manifest = {
        format: F.FORMAT, formatVersion: F.FORMAT_VERSION, id, createdAt: nowIso(), kind,
        ...(note ? { note: String(note).slice(0, 1000) } : {}),
        createdBy: actor ? { id: actor.id, username: actor.username } : { id: null, username: 'system' },
        app: { name: 'agastya', version: VERSION, node: process.version },
        schema: { migrations },
        encryption: key ? { algorithm: 'aes-256-gcm', keyId: keyInfo.keyId } : null,
        stats,
        components: {
          database: { files: 1, bytes: dbStored.plainSize },
          projects: { files: count('projects/').length, bytes: count('projects/').reduce((n, f) => n + f.plainSize, 0), projects: new Set(count('projects/').map((f) => f.path.split('/')[1])).size },
          snapshots: { files: count('snapshots/').length, bytes: count('snapshots/').reduce((n, f) => n + f.plainSize, 0), requests: new Set(count('snapshots/').map((f) => f.path.split('/')[1])).size },
          skipped,
        },
        files,
      };
      const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
      fs.writeFileSync(path.join(tmp, F.MANIFEST), bytes, { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(path.join(tmp, F.SEAL), `${F.sealOf(bytes, key)}\n`, { flag: 'wx', mode: 0o600 });
      if (hooks.beforeFinalize) await hooks.beforeFinalize(tmp);
      // Re-read everything as written: a backup is not a backup until it checks out.
      const v = await verifyDir(tmp, id, { deep: true });
      if (!v.ok) throw new BackupError(500, 'BACKUP_VERIFY_FAILED', `The backup did not check out after writing: ${v.problems.slice(0, 3).join('; ')}.`);
      renameRetry(tmp, finalDir(id));
      verified.set(id, { at: nowIso(), ok: true });
      audit({
        actorId: actor ? actor.id : null, actorUsername: actor ? actor.username : 'system', ip, action: 'backup.created', targetType: 'backup', targetId: id,
        meta: { kind, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), encrypted: !!key, projects: manifest.components.projects.projects, requests: manifest.components.snapshots.requests, skipped },
      });
      log.log && log.log(`[backup] ${kind} backup ${id} created (${files.length} files)`);
      return summaryOf(manifest);
    } catch (e) {
      removeTree(tmp);
      const err = fsError(e, 'write the backup');
      audit({
        actorId: actor ? actor.id : null, actorUsername: actor ? actor.username : 'system', ip, action: 'backup.failed', targetType: 'backup', targetId: id,
        meta: { kind, code: err.code },
      });
      log.error && log.error(`[backup] ${kind} backup failed: ${err.code}`);
      throw err;
    }
  }

  async function create(opts) {
    begin('backup');
    try {
      const summary = await createLocked(opts);
      try { applyRetention(opts.actor || null); } catch (e) { log.error && log.error(`[backup] retention failed: ${e.message}`); }
      return summary;
    } finally { end(); }
  }

  // ---- list, verify, delete, retention ----------------------------------------------------

  function list() {
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!F.ID_RE.test(e.name) || !e.isDirectory()) continue;
      const dir = finalDir(e.name);
      try { out.push(summaryOf(readManifest(dir, e.name))); } catch (err) {
        out.push({ id: e.name, status: 'damaged', problems: [err.message], kind: null, createdAt: null, size: null, files: null, encrypted: null, lastVerified: verified.get(e.name) || null });
      }
    }
    // Newest first by creation time (ids made in the same second differ only in a random suffix).
    const when = (x) => x.createdAt || isoFromId(x.id);
    return out.sort((a, b) => when(b).localeCompare(when(a)) || b.id.localeCompare(a.id));
  }

  async function verify(id, { actor = null, ip = null } = {}) {
    const dir = backupDirFor(id);
    const v = await verifyDir(dir, id, { deep: true });
    verified.set(id, { at: nowIso(), ok: v.ok });
    audit({
      actorId: actor ? actor.id : null, actorUsername: actor ? actor.username : 'system', ip,
      action: v.ok ? 'backup.verified' : 'backup.verify_failed', targetType: 'backup', targetId: id,
      meta: { problems: v.problems.length },
    });
    return { id, ok: v.ok, problems: v.problems.slice(0, 50), backup: summaryOf(v.manifest, { status: v.ok ? 'ok' : 'damaged', problems: v.problems.slice(0, 5) }) };
  }

  function remove(id, { actor = null, ip = null, retention = false } = {}) {
    const dir = backupDirFor(id);
    if (!retention) {
      if (op) throw new BackupError(409, 'OPERATION_IN_PROGRESS', `A ${op.kind} is in progress.`);
      const usable = list().filter((b) => b.status === 'ok');
      if (usable.length === 1 && usable[0].id === id) throw new BackupError(409, 'LAST_BACKUP', 'This is the only usable backup; it cannot be deleted. Create another one first.');
    }
    removeTree(dir);
    verified.delete(id);
    audit({
      actorId: actor ? actor.id : null, actorUsername: actor ? actor.username : 'system', ip,
      action: retention ? 'backup.retention_deleted' : 'backup.deleted', targetType: 'backup', targetId: id, meta: {},
    });
  }

  /*
    Retention (K8): the newest `keep` scheduled backups and the newest 3
    pre-restore recovery points are kept; older ones are deleted. Manual
    backups are kept until an administrator deletes them. The newest usable
    backup is never deleted, whatever its kind; damaged folders are left for
    an administrator to look at.
  */
  function applyRetention(actor = null) {
    const usable = list().filter((b) => b.status === 'ok');
    const newest = usable[0] ? usable[0].id : null;
    const removed = [];
    for (const [kind, n] of [['scheduled', keep], ['pre-restore', KEEP_PRE_RESTORE]]) {
      for (const b of usable.filter((x) => x.kind === kind).slice(n)) {
        if (b.id === newest) continue;
        remove(b.id, { actor, retention: true });
        removed.push(b.id);
      }
    }
    return removed;
  }

  // ---- restore --------------------------------------------------------------------------------

  // Move the current data aside (or back), item by item, recording progress in the journal.
  function moveItems(fromDir, toDir, names) {
    fs.mkdirSync(toDir, { recursive: true, mode: 0o700 });
    for (const name of names) {
      const from = path.join(fromDir, name);
      if (fs.existsSync(from)) renameRetry(from, path.join(toDir, name));
    }
  }

  // The restored state against the manifest: integrity, counts, every file's hash.
  async function verifyRestored(m) {
    const problems = [];
    const ic = store.db.prepare('PRAGMA integrity_check').all().map((x) => x.integrity_check);
    if (ic.length !== 1 || ic[0] !== 'ok') problems.push('the restored database failed its integrity check');
    const stats = store.backupStats();
    for (const [k, v] of Object.entries(m.stats)) {
      if (k === 'auditMaxId') { if (stats.auditMaxId < v) problems.push('audit records are missing'); continue; }
      if (stats[k] !== v) problems.push(`${k}: expected ${v}, found ${stats[k]}`);
    }
    for (const f of m.files) {
      if (f.path === 'db/agastya.db') continue;
      const abs = F.resolveInside(dataRoot, f.path);
      if (!abs || !fs.existsSync(abs)) { problems.push(`missing after restore: ${f.path}`); continue; }
      const h = await F.hashFile(abs);
      if (h.sha256 !== f.plainSha256) problems.push(`changed after restore: ${f.path}`);
    }
    return problems;
  }

  async function restore(id, { actor, owner = null, ip = null, reason = '' } = {}) {
    begin('restore');
    const staging = path.join(dataRoot, `.restore-staging-${id}`);
    let recoveryPoint = null;
    try {
      const dir = backupDirFor(id);
      const v = await verifyDir(dir, id, { deep: true });
      verified.set(id, { at: nowIso(), ok: v.ok });
      if (!v.ok) throw new BackupError(409, v.code === 'BACKUP_KEY_REQUIRED' || v.code === 'BACKUP_KEY_MISMATCH' ? v.code : 'BACKUP_INVALID', `The backup did not pass verification, so nothing was restored: ${v.problems.slice(0, 3).join('; ')}.`, { problems: v.problems.slice(0, 50) });
      const m = v.manifest;
      const plainTotal = m.files.reduce((n, f) => n + f.plainSize, 0);
      if (spaceOf(dataRoot) < Math.ceil(plainTotal * 1.2) + 5 * 1024 * 1024) throw new BackupError(507, 'INSUFFICIENT_STORAGE', 'There is not enough free space beside the data folder to stage the restore.');

      // Stage: decrypt and re-hash every file beside the data, on the same filesystem.
      removeTree(staging);
      fs.mkdirSync(staging, { mode: 0o700 });
      for (const f of m.files) {
        const dest = F.resolveInside(staging, f.path);
        if (!dest) throw new BackupError(409, 'BACKUP_INVALID', 'The backup holds an unsafe path.');
        const r = await F.extractFile(F.resolveInside(dir, f.path), dest, key);
        if (r.sha256 !== f.plainSha256 || r.size !== f.plainSize) throw new BackupError(409, 'BACKUP_INVALID', `A file did not match its checksum when staged: ${f.path}.`);
        if (hooks.afterStagedFile) await hooks.afterStagedFile(f.path);
      }
      makeReadOnly(path.join(staging, 'snapshots')); // as written at submission (B7)
      // The staged database: brought forward to this version's schema, then counted.
      const stagedDb = path.join(staging, 'db', 'agastya.db');
      {
        const { Store } = require('../db/store');
        const s = new Store(stagedDb);
        try {
          s.migrate(nowIso());
          const st = s.backupStats();
          for (const [k, val] of Object.entries(m.stats)) {
            if (st[k] !== val) throw new BackupError(409, 'BACKUP_INVALID', `The backup's database does not match its manifest (${k}).`);
          }
        } finally { s.close(); }
      }

      audit({
        actorId: actor.id, actorUsername: actor.username, ip, action: 'backup.restore_started', targetType: 'backup', targetId: id,
        meta: { backupCreatedAt: m.createdAt, reason: String(reason || '').slice(0, 1000) || undefined },
      });
      // A recovery point of the current state, verified, before anything is replaced.
      recoveryPoint = await createLocked({ kind: 'pre-restore', actor, note: `Recovery point taken before restoring ${id}`, owner, ip });

      if (maintenance) await maintenance.enter('restore', { owner, idle: () => activeBuilds().length === 0, timeoutMs: 120000 });
      const holding = path.join(dataRoot, `.pre-restore-${id}`);
      const journal = path.join(dataRoot, JOURNAL);
      let carried = 0;
      let swapped = false;
      try {
        // Audit continuity (K6): what happened since the backup, this restore's start included, follows it.
        {
          const sdb = new DatabaseSync(stagedDb);
          try {
            const max = Number(sdb.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').get().n);
            const ins = sdb.prepare('INSERT INTO audit_log (id, at, actor_id, actor_username, ip, action, target_type, target_id, project_id, meta) VALUES (?,?,?,?,?,?,?,?,?,?)');
            sdb.exec('BEGIN');
            for (const r of store.auditRowsAfter(max)) {
              ins.run(r.id, r.at, r.actor_id, r.actor_username, r.ip, r.action, r.target_type, r.target_id, r.project_id, r.meta);
              carried++;
            }
            sdb.exec('COMMIT');
          } finally { sdb.close(); }
        }
        removeTree(holding);
        writeAtomic(journal, JSON.stringify({ phase: 'swapping', backupId: id, holding: path.basename(holding), staging: path.basename(staging), at: nowIso() }));
        store.close();
        swapped = true;
        moveItems(dataRoot, holding, ITEMS);
        if (hooks.duringSwap) await hooks.duringSwap();
        renameRetry(stagedDb, dbFile);
        for (const sub of ['projects', 'snapshots']) {
          const from = path.join(staging, sub);
          if (fs.existsSync(from)) renameRetry(from, path.join(dataRoot, sub));
          else fs.mkdirSync(path.join(dataRoot, sub), { recursive: true });
        }
        store.open();
        store.migrate(nowIso());
        const problems = await verifyRestored(m);
        if (hooks.afterSwap) await hooks.afterSwap(problems);
        if (problems.length) throw new BackupError(500, 'RESTORE_VERIFY_FAILED', `The restored data did not check out: ${problems.slice(0, 3).join('; ')}.`, { problems });
        // Everyone signs in again: sessions in the backup must not come back to life (K7).
        const ended = store.revokeAllSessions('backup-restored', nowIso());
        writeAtomic(journal, JSON.stringify({ phase: 'done', backupId: id, holding: path.basename(holding), at: nowIso() }));
        removeTree(holding);
        fs.unlinkSync(journal);
        audit({
          actorId: actor.id, actorUsername: actor.username, ip, action: 'backup.restored', targetType: 'backup', targetId: id,
          meta: { backupCreatedAt: m.createdAt, recoveryPointId: recoveryPoint.id, carriedAuditRows: carried, sessionsEnded: ended, reason: String(reason || '').slice(0, 1000) || undefined },
        });
        log.log && log.log(`[backup] restored ${id} (recovery point ${recoveryPoint.id})`);
        try { onRestored(); } catch (e) { log.error && log.error(`[backup] after-restore hook failed: ${e.message}`); }
        return { restored: summaryOf(m), recoveryPoint, carriedAuditRows: carried, sessionsEnded: ended };
      } catch (e) {
        if (swapped) {
          // Put the original data back exactly as it was.
          try { store.close(); } catch { /* closed */ }
          const failed = path.join(dataRoot, `.failed-restore-${id}`);
          removeTree(failed);
          moveItems(dataRoot, failed, ITEMS);
          moveItems(holding, dataRoot, ITEMS);
          removeTree(failed);
          removeTree(holding);
          try { fs.unlinkSync(journal); } catch { /* gone */ }
          store.open();
        }
        throw e;
      } finally {
        if (maintenance) maintenance.exit();
      }
    } catch (e) {
      const err = e instanceof BackupError ? e : fsError(e, 'restore the backup');
      audit({
        actorId: actor ? actor.id : null, actorUsername: actor ? actor.username : 'system', ip, action: 'backup.restore_failed', targetType: 'backup', targetId: String(id).slice(0, 40),
        meta: { code: err.code, recoveryPointId: recoveryPoint ? recoveryPoint.id : undefined },
      });
      log.error && log.error(`[backup] restore of ${String(id).slice(0, 40)} failed: ${err.code}`);
      throw err;
    } finally {
      removeTree(staging);
      // Recovery points are kept to the newest three (K8), whatever the outcome.
      try { applyRetention(actor || null); } catch (e) { log.error && log.error(`[backup] retention failed: ${e.message}`); }
      end();
    }
  }

  // ---- schedule, start-up cleanup, health ----------------------------------------------------

  // The most recent scheduled time at or before `at` (server local time).
  function slotBefore(at) {
    const [h, mi] = schedule.split(':').map(Number);
    const slot = new Date(at);
    slot.setHours(h, mi, 0, 0);
    if (slot > at) slot.setDate(slot.getDate() - 1);
    return slot;
  }

  async function tick() {
    if (!schedule || op || configProblem) return null;
    const at = now();
    if (at.getTime() - lastScheduledFailure < RETRY_AFTER_FAILURE_MS) return null;
    const slot = slotBefore(at);
    const done = list().some((b) => b.status === 'ok' && b.kind === 'scheduled' && Date.parse(b.createdAt) >= slot.getTime());
    if (done) return null;
    try { return await create({ kind: 'scheduled' }); } catch (e) {
      lastScheduledFailure = at.getTime();
      return null;
    }
  }

  function start() {
    // Leftovers of interrupted runs are never valid backups.
    try {
      if (fs.existsSync(root)) for (const e of fs.readdirSync(root)) if (e.startsWith('.tmp-')) removeTree(path.join(root, e));
      for (const e of fs.readdirSync(dataRoot)) if (e.startsWith('.restore-staging-') || e.startsWith('.failed-restore-')) removeTree(path.join(dataRoot, e));
    } catch { /* nothing to clean */ }
    if (schedule && !timer) {
      timer = setInterval(() => { tick().catch(() => {}); }, 60 * 1000);
      if (timer.unref) timer.unref();
    }
    if (configProblem) log.error && log.error(`[backup] ${configProblem}`);
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  function status() {
    const all = list();
    const usable = all.filter((b) => b.status === 'ok');
    const last = usable[0] || null;
    const ageHours = last ? (now().getTime() - Date.parse(last.createdAt)) / 3600000 : null;
    const warnings = [];
    if (configProblem) warnings.push(configProblem);
    if (!key) warnings.push('Backups are not encrypted: set AGASTYA_BACKUP_KEY to encrypt them, and keep the key somewhere safe outside Agastya.');
    if (!schedule) warnings.push('Scheduled backups are off: set AGASTYA_BACKUP_SCHEDULE (for example 02:30) to take one every day.');
    if (schedule && ageHours !== null && ageHours > 26) warnings.push(`The last successful backup is ${Math.round(ageHours)} hours old.`);
    if (all.some((b) => b.status !== 'ok')) warnings.push('At least one backup folder is damaged or unreadable.');
    return {
      configured: !!schedule || usable.length > 0,
      schedule, keep, keepPreRestore: KEEP_PRE_RESTORE, encrypted: !!key, keyId: keyInfo.keyId || null,
      directory: root, freeBytes: Number.isFinite(spaceOf(root)) ? spaceOf(root) : null,
      count: usable.length, damaged: all.length - usable.length,
      last: last ? { id: last.id, at: last.createdAt, kind: last.kind } : null,
      lastAgeHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      operation: op,
      warnings,
      message: last ? `Last backup ${last.createdAt}` : schedule ? 'No backup yet' : 'No backup configured',
    };
  }

  return { create, list, verify, remove, restore, applyRetention, tick, start, stop, status, verifyDir, BackupError, configProblem: () => configProblem };
}

module.exports = { createBackupService, BackupError, removeTree, foldersOverlap };
