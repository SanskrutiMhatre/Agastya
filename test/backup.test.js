'use strict';
// Phase 5, backup and restore (decisions.md K1-K12), over real HTTP and the
// service itself: who may use it; what a backup holds and leaves out; that
// it verifies, and that any damage, unlisted file, unsafe path, link or
// newer schema is refused; that a restore brings back documents, graphics,
// revisions, requests, snapshots, accounts and memberships exactly, keeps
// the audit trail continuous, takes a recovery point and ends every session;
// failures at every stage (interrupted backup, no space, I/O error, a
// restore that fails after the swap, a crash during the swap) leave the data
// as it was; one operation at a time, writes paused meanwhile; retention,
// unique ids, encryption, the schedule and the command-line tool.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { startServer, adminClient, makeUser, ADMIN, tmpdir, quietLog } = require('./helpers');
const F = require('../server/backup/format');
const { recoverInterruptedRestore, JOURNAL } = require('../server/backup/recovery');
const { createServer } = require('../server/server');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');
const ICN = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';
const read = (p) => fs.readFileSync(p, 'utf8');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hooks = {};
let freeSpace = null;
let t, admin, pm, author, project, request;

async function upload(c, url, fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields || {})) form.append(k, v);
  if (file) form.append('file', new Blob([file.data]), file.name);
  const res = await fetch(t.base + url, { method: 'POST', body: form, headers: { cookie: c.cookie } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const ws = () => path.join(t.dataDir, 'projects', project.id);
const audits = (action) => t.store.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
const backup = async (note) => { const r = await admin.post('/api/admin/backups', note ? { note } : {}); assert.equal(r.status, 201, r.text); return r.body.backup; };
const restore = (id, extra = {}) => admin.post(`/api/admin/backups/${id}/restore`, { confirm: id, password: ADMIN.password, reason: 'Recovering the state from the test backup.', ...extra });
// Everything a restore must bring back, as plain values.
function fingerprint() {
  const db = t.store.db;
  const all = (sql) => JSON.stringify(db.prepare(sql).all());
  const files = {};
  for (const base of ['projects', 'snapshots']) {
    (function walk(dir, rel) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== '.previews') walk(path.join(dir, e.name), r); continue; }
        if (base === 'projects' && rel.split('/').length === 2 && F.EXCLUDED_TOP.test(e.name)) continue;
        if (F.isTempFile(e.name)) continue; // the write path's temporary files are not data (K2)
        files[r] = sha(fs.readFileSync(path.join(dir, e.name)));
      }
    })(path.join(t.dataDir, base), base);
  }
  return {
    users: all('SELECT id, username, role, password_hash, disabled_at, created_by FROM users ORDER BY id'),
    projects: all('SELECT * FROM projects ORDER BY id'),
    members: all('SELECT * FROM project_members ORDER BY project_id, user_id'),
    documents: all('SELECT * FROM documents ORDER BY id'),
    revisions: all('SELECT * FROM revisions ORDER BY id'),
    blobs: all('SELECT hash, size FROM blobs ORDER BY hash'),
    dms: all('SELECT * FROM data_modules ORDER BY id'),
    graphics: all('SELECT * FROM graphics ORDER BY id'),
    requests: all('SELECT * FROM publication_requests ORDER BY id'),
    requestModules: all('SELECT * FROM request_modules ORDER BY request_id, data_module_id'),
    files,
  };
}
// Compared part by part, so a failure names what differs.
function sameState(actual, expected, msg) {
  for (const k of Object.keys(expected)) {
    if (k === 'files') {
      const a = actual.files, e = expected.files;
      assert.deepEqual(Object.keys(a).filter((x) => !(x in e)), [], `${msg}: files that should not be there`);
      assert.deepEqual(Object.keys(e).filter((x) => !(x in a)), [], `${msg}: files missing`);
      for (const f of Object.keys(e)) assert.equal(a[f], e[f], `${msg}: ${f} differs`);
    } else assert.deepEqual(JSON.parse(actual[k]), JSON.parse(expected[k]), `${msg}: ${k}`);
  }
}
const backupDirOf = (id) => path.join(t.backupDir, id);
function reseal(dir, mutate) {
  const m = JSON.parse(read(path.join(dir, 'manifest.json')));
  mutate(m);
  const bytes = Buffer.from(JSON.stringify(m, null, 2));
  fs.writeFileSync(path.join(dir, 'manifest.json'), bytes);
  fs.writeFileSync(path.join(dir, 'manifest.seal'), `${F.sealOf(bytes, null)}\n`);
}
function copyBackup(id) {
  const copyId = F.newBackupId(new Date(Date.now() - 86400000));
  fs.cpSync(backupDirOf(id), backupDirOf(copyId), { recursive: true });
  reseal(backupDirOf(copyId), (m) => { m.id = copyId; });
  return copyId;
}

test.before(async () => {
  t = await startServer({ backupHooks: hooks, backupFreeSpace: (dir) => (freeSpace ? freeSpace(dir) : Infinity) });
  admin = await adminClient(t);
  pm = await makeUser(t, admin, { username: 'priya.rao', fullName: 'Priya Rao', role: 'project_manager' });
  author = await makeUser(t, pm, { username: 'arjun.das', fullName: 'Arjun Das', role: 'author' });
  project = (await author.post('/api/projects', { name: 'PDU-200 Manual' })).body.project;
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) {
    assert.equal((await author.post(`/api/projects/${project.id}/dms/import`, { filename: f, content: read(path.join(GOLDEN, 'csdb', f)) })).status, 201);
  }
  assert.equal((await upload(author, `/api/projects/${project.id}/graphics`, { icn: ICN }, { data: fs.readFileSync(path.join(GOLDEN, 'csdb', `${ICN}.png`)), name: 'x.png' })).status, 201);
  for (const m of ['emblem.png', 'publisher-logo.png']) fs.copyFileSync(path.join(GOLDEN, 'Media', m), path.join(ws(), 'Media', m));
  const g = await author.get(`/api/projects/${project.id}/publication`);
  await author.raw('PUT', `/api/projects/${project.id}/publication`, { xml: read(path.join(GOLDEN, 'publication.xml')), baseRevision: g.body.revision });
  const r = await author.post(`/api/projects/${project.id}/requests`, { approverId: pm.user.id });
  assert.equal(r.status, 201, r.text);
  request = r.body.request;
  // Build outputs and caches a backup leaves out.
  for (const f of ['output.pdf', 'output.fo', 'jss-book.xml', '_preview.pdf', 'jss-run.xsl', 'csdb/x.xml.123.456.tmp']) fs.writeFileSync(path.join(ws(), f), 'generated');
  fs.mkdirSync(path.join(ws(), '.previews'), { recursive: true });
  fs.writeFileSync(path.join(ws(), '.previews', 'x.pdf'), 'cache');
});
test.after(() => t.stop());
test.afterEach(() => { for (const k of Object.keys(hooks)) delete hooks[k]; freeSpace = null; });

// ---- who may use it -------------------------------------------------------------------------

test('only the Software Administrator reaches the backup routes (403 for others, 401 anonymous)', async () => {
  const id = 'bk-20260101-000000-abcdef';
  const routes = [['GET', '/api/admin/backups'], ['POST', '/api/admin/backups'], ['POST', `/api/admin/backups/${id}/verify`], ['DELETE', `/api/admin/backups/${id}`], ['POST', `/api/admin/backups/${id}/restore`]];
  const anon = t.client();
  for (const [m, url] of routes) {
    for (const c of [pm, author]) assert.equal((await c.raw(m, url, m === 'GET' ? undefined : {})).status, 403, `${c.user.username} ${m} ${url}`);
    assert.equal((await anon.raw(m, url, m === 'GET' ? undefined : {})).status, 401, `anonymous ${m} ${url}`);
  }
  assert.equal(t.app.router.stack.filter((l) => l.route && l.route.path.startsWith('/api/admin/backups')).length, 5);
});

// ---- creating and checking a backup ---------------------------------------------------------

test('a backup holds the database, every workspace source file and the snapshots, and leaves build outputs out', async () => {
  const b = await backup('before the release');
  assert.match(b.id, F.ID_RE);
  assert.equal(b.kind, 'manual');
  assert.equal(b.status, 'ok');
  const dir = backupDirOf(b.id);
  const m = JSON.parse(read(path.join(dir, 'manifest.json')));
  const paths = m.files.map((f) => f.path);
  assert.ok(paths.includes('db/agastya.db'));
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) assert.ok(paths.includes(`projects/${project.id}/csdb/${f}`), f);
  for (const f of ['publication.xml', 'project.json', 'Media/emblem.png']) assert.ok(paths.includes(`projects/${project.id}/${f}`), f);
  assert.ok(paths.some((p) => p.startsWith(`projects/${project.id}/jss/frontmatter/`)), 'front matter');
  assert.ok(paths.some((p) => p.startsWith(`projects/${project.id}/`) && p.includes(ICN)), 'the graphic');
  for (const f of ['manifest.json', 'publication.pdf', 'validation.json']) assert.ok(paths.includes(`snapshots/${request.id}/${f}`), f);
  for (const left of ['output.pdf', 'output.fo', 'jss-book.xml', '_preview.pdf', 'jss-run.xsl', '.previews/x.pdf', 'csdb/x.xml.123.456.tmp']) assert.ok(!paths.includes(`projects/${project.id}/${left}`), left);
  assert.equal(m.format, 'agastya-backup');
  assert.equal(m.formatVersion, 1);
  assert.equal(m.note, 'before the release');
  assert.equal(m.createdBy.username, 'admin');
  assert.equal(m.encryption, null);
  assert.deepEqual(m.schema.migrations, t.store.appliedMigrations());
  assert.equal(m.stats.requests, 1);
  assert.equal(m.stats.dataModules, fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml')).length);
  for (const f of m.files) assert.equal(sha(fs.readFileSync(path.join(dir, ...f.path.split('/')))), f.sha256, f.path);
  assert.equal(read(path.join(dir, 'manifest.seal')).trim(), F.sealOf(fs.readFileSync(path.join(dir, 'manifest.json')), null));
  // Never a credential or the server's configuration in the manifest.
  const text = read(path.join(dir, 'manifest.json'));
  for (const s of [ADMIN.password, ADMIN.bootstrap, pm.password, author.password, admin.cookie.split('=')[1], 'AGASTYA_INITIAL_ADMIN_PASSWORD', t.dataDir]) assert.ok(!text.includes(s), s.slice(0, 12));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o077, 0, 'the backup folder is private to the server account');
    assert.equal(fs.statSync(path.join(dir, 'db', 'agastya.db')).mode & 0o077, 0, 'files are private too');
  }
  const a = audits('backup.created').pop();
  assert.equal(JSON.parse(a.meta).kind, 'manual');
  assert.equal(a.target_id, b.id);
});

test('verification passes, and refuses a changed byte, a missing or unlisted file, a changed manifest, an unsafe path, a link and a newer schema', async () => {
  const good = (await admin.get('/api/admin/backups')).body.backups.find((x) => x.kind === 'manual');
  const v = await admin.post(`/api/admin/backups/${good.id}/verify`);
  assert.equal(v.status, 200);
  assert.equal(v.body.ok, true, JSON.stringify(v.body.problems));
  assert.equal(audits('backup.verified').length, 1);

  const cases = {
    'a changed byte': (dir, m) => { const f = path.join(dir, ...m.files.find((x) => x.path.endsWith('publication.xml')).path.split('/')); const b = fs.readFileSync(f); b[10] ^= 1; fs.writeFileSync(f, b); return /checksum mismatch/; },
    'a missing file': (dir, m) => { fs.unlinkSync(path.join(dir, ...m.files.find((x) => x.path.includes('/Media/')).path.split('/'))); return /missing/; },
    'an unlisted file': (dir) => { fs.writeFileSync(path.join(dir, 'projects', project.id, 'extra.xml'), '<x/>'); return /not in the manifest/; },
    'a changed manifest': (dir) => { const f = path.join(dir, 'manifest.json'); fs.writeFileSync(f, read(f).replace('"kind": "manual"', '"kind": "scheduled"')); return /changed or damaged/; },
    'an unsafe path': (dir) => { reseal(dir, (m) => { m.files[1].path = `projects/${project.id}/../../../etc/passwd`; }); return /unsafe or invalid path/; },
    'a newer schema': (dir) => { reseal(dir, (m) => { m.schema.migrations.push('099-from-the-future'); }); return /newer version/; },
    'a damaged database': (dir, m) => { const f = path.join(dir, 'db', 'agastya.db'); const b = fs.readFileSync(f); b.fill(0x55, 2000, 6000); fs.writeFileSync(f, b); reseal(dir, (mm) => { const e = mm.files.find((x) => x.path === 'db/agastya.db'); e.sha256 = sha(b); }); return /database/; },
  };
  if (process.platform !== 'win32') cases['a link'] = (dir) => { fs.symlinkSync('/etc/hostname', path.join(dir, 'projects', project.id, 'link.xml')); return /link is not allowed/; };
  const before = fingerprint();
  for (const [what, damage] of Object.entries(cases)) {
    const id = copyBackup(good.id);
    const dir = backupDirOf(id);
    const expect = damage(dir, JSON.parse(read(path.join(dir, 'manifest.json'))));
    const r = await admin.post(`/api/admin/backups/${id}/verify`);
    assert.equal(r.body.ok, false, what);
    assert.ok(r.body.problems.some((p) => expect.test(p)), `${what}: ${JSON.stringify(r.body.problems)}`);
    const rs = await restore(id);
    assert.equal(rs.status, 409, `${what} must not be restored`);
    assert.match(rs.body.code, /BACKUP_INVALID/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  sameState(fingerprint(), before, 'a refused restore changes nothing');
  assert.ok(audits('backup.restore_failed').length >= Object.keys(cases).length);
  assert.equal((await pm.get('/api/auth/me')).status, 200, 'and signs nobody out');
});

test('backup ids are validated, unique and never reused', async () => {
  for (const bad of ['..%2F..%2Fetc', 'bk-1', 'bk-20260101-000000-ABCDEF', 'x'.repeat(30)]) {
    assert.equal((await admin.post(`/api/admin/backups/${bad}/verify`)).status, 404, bad);
    assert.equal((await admin.raw('DELETE', `/api/admin/backups/${bad}`, {})).status, 404, bad);
  }
  // A clash with an existing folder is detected and a fresh id chosen.
  const existing = (await admin.get('/api/admin/backups')).body.backups[0].id;
  const orig = F.newBackupId;
  let calls = 0;
  F.newBackupId = (now) => (calls++ < 2 ? existing : orig(now));
  try {
    const b = await backup();
    assert.notEqual(b.id, existing);
    assert.ok(calls >= 3);
  } finally { F.newBackupId = orig; }
  const ids = (await admin.get('/api/admin/backups')).body.backups.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---- restore ----------------------------------------------------------------------------------

test('a restore brings back documents, graphics, revisions, requests, snapshots, accounts and memberships exactly', async () => {
  const before = fingerprint();
  const b = await backup('known good');
  // Change everything after the backup.
  const dms = (await author.get(`/api/projects/${project.id}/dms`)).body.modules;
  const g = await author.get(`/api/projects/${project.id}/dms/${dms[0].id}`);
  assert.equal((await pm.post(`/api/requests/${request.id}/decision`, { outcome: 'changes', comment: 'Please rework.' })).status, 200);
  assert.equal((await author.raw('PUT', `/api/projects/${project.id}/dms/${dms[0].id}`, { xml: g.body.xml.replace('</dmodule>', '<!-- after the backup --></dmodule>'), baseRevision: g.body.revision })).status, 200);
  assert.equal((await author.raw('DELETE', `/api/projects/${project.id}/dms/${dms[1].id}`, {})).status, 200);
  fs.writeFileSync(path.join(ws(), 'Media', 'emblem.png'), 'replaced');
  const later = await makeUser(t, admin, { username: 'later.user', role: 'author' });
  assert.equal((await author.post(`/api/projects/${project.id}/members`, { userId: later.user.id })).status, 201);
  const other = (await pm.post('/api/projects', { name: 'Made after the backup' })).body.project;
  assert.notDeepEqual(fingerprint(), before);
  const auditBefore = t.store.backupStats().auditMaxId;

  const r = await restore(b.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.signedOut, true);
  assert.match(r.headers.get('set-cookie'), /agastya_session=;.*Max-Age=0/);
  assert.match(r.body.recoveryPoint.id, F.ID_RE);
  assert.equal(r.body.recoveryPoint.kind, 'pre-restore');
  sameState(fingerprint(), before, 'the data is exactly as backed up');
  assert.equal(fs.existsSync(path.join(t.dataDir, 'projects', other.id)), false);
  assert.equal(t.store.getUser(later.user.id), null);
  // Snapshots come back read-only, as written at submission.
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(t.dataDir, 'snapshots', request.id, 'publication.pdf')).mode & 0o222, 0);
  // Every session ended, the restorer's too; the audit trail runs on without a gap.
  for (const c of [admin, pm, author]) assert.equal((await c.get('/api/auth/me')).status, 401);
  const ids = t.store.db.prepare('SELECT id FROM audit_log ORDER BY id').all().map((x) => x.id);
  assert.ok(ids.includes(auditBefore), 'audit rows written after the backup were carried over');
  const done = audits('backup.restored').pop();
  const meta = JSON.parse(done.meta);
  assert.equal(done.target_id, b.id);
  assert.equal(meta.recoveryPointId, r.body.recoveryPoint.id);
  assert.ok(meta.carriedAuditRows > 5);
  assert.equal(meta.reason, 'Recovering the state from the test backup.');
  assert.ok(audits('backup.restore_started').length >= 1);
  // Nothing is left behind beside the data.
  assert.deepEqual(fs.readdirSync(t.dataDir).filter((x) => x.startsWith('.')), []);
  // The application works on the restored data.
  admin = await adminClient(t);
  author = t.client();
  assert.equal((await author.post('/api/auth/login', { username: 'arjun.das', password: author.password || 'Pw-arjun.das-Strong-7' })).status, 200);
  assert.equal((await author.get(`/api/projects/${project.id}/dms`)).status, 200);
  assert.equal((await author.get(`/api/projects/${project.id}/requests`)).body.requests[0].status, 'pending', 'the request is pending again, as at backup time');

  // The recovery point brings the later state back.
  const back = await restore(r.body.recoveryPoint.id);
  assert.equal(back.status, 200, back.text);
  admin = await adminClient(t);
  assert.ok(t.store.getUser(later.user.id), 'the account made after the backup is back');
  assert.ok(fs.existsSync(path.join(t.dataDir, 'projects', other.id)));
  pm = t.client();
  await pm.post('/api/auth/login', { username: 'priya.rao', password: 'Pw-priya.rao-Strong-7' });
  pm.user = { id: t.store.findUserByUsername('priya.rao').id, username: 'priya.rao' };
  author = t.client();
  await author.post('/api/auth/login', { username: 'arjun.das', password: 'Pw-arjun.das-Strong-7' });
  author.user = { id: t.store.findUserByUsername('arjun.das').id, username: 'arjun.das' };
});

test('a restore asks for the backup id typed again, the administrator\'s password and a reason', async () => {
  const id = (await admin.get('/api/admin/backups')).body.backups.find((x) => x.status === 'ok').id;
  const before = fingerprint();
  assert.equal((await restore(id, { confirm: 'bk-20260101-000000-abcdef' })).body.code, 'CONFIRMATION_MISMATCH');
  assert.equal((await restore(id, { password: 'not-my-password' })).body.code, 'REAUTH_FAILED');
  assert.equal((await restore(id, { reason: 'short' })).status, 400);
  assert.equal((await admin.post(`/api/admin/backups/${id}/restore`, { confirm: id, password: ADMIN.password })).status, 400);
  sameState(fingerprint(), before, 'unchanged');
  assert.equal((await pm.get('/api/auth/me')).status, 200);
});

test('a restore that fails after the swap puts the original data back, and keeps the recovery point', async () => {
  const id = (await admin.get('/api/admin/backups')).body.backups.find((x) => x.status === 'ok' && x.kind === 'manual').id;
  const before = fingerprint();
  const points = (await admin.get('/api/admin/backups')).body.backups.filter((x) => x.kind === 'pre-restore').length;
  hooks.afterSwap = () => { throw Object.assign(new Error('simulated failure after the swap'), { code: 'EIO' }); };
  const r = await restore(id);
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'BACKUP_IO_ERROR');
  assert.ok(!/\//.test(r.body.error), 'no path in the message');
  sameState(fingerprint(), before, 'nothing was replaced');
  assert.equal((await pm.get('/api/auth/me')).status, 200, 'and nobody was signed out');
  assert.deepEqual(fs.readdirSync(t.dataDir).filter((x) => x.startsWith('.')), []);
  assert.equal(JSON.parse(audits('backup.restore_failed').pop().meta).code, 'BACKUP_IO_ERROR');
  const after = (await admin.get('/api/admin/backups')).body.backups.filter((x) => x.kind === 'pre-restore').length;
  assert.equal(after, Math.min(points + 1, 3), 'the recovery point taken first is kept');
  // An interruption while the data is being moved is undone the same way.
  hooks.duringSwap = () => { throw new Error('simulated interruption during the swap'); };
  assert.equal((await restore(id)).status, 500);
  sameState(fingerprint(), before, 'unchanged');
});

test('a restore cut short by a crash is undone when the server next starts', () => {
  // Built by hand: the original data in the holding folder, part of the restored data in place, the journal saying "swapping".
  const dir = tmpdir('agastya-crash-');
  const holding = '.pre-restore-bk-20260101-000000-abcdef';
  fs.mkdirSync(path.join(dir, holding, 'projects', 'prj-0000000001'), { recursive: true });
  fs.writeFileSync(path.join(dir, holding, 'agastya.db'), 'ORIGINAL-DB');
  fs.writeFileSync(path.join(dir, holding, 'projects', 'prj-0000000001', 'project.json'), 'ORIGINAL');
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true }); // never moved: left alone
  fs.writeFileSync(path.join(dir, 'snapshots', 'keep.txt'), 'KEPT');
  fs.writeFileSync(path.join(dir, 'agastya.db'), 'HALF-RESTORED');
  fs.writeFileSync(path.join(dir, JOURNAL), JSON.stringify({ phase: 'swapping', backupId: 'bk-20260101-000000-abcdef', holding, staging: '.restore-staging-bk-20260101-000000-abcdef' }));
  fs.mkdirSync(path.join(dir, '.restore-staging-bk-20260101-000000-abcdef'));
  const outcome = recoverInterruptedRestore(dir, quietLog);
  assert.match(outcome, /undone/);
  assert.equal(read(path.join(dir, 'agastya.db')), 'ORIGINAL-DB');
  assert.equal(read(path.join(dir, 'projects', 'prj-0000000001', 'project.json')), 'ORIGINAL');
  assert.equal(read(path.join(dir, 'snapshots', 'keep.txt')), 'KEPT');
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.startsWith('.')), []);
  // A journal naming a folder outside the expected shape is not followed.
  fs.writeFileSync(path.join(dir, JOURNAL), JSON.stringify({ phase: 'swapping', holding: '../../etc' }));
  assert.match(recoverInterruptedRestore(dir, quietLog), /left as it is/);
  assert.equal(read(path.join(dir, 'agastya.db')), 'ORIGINAL-DB');
  // And the server runs the recovery before it opens the database.
  const real = tmpdir('agastya-crash-srv-');
  const first = createServer({ dataDir: real, env: {}, log: quietLog });
  first.stop();
  fs.mkdirSync(path.join(real, holding));
  fs.renameSync(path.join(real, 'agastya.db'), path.join(real, holding, 'agastya.db'));
  fs.writeFileSync(path.join(real, 'agastya.db'), 'not a database');
  fs.writeFileSync(path.join(real, JOURNAL), JSON.stringify({ phase: 'swapping', backupId: 'x', holding }));
  const again = createServer({ dataDir: real, env: {}, log: quietLog });
  assert.ok(again.store.appliedMigrations().length > 10, 'the original database is back and opens');
  again.stop();
});

// ---- failures while backing up ---------------------------------------------------------------

test('an interrupted backup leaves nothing that looks like a backup', async () => {
  const before = (await admin.get('/api/admin/backups')).body.backups.map((x) => x.id);
  hooks.afterFile = (n) => { if (n === 3) throw new Error('simulated crash half way'); };
  const r = await admin.post('/api/admin/backups', {});
  assert.equal(r.status, 500);
  assert.deepEqual((await admin.get('/api/admin/backups')).body.backups.map((x) => x.id), before);
  assert.deepEqual(fs.readdirSync(t.backupDir).filter((x) => x.startsWith('.tmp-')), []);
  assert.equal(JSON.parse(audits('backup.failed').pop().meta).code, 'BACKUP_IO_ERROR');
  assert.equal((await pm.post('/api/projects', { name: 'Writes resume after a failure' })).status, 201, 'the write gate is released');
  // A process killed half way leaves a .tmp- folder: never listed, removed at the next start.
  fs.mkdirSync(path.join(t.backupDir, '.tmp-bk-20260101-000000-abcdef'));
  assert.ok(!(await admin.get('/api/admin/backups')).body.backups.some((x) => x.id.includes('20260101')));
  t.backups.start();
  assert.ok(!fs.existsSync(path.join(t.backupDir, '.tmp-bk-20260101-000000-abcdef')));
});

test('no space: refused before anything is written; a disk filling up during the backup is reported as such', async () => {
  freeSpace = () => 1024;
  let r = await admin.post('/api/admin/backups', {});
  assert.equal(r.status, 507);
  assert.equal(r.body.code, 'INSUFFICIENT_STORAGE');
  freeSpace = null;
  hooks.beforeFinalize = () => { throw Object.assign(new Error('write failed'), { code: 'ENOSPC' }); };
  r = await admin.post('/api/admin/backups', {});
  assert.equal(r.status, 507);
  assert.equal(r.body.code, 'INSUFFICIENT_STORAGE');
  assert.deepEqual(fs.readdirSync(t.backupDir).filter((x) => x.startsWith('.tmp-')), []);
  // A restore without space beside the data is refused before anything moves.
  const id = (await admin.get('/api/admin/backups')).body.backups.find((x) => x.status === 'ok').id;
  freeSpace = (dir) => (path.resolve(dir) === path.resolve(t.dataDir) ? 1024 : Infinity);
  const before = fingerprint();
  assert.equal((await restore(id)).body.code, 'INSUFFICIENT_STORAGE');
  sameState(fingerprint(), before, 'unchanged');
});

test('one operation at a time; writes wait while a backup is taken, reads carry on', async () => {
  let release;
  const paused = new Promise((resolve) => { hooks.afterDatabase = () => new Promise((r) => { release = r; resolve(); }); });
  const first = admin.post('/api/admin/backups', {});
  // If the backup ends without reaching the pause, fail instead of waiting forever.
  await Promise.race([paused, first.then((r) => { throw new Error(`the backup ended before the pause: ${r.status} ${r.text}`); })]);
  // A second request is held at the gate; the service itself refuses a second operation.
  const second = await admin.post('/api/admin/backups', {});
  assert.equal(second.status, 503);
  assert.equal(second.body.code, 'MAINTENANCE');
  await assert.rejects(t.backups.create({ kind: 'manual' }), (e) => e.code === 'OPERATION_IN_PROGRESS');
  await assert.rejects(t.backups.restore('bk-20260101-000000-abcdef', { actor: { id: null, username: 'x' } }), (e) => e.code === 'OPERATION_IN_PROGRESS');
  const write = await pm.post('/api/projects', { name: 'During the backup' });
  assert.equal(write.status, 503);
  assert.equal(write.body.code, 'MAINTENANCE');
  assert.equal((await pm.get('/api/projects')).status, 200, 'reads carry on');
  release();
  assert.equal((await first).status, 201);
  assert.equal((await pm.post('/api/projects', { name: 'After the backup' })).status, 201);
});

// ---- retention and deleting -------------------------------------------------------------------

test('retention keeps the newest scheduled backups and recovery points; manual ones stay; the last usable one cannot be deleted', async () => {
  const r = await startServer({ env: { AGASTYA_BACKUP_KEEP: '2' } });
  try {
    const a = await adminClient(r);
    const manual = (await a.post('/api/admin/backups', {})).body.backup;
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await r.backups.create({ kind: 'scheduled' }));
    const left = r.backups.list();
    assert.deepEqual(left.filter((x) => x.kind === 'scheduled').map((x) => x.id), made.slice(-2).reverse().map((x) => x.id));
    assert.ok(left.some((x) => x.id === manual.id), 'manual backups are kept');
    assert.equal(r.store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'backup.retention_deleted'").get().n, 2);
    for (const x of left.slice(1)) assert.equal((await a.raw('DELETE', `/api/admin/backups/${x.id}`, {})).status, 200);
    const last = r.backups.list();
    assert.equal(last.length, 1);
    const d = await a.raw('DELETE', `/api/admin/backups/${last[0].id}`, {});
    assert.equal(d.status, 409);
    assert.equal(d.body.code, 'LAST_BACKUP');
  } finally { await r.stop(); }
});

// ---- encryption -------------------------------------------------------------------------------

test('with a backup key, stored files are encrypted, sealed with the key, and restore only with the same key', async () => {
  const key = crypto.randomBytes(32).toString('hex');
  const e = await startServer({ env: { AGASTYA_BACKUP_KEY: key } });
  let id, backupDir;
  try {
    const a = await adminClient(e);
    const p = (await (await makeUser(e, a, { username: 'pm.enc', role: 'project_manager' })).post('/api/projects', { name: 'Secret-Project-Name-77' })).body.project;
    const b = (await a.post('/api/admin/backups', {})).body.backup;
    id = b.id; backupDir = e.backupDir;
    assert.equal(b.encrypted, true);
    const dir = path.join(backupDir, id);
    const m = JSON.parse(read(path.join(dir, 'manifest.json')));
    assert.equal(m.encryption.algorithm, 'aes-256-gcm');
    assert.ok(!read(path.join(dir, 'manifest.json')).includes(key));
    assert.match(read(path.join(dir, 'manifest.seal')), /^hmac-sha256:/);
    const pj = fs.readFileSync(path.join(dir, 'projects', p.id, 'project.json'));
    assert.ok(!pj.includes(Buffer.from('Secret-Project-Name-77')), 'workspace files are not readable');
    assert.ok(!fs.readFileSync(path.join(dir, 'db', 'agastya.db')).includes(Buffer.from('SQLite format 3')), 'nor is the database');
    assert.equal((await a.post(`/api/admin/backups/${id}/verify`)).body.ok, true);
    await (await makeUser(e, a, { username: 'after.enc', role: 'author' }));
    const r = await a.post(`/api/admin/backups/${id}/restore`, { confirm: id, password: ADMIN.password, reason: 'Encrypted restore round trip.' });
    assert.equal(r.status, 200, r.text);
    assert.equal(e.store.findUserByUsername('after.enc'), null);
  } finally { await e.stop(); }
  // Another server with a different key, or none, refuses it.
  for (const env of [{ AGASTYA_BACKUP_KEY: crypto.randomBytes(32).toString('hex') }, {}]) {
    const other = await startServer({ env: { ...env, AGASTYA_BACKUP_DIR: backupDir } });
    try {
      const a = await adminClient(other);
      const v = await a.post(`/api/admin/backups/${id}/verify`);
      assert.equal(v.body.ok, false);
      assert.match(v.body.problems[0], env.AGASTYA_BACKUP_KEY ? /different key/ : /encrypted/);
      const r = await a.post(`/api/admin/backups/${id}/restore`, { confirm: id, password: ADMIN.password, reason: 'Trying with the wrong key.' });
      assert.equal(r.status, 409);
      assert.match(r.body.code, env.AGASTYA_BACKUP_KEY ? /BACKUP_KEY_MISMATCH/ : /BACKUP_KEY_REQUIRED/);
    } finally { await other.stop(); }
  }
});

test('configuration problems are reported and stop backups: a bad key, a bad schedule, a backup folder inside the data', async () => {
  for (const [env, re] of [
    [{ AGASTYA_BACKUP_KEY: 'too-short' }, /AGASTYA_BACKUP_KEY/],
    [{ AGASTYA_BACKUP_SCHEDULE: '25:99' }, /AGASTYA_BACKUP_SCHEDULE/],
  ]) {
    const s = await startServer({ env });
    try {
      const a = await adminClient(s);
      const r = await a.post('/api/admin/backups', {});
      assert.equal(r.body.code, 'BACKUP_NOT_CONFIGURED');
      assert.match(r.body.error, re);
      assert.match((await a.get('/api/admin/health')).body.backup.warnings.join(' '), re);
    } finally { await s.stop(); }
  }
  const dir = tmpdir('agastya-inside-');
  const s = createServer({ dataDir: dir, env: { AGASTYA_BACKUP_DIR: path.join(dir, 'backups') }, log: quietLog });
  assert.match(s.backups.configProblem(), /must not be inside the data folder/);
  s.stop();
});

test('the backup folder check ignores case on Windows, as NTFS does', () => {
  const { foldersOverlap } = require('../server/backup/service');
  const w = path.win32;
  assert.equal(foldersOverlap('d:\\agastya\\DATA\\backups', 'D:\\Agastya\\data', w), true);
  assert.equal(foldersOverlap('D:\\AGASTYA\\DATA', 'd:\\agastya\\data\\', w), true);
  assert.equal(foldersOverlap('D:\\Agastya', 'd:\\agastya\\data', w), true);
  assert.equal(foldersOverlap('E:\\AgastyaBackups', 'D:\\Agastya\\data', w), false);
  assert.equal(foldersOverlap('D:\\Agastya\\data-backups', 'D:\\Agastya\\data', w), false);
  assert.equal(foldersOverlap('E:\\', 'E:\\AgastyaBackups', w), true);
  // POSIX paths keep their case.
  assert.equal(foldersOverlap('/srv/DATA/backups', '/srv/data', path.posix), false);
  assert.equal(foldersOverlap('/srv/data/backups', '/srv/data', path.posix), true);
});

// ---- schedule, health, command line --------------------------------------------------------------

test('the schedule takes one backup per day at the set time, and the health screen reports it', async () => {
  const s = await startServer({ env: { AGASTYA_BACKUP_SCHEDULE: '00:00' } });
  try {
    const a = await adminClient(s);
    let h = (await a.get('/api/admin/health')).body.backup;
    assert.equal(h.schedule, '00:00');
    assert.equal(h.message, 'No backup yet');
    const first = await s.backups.tick();
    assert.equal(first.kind, 'scheduled');
    assert.equal(await s.backups.tick(), null, 'once per scheduled time');
    h = (await a.get('/api/admin/health')).body.backup;
    assert.equal(h.count, 1);
    assert.equal(h.last.id, first.id);
    assert.equal(h.configured, true);
    assert.ok(h.warnings.some((w) => /not encrypted/.test(w)));
    assert.ok(!h.warnings.some((w) => /Scheduled backups are off/.test(w)));
    for (const c of [await makeUser(s, a, { username: 'pm.h', role: 'project_manager' })]) assert.equal((await c.get('/api/admin/health')).status, 403);
  } finally { await s.stop(); }
});

const runCli = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'backup.js'), ...args], { env: { ...process.env, ...env }, timeout: 120000 },
    (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: `${stdout}${stderr}` }));
});

test('the backup command lists and verifies at any time, and creates or restores only with the server stopped', async () => {
  const s = await startServer();
  const env = { AGASTYA_DATA_DIR: s.dataDir, AGASTYA_BACKUP_DIR: s.backupDir };
  try {
    const a = await adminClient(s);
    const b = (await a.post('/api/admin/backups', {})).body.backup;
    let r = await runCli(['list'], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(b.id));
    r = await runCli(['verify', b.id], env);
    assert.match(r.out, /OK/);
    r = await runCli(['create'], env);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /server is running/);
    r = await runCli(['restore', b.id, '--confirm', b.id], env);
    assert.match(r.out, /server is running/);
  } finally { await s.stop(); }
  let r = await runCli(['create', '--note', 'from the command line'], env);
  assert.equal(r.code, 0, r.out);
  const id = /Created (bk-\S+):/.exec(r.out)[1];
  // The note is kept (it was once read only after a backup id, which create has not).
  r = await runCli(['list'], env);
  assert.match(r.out, new RegExp(`${id} .*from the command line`));
  r = await runCli(['restore', id], env);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /--confirm/);
  r = await runCli(['restore', id, '--confirm', id, '--reason', 'drill'], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Restored .* Recovery point/);
  r = await runCli(['list'], env);
  assert.match(r.out, new RegExp(`pre-restore .*Recovery point taken before restoring ${id}`));
  r = await runCli(['verify', 'bk-20260101-000000-abcdef'], env);
  assert.notEqual(r.code, 0);
});


test('a briefly held file (Windows antivirus or indexer) is retried when renaming; a lasting hold still fails', () => {
  const { renameRetry } = require('../server/backup/recovery');
  const dir = tmpdir('agastya-rename-');
  fs.writeFileSync(path.join(dir, 'a'), 'x');
  const orig = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...args) => { calls++; if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return orig(...args); };
  try {
    renameRetry(path.join(dir, 'a'), path.join(dir, 'b'), { sleep: () => {} });
    assert.equal(calls, 3);
    assert.ok(fs.existsSync(path.join(dir, 'b')));
    calls = 0;
    fs.renameSync = () => { calls++; throw Object.assign(new Error('busy'), { code: 'EPERM' }); };
    assert.throws(() => renameRetry(path.join(dir, 'b'), path.join(dir, 'c'), { sleep: () => {}, attempts: 4 }), (e) => e.code === 'EPERM');
    assert.equal(calls, 4);
    calls = 0;
    fs.renameSync = () => { calls++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    assert.throws(() => renameRetry(path.join(dir, 'b'), path.join(dir, 'c'), { sleep: () => {} }), (e) => e.code === 'ENOENT');
    assert.equal(calls, 1, 'other errors are not retried');
  } finally { fs.renameSync = orig; }
});
