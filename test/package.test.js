'use strict';
// CSDB packages over real HTTP (Phase 6, decisions.md CX1 to CX6): export a
// project, check and import the package into another project byte for byte,
// import again (nothing replaced), roles and scope, the administrator's
// override session, the audit trail, and an upload that is not a package.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { startServer, adminClient, makeUser } = require('./helpers');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');
const ICN = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let t, admin, pm, writer, outsider, source, target, pmProject, srcDir, dstDir;

async function upload(c, url, file, headers = {}) {
  const form = new FormData();
  if (file) form.append('file', new Blob([file.data]), file.name);
  const res = await fetch(t.base + url, { method: 'POST', body: form, headers: { cookie: c.cookie, ...headers } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function raw(c, url) {
  const res = await fetch(t.base + url, { headers: { cookie: c.cookie } });
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), buf: Buffer.from(await res.arrayBuffer()) };
}
const audits = (action) => t.store.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action).map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));

test.before(async () => {
  t = await startServer();
  admin = await adminClient(t);
  pm = await makeUser(t, admin, { username: 'pub.lead', role: 'project_manager' });
  writer = await makeUser(t, pm, { username: 'tech.writer', role: 'author' });
  outsider = await makeUser(t, pm, { username: 'other.writer', role: 'author' });
  source = (await writer.post('/api/projects', { name: 'Golden source' })).body.project;
  target = (await writer.post('/api/projects', { name: 'Golden copy' })).body.project;
  pmProject = (await pm.post('/api/projects', { name: 'Managed' })).body.project;
  await pm.post(`/api/projects/${pmProject.id}/members`, { userId: writer.user.id });
  srcDir = path.join(t.dataDir, 'projects', source.id);
  dstDir = path.join(t.dataDir, 'projects', target.id);
  // The golden sample, through the ordinary routes.
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) {
    const r = await writer.post(`/api/projects/${source.id}/dms/import`, { filename: f, content: fs.readFileSync(path.join(GOLDEN, 'csdb', f), 'utf8') });
    assert.equal(r.status, 201, r.text);
  }
  const g = await upload(writer, `/api/projects/${source.id}/graphics`, { data: fs.readFileSync(path.join(GOLDEN, 'csdb', `${ICN}.png`)), name: `${ICN}.png` });
  assert.equal(g.status, 201);
});
test.after(() => t.stop());

let zip;
test('export: the project as a zip of its modules, publication module and graphics, with a manifest; audited as a read', async () => {
  const r = await raw(writer, `/api/projects/${source.id}/package.zip`);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'application/zip');
  assert.match(r.disposition, /attachment; filename="CSDB-Golden_source\.zip"/);
  zip = r.buf;
  const z = await JSZip.loadAsync(zip);
  const manifest = JSON.parse(await z.file('agastya-package.json').async('string'));
  assert.equal(manifest.project, 'Golden source');
  assert.equal(manifest.counts.modules, 9);
  assert.ok(manifest.files.some((f) => f.path === `csdb/${ICN}.png`));
  for (const f of manifest.files) assert.equal(sha(await z.file(f.path).async('nodebuffer')), sha(fs.readFileSync(path.join(srcDir, f.path))), f.path);
  const a = audits('package.exported').pop();
  assert.equal(a.meta.modules, 9);
  // Shown in the audit viewer with its counts.
  const v = (await admin.get('/api/admin/audit?action=package.exported')).body.entries[0];
  assert.equal(v.details.modules, 9);
});

test('preview: every file checked and nothing written', async () => {
  const before = fs.readdirSync(path.join(dstDir, 'csdb'));
  const r = await upload(writer, `/api/projects/${target.id}/package/preview`, { data: zip, name: 'CSDB-Golden_source.zip' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.counts.modules, 9);
  assert.equal(r.body.counts.graphics, 1);
  assert.equal(r.body.manifest.project, 'Golden source');
  const mods = r.body.items.filter((i) => i.kind === 'module');
  assert.ok(mods.every((m) => m.validation && typeof m.validation.errors === 'number'), 'each module validated');
  assert.ok(r.body.items.every((i) => !('_write' in i)));
  assert.equal(r.body.items.find((i) => i.name === 'publication.xml').status, 'ignored');
  assert.deepEqual(fs.readdirSync(path.join(dstDir, 'csdb')), before);
  assert.equal((await writer.get(`/api/projects/${target.id}/dms`)).body.modules.length, 0);
});

test('import: modules through the write path, byte for byte, with revisions; graphics where the build looks', async () => {
  const r = await upload(writer, `/api/projects/${target.id}/package/import`, { data: zip, name: 'CSDB-Golden_source.zip' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.modules.length, 9);
  assert.equal(r.body.graphics.length, 1);
  assert.deepEqual(r.body.failed, []);
  for (const f of fs.readdirSync(path.join(srcDir, 'csdb'))) {
    assert.equal(sha(fs.readFileSync(path.join(dstDir, 'csdb', f))), sha(fs.readFileSync(path.join(srcDir, 'csdb', f))), f);
  }
  const list = (await writer.get(`/api/projects/${target.id}/dms`)).body.modules;
  assert.equal(list.length, 9);
  const revs = (await writer.get(`/api/projects/${target.id}/dms/${list[0].id}/revisions`)).body.revisions;
  assert.equal(revs.length, 1);
  assert.match(revs[0].reason, /Imported from package CSDB-Golden_source\.zip/);
  const g = (await writer.get(`/api/projects/${target.id}/graphics`)).body.graphics.find((x) => x.icn === ICN);
  assert.equal(g.present && g.resolves, true);
  assert.equal(audits('dm.imported').filter((a) => a.project_id === target.id).length, 9);
  const s = audits('package.imported').pop();
  assert.deepEqual([s.meta.modules, s.meta.graphics, s.meta.failed], [9, 1, 0]);
  // The copy validates as the source does.
  const [a, b] = await Promise.all([source, target].map((p) => writer.post(`/api/projects/${p.id}/validate`, {})));
  assert.deepEqual(b.body.counts, a.body.counts);
});

test('importing the same package again replaces nothing', async () => {
  const before = fs.readdirSync(path.join(dstDir, 'csdb')).map((f) => sha(fs.readFileSync(path.join(dstDir, 'csdb', f))));
  const p = await upload(writer, `/api/projects/${target.id}/package/preview`, { data: zip, name: 'p.zip' });
  assert.equal(p.body.counts.import, 0);
  assert.equal(p.body.counts.exists, 10);
  const r = await upload(writer, `/api/projects/${target.id}/package/import`, { data: zip, name: 'p.zip' });
  assert.deepEqual([r.body.modules.length, r.body.graphics.length], [0, 0]);
  assert.deepEqual(fs.readdirSync(path.join(dstDir, 'csdb')).map((f) => sha(fs.readFileSync(path.join(dstDir, 'csdb', f)))), before);
});

test('roles: a Project Manager exports their project but cannot import; an Author outside the project gets 404', async () => {
  assert.equal((await raw(pm, `/api/projects/${pmProject.id}/package.zip`)).status, 200);
  assert.equal((await upload(pm, `/api/projects/${pmProject.id}/package/preview`, { data: zip, name: 'p.zip' })).status, 403);
  assert.equal((await upload(pm, `/api/projects/${pmProject.id}/package/import`, { data: zip, name: 'p.zip' })).status, 403);
  assert.equal((await upload(writer, `/api/projects/${pmProject.id}/package/preview`, { data: zip, name: 'p.zip' })).status, 200, 'a member may');
  assert.equal((await raw(outsider, `/api/projects/${source.id}/package.zip`)).status, 404);
  assert.equal((await upload(outsider, `/api/projects/${source.id}/package/import`, { data: zip, name: 'p.zip' })).status, 404);
  const anon = await fetch(`${t.base}/api/projects/${source.id}/package.zip`);
  assert.equal(anon.status, 401);
});

test('the administrator exports freely, but imports only inside an override session, recorded with its reason', async () => {
  assert.equal((await raw(admin, `/api/projects/${source.id}/package.zip`)).status, 200);
  const no = await upload(admin, `/api/projects/${pmProject.id}/package/import`, { data: zip, name: 'p.zip' });
  assert.equal(no.body.code, 'OVERRIDE_REQUIRED');
  const s = await admin.post(`/api/projects/${pmProject.id}/override-sessions`, { key: 'modules', reason: 'Loading the supplier CSDB delivery' });
  assert.equal(s.status, 201, s.text);
  const r = await upload(admin, `/api/projects/${pmProject.id}/package/import`, { data: zip, name: 'p.zip' }, { 'x-agastya-override-session': s.body.session.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.modules.length, 9);
  const ov = audits('admin.override').filter((a) => a.project_id === pmProject.id);
  assert.ok(ov.length >= 1);
  assert.equal(ov[0].meta.reason, 'Loading the supplier CSDB delivery');
  assert.ok(audits('package.imported').pop().meta.overrideId, 'the summary names the override');
});

test('uploads that are not packages, or carry nothing importable, are answered clearly', async () => {
  assert.equal((await upload(writer, `/api/projects/${target.id}/package/preview`, { data: Buffer.from('plain text'), name: 'x.zip' })).body.code, 'UNREADABLE');
  assert.equal((await upload(writer, `/api/projects/${target.id}/package/preview`, null)).body.code, 'VALIDATION');
  const z = new JSZip();
  z.file('notes.txt', 'hello');
  z.file('bad.xml', '<dmodule><x></dmodule>');
  const r = await upload(writer, `/api/projects/${target.id}/package/import`, { data: await z.generateAsync({ type: 'nodebuffer' }), name: 'x.zip' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.modules.length, r.body.plan.counts.refused, r.body.plan.counts.ignored], [0, 1, 1]);
});
