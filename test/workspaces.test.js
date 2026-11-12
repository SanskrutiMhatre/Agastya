'use strict';
// Workspaces, folders and the project lifecycle over real HTTP (Phase 6.5,
// decisions.md WS1-WS6): nested folders and their safeguards, projects in a
// folder or none, moves that keep data, members and permissions, and new
// projects from an XML file or a package (valid and invalid).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { startServer, adminClient, makeUser } = require('./helpers');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');
const DM = fs.readFileSync(path.join(GOLDEN, 'csdb', 'DMC-AGS-A-24-00-00-00A-030A-D.xml'), 'utf8');
const ICN = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let t, admin, pm, author, partner, outsider;

async function form(c, url, fields, file) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields || {})) f.append(k, v);
  if (file) f.append('file', new Blob([file.data]), file.name);
  const res = await fetch(t.base + url, { method: 'POST', body: f, headers: { cookie: c.cookie } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const names = async (c) => (await c.get('/api/projects')).body.projects.map((p) => p.name);
const wsList = async (c) => (await c.get('/api/workspaces')).body.workspaces;

test.before(async () => {
  t = await startServer();
  admin = await adminClient(t);
  pm = await makeUser(t, admin, { username: 'priya.rao', role: 'project_manager' });
  author = await makeUser(t, pm, { username: 'arjun.das', role: 'author' });
  partner = await makeUser(t, pm, { username: 'meera.iyer', role: 'author' });
  outsider = await makeUser(t, pm, { username: 'ravi.k', role: 'author' });
});
test.after(() => t.stop());

let ws, manuals, radar;
test('workspaces and nested folders: create, rename, nest, with names unique where they sit', async () => {
  const r = await author.post('/api/workspaces', { name: 'Power systems' });
  assert.equal(r.status, 201, r.text);
  ws = r.body.workspace;
  assert.equal((await author.post('/api/workspaces', { name: 'power SYSTEMS' })).body.code, 'NAME_TAKEN');
  manuals = (await author.post(`/api/workspaces/${ws.id}/folders`, { name: 'Manuals' })).body.folder;
  radar = (await author.post(`/api/workspaces/${ws.id}/folders`, { name: 'Radar', parentId: manuals.id })).body.folder;
  assert.equal(radar.parentId, manuals.id);
  assert.equal((await author.post(`/api/workspaces/${ws.id}/folders`, { name: 'radar', parentId: manuals.id })).body.code, 'NAME_TAKEN');
  assert.equal((await author.post(`/api/workspaces/${ws.id}/folders`, { name: 'Radar' })).status, 201, 'the same name elsewhere is fine');
  assert.equal((await author.raw('PATCH', `/api/folders/${radar.id}`, { name: 'Radar sets' })).status, 200);
  // Not into itself or below itself.
  assert.equal((await author.raw('PATCH', `/api/folders/${manuals.id}`, { parentId: radar.id })).body.code, 'FOLDER_CYCLE');
  assert.equal((await author.raw('PATCH', `/api/folders/${manuals.id}`, { parentId: manuals.id })).body.code, 'FOLDER_CYCLE');
  assert.equal((await author.raw('PATCH', `/api/workspaces/${ws.id}`, { name: 'Power and radar' })).status, 200);
  // Eight levels at most.
  let parent = radar.id;
  for (let i = 0; i < 6; i++) parent = (await author.post(`/api/workspaces/${ws.id}/folders`, { name: `L${i}`, parentId: parent })).body.folder.id;
  assert.equal((await author.post(`/api/workspaces/${ws.id}/folders`, { name: 'too deep', parentId: parent })).body.code, 'TOO_DEEP');
  // A folder from another workspace cannot be the parent.
  const other = (await author.post('/api/workspaces', { name: 'Other' })).body.workspace;
  assert.equal((await author.post(`/api/workspaces/${other.id}/folders`, { name: 'x', parentId: manuals.id })).body.code, 'BAD_FOLDER');
});

let filed, loose;
test('projects are created in a folder, or in no workspace; filing elsewhere needs to own the workspace', async () => {
  const r = await author.post('/api/projects', { name: 'UPS manual', workspaceId: ws.id, folderId: radar.id, members: [partner.user.id] });
  assert.equal(r.status, 201, r.text);
  filed = r.body.project;
  assert.deepEqual([filed.workspaceId, filed.folderId, filed.format], [ws.id, radar.id, 's1000d']);
  const detail = (await author.get(`/api/projects/${filed.id}`)).body;
  assert.equal(detail.authors.length, 1, 'the access chosen at creation');
  assert.equal(detail.placement.folderName, 'Radar sets');
  loose = (await author.post('/api/projects', { name: 'Loose manual' })).body.project;
  assert.equal(loose.workspaceId, null);
  const pmWs = (await pm.post('/api/workspaces', { name: 'Managers' })).body.workspace;
  // Another person's workspace is not disclosed: it reads as one that does not exist.
  assert.equal((await author.post('/api/projects', { name: 'Sneaky', workspaceId: pmWs.id })).body.code, 'NOT_FOUND');
  assert.equal((await author.post('/api/projects', { name: 'Wrong folder', workspaceId: pmWs.id === ws.id ? '' : ws.id, folderId: 'fld-nothere' })).body.code, 'BAD_FOLDER');
  assert.equal((await author.post('/api/projects', { name: 'No such format', format: 'jsg' })).body.code, 'FORMAT_UNAVAILABLE');
  assert.equal((await author.post('/api/projects', { name: 'Bad member', members: [pm.user.id] })).body.code, 'NOT_AN_AUTHOR');
  assert.ok(!(await names(author)).includes('Sneaky'), 'a refused creation leaves no project');
});

test('visibility: a member sees the workspace read-only; an outsider does not see it at all', async () => {
  const seen = (await wsList(partner)).find((w) => w.id === ws.id);
  assert.ok(seen && !seen.canManage);
  assert.deepEqual(seen.projects, [filed.id]);
  assert.equal((await partner.raw('PATCH', `/api/workspaces/${ws.id}`, { name: 'Mine' })).status, 403);
  assert.ok(!(await wsList(outsider)).some((w) => w.id === ws.id));
  assert.equal((await outsider.raw('PATCH', `/api/workspaces/${ws.id}`, { name: 'Mine' })).status, 404);
  assert.equal((await outsider.raw('DELETE', `/api/folders/${manuals.id}`, {})).status, 404);
  assert.ok((await wsList(admin)).some((w) => w.id === ws.id && w.canManage), 'the administrator manages every workspace');
});

test('moving a project keeps its content, revisions, members and permissions', async () => {
  const imp = await author.post(`/api/projects/${filed.id}/dms/import`, { filename: 'a.xml', content: DM });
  assert.equal(imp.status, 201, imp.text);
  const dir = path.join(t.dataDir, 'projects', filed.id);
  const before = { file: sha(fs.readFileSync(path.join(dir, 'csdb', imp.body.module.file))), revs: (await author.get(`/api/projects/${filed.id}/dms/${imp.body.module.id}/revisions`)).body.revisions.length, pj: sha(fs.readFileSync(path.join(dir, 'project.json'))) };
  // Not by a member who does not own it, not into someone else's workspace.
  assert.equal((await partner.post(`/api/projects/${filed.id}/move`, { workspaceId: '', folderId: '' })).status, 403);
  const pmWs = (await wsList(pm)).find((w) => w.name === 'Managers');
  assert.equal((await author.post(`/api/projects/${filed.id}/move`, { workspaceId: pmWs.id })).status, 404);
  // Visible but not owned (a workspace holding a project the author is in): refused as such.
  const shared = (await pm.post('/api/workspaces', { name: 'Shared' })).body.workspace;
  const pmProj = (await pm.post('/api/projects', { name: 'PM filed', workspaceId: shared.id, members: [author.user.id] })).body.project;
  assert.ok(pmProj);
  assert.equal((await author.post(`/api/projects/${filed.id}/move`, { workspaceId: shared.id })).body.code, 'WORKSPACE_FORBIDDEN');
  assert.equal((await author.post(`/api/projects/${filed.id}/move`, { workspaceId: 'ws-nothere' })).status, 404);
  const other = (await wsList(author)).find((w) => w.name === 'Other');
  const m = await author.post(`/api/projects/${filed.id}/move`, { workspaceId: other.id, folderId: '' });
  assert.equal(m.status, 200, m.text);
  const after = (await author.get(`/api/projects/${filed.id}`)).body;
  assert.equal(after.placement.workspaceName, 'Other');
  assert.equal(after.authors.length, 1);
  assert.equal(sha(fs.readFileSync(path.join(dir, 'csdb', imp.body.module.file))), before.file);
  assert.equal(sha(fs.readFileSync(path.join(dir, 'project.json'))), before.pj);
  assert.equal((await author.get(`/api/projects/${filed.id}/dms/${imp.body.module.id}/revisions`)).body.revisions.length, before.revs);
  assert.equal((await partner.get(`/api/projects/${filed.id}/dms`)).status, 200, 'the member still reads it');
  assert.equal((await partner.raw('PUT', `/api/projects/${filed.id}/dms/${imp.body.module.id}`, { xml: DM.replace('</dmodule>', '\n</dmodule>'), baseRevision: (await partner.get(`/api/projects/${filed.id}/dms/${imp.body.module.id}`)).body.revision })).status, 200, 'and still writes it');
  assert.equal((await outsider.get(`/api/projects/${filed.id}`)).status, 404, 'an outsider still cannot see it');
  assert.ok(t.store.db.prepare("SELECT 1 FROM audit_log WHERE action = 'project.moved'").get());
  // Out of every workspace, then back into a folder.
  assert.equal((await author.post(`/api/projects/${filed.id}/move`, { workspaceId: '' })).status, 200);
  assert.equal((await author.post(`/api/projects/${filed.id}/move`, { workspaceId: ws.id, folderId: radar.id })).status, 200);
});

test('deleting a folder moves its projects and folders up; deleting a workspace unfiles its projects', async () => {
  const del = await author.raw('DELETE', `/api/folders/${radar.id}`, {});
  assert.equal(del.status, 200);
  assert.equal(del.body.movedUp.projects, 1);
  assert.equal((await author.get(`/api/projects/${filed.id}`)).body.project.folderId, manuals.id);
  assert.equal((await author.raw('DELETE', `/api/workspaces/${ws.id}`, { confirm: 'wrong' })).body.code, 'CONFIRM_MISMATCH');
  const w = await author.raw('DELETE', `/api/workspaces/${ws.id}`, { confirm: 'power and radar' });
  assert.equal(w.status, 200, w.text);
  assert.equal(w.body.unfiled, 1);
  const p = (await author.get(`/api/projects/${filed.id}`)).body;
  assert.deepEqual([p.project.workspaceId, p.project.folderId], [null, null]);
  assert.equal((await author.get(`/api/projects/${filed.id}/dms`)).body.modules.length, 1, 'nothing deleted');
});

test('a project from one XML file: a data module, a publication module or a JSS book; refused files create nothing', async () => {
  const dm = await form(author, '/api/projects/from-xml', { name: 'From a module', format: 's1000d', members: partner.user.id }, { data: DM, name: 'DMC-x.xml' });
  assert.equal(dm.status, 201, JSON.stringify(dm.body));
  assert.equal(dm.body.imported.module.dmc, 'AGS-A-24-00-00-00A-030A-D');
  const book = '<?xml version="1.0" encoding="UTF-8"?>\n<jssbook><bookmeta><bookName>Pump manual</bookName></bookmeta><body><chapter number="1"><title>Pump</title><section><title>General</title><para>The pump.</para></section></chapter></body></jssbook>\n';
  const jss = await form(author, '/api/projects/from-xml', { name: 'Pump book', format: 'jss' }, { data: book, name: 'book.xml' });
  assert.equal(jss.status, 201, JSON.stringify(jss.body));
  assert.equal(jss.body.project.format, 'jss');
  const pub = fs.readFileSync(path.join(t.dataDir, 'projects', jss.body.project.id, 'publication.xml'), 'utf8');
  assert.equal(pub, book, 'the book stored byte for byte');
  assert.equal((await author.post(`/api/projects/${jss.body.project.id}/dms/import`, { filename: 'a.xml', content: DM })).body.code, 'FORMAT_HAS_NO_MODULES');
  assert.equal((await author.get(`/api/projects/${jss.body.project.id}`)).body.formatInfo.capabilities.dataModules, false);
  // Refused, and no project left behind.
  const before = (await names(author)).length;
  assert.equal((await form(author, '/api/projects/from-xml', { name: 'Mismatch', format: 'jss' }, { data: DM, name: 'a.xml' })).body.code, 'FORMAT_MISMATCH');
  assert.equal((await form(author, '/api/projects/from-xml', { name: 'Unknown', format: 's1000d' }, { data: '<notes/>', name: 'a.xml' })).body.code, 'UNKNOWN_FORMAT');
  assert.equal((await form(author, '/api/projects/from-xml', { name: 'Broken' }, { data: '<dmodule><x></dmodule>', name: 'a.xml' })).body.code, 'NOT_WELL_FORMED');
  assert.equal((await form(author, '/api/projects/from-xml', { name: 'JSG one', format: 'jsg' }, { data: book, name: 'a.xml' })).body.code, 'FORMAT_UNAVAILABLE');
  assert.equal((await form(author, '/api/projects/from-xml', { name: 'Taken', format: 's1000d' }, { data: DM, name: 'a.xml' })).status, 201);
  assert.equal((await form(author, '/api/projects/from-xml', { name: 'taken', format: 's1000d' }, { data: DM, name: 'a.xml' })).body.code, 'NAME_TAKEN');
  assert.equal((await names(author)).length, before + 1);
  // A Project Manager creates empty projects only (D2).
  assert.equal((await form(pm, '/api/projects/from-xml', { name: 'PM import' }, { data: DM, name: 'a.xml' })).status, 403);
});

test('a project from a package: modules, graphics, branding, publication and checked settings; invalid packages create nothing', async () => {
  const src = (await author.post('/api/projects', { name: 'Golden source' })).body.project;
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) {
    await author.post(`/api/projects/${src.id}/dms/import`, { filename: f, content: fs.readFileSync(path.join(GOLDEN, 'csdb', f), 'utf8') });
  }
  await form(author, `/api/projects/${src.id}/graphics`, {}, { data: fs.readFileSync(path.join(GOLDEN, 'csdb', `${ICN}.png`)), name: `${ICN}.png` });
  const srcDir = path.join(t.dataDir, 'projects', src.id);
  const g = await author.get(`/api/projects/${src.id}/publication`);
  assert.equal((await author.raw('PUT', `/api/projects/${src.id}/publication`, { xml: fs.readFileSync(path.join(GOLDEN, 'publication.xml'), 'utf8'), baseRevision: g.body.revision })).status, 200);
  const pj = JSON.parse(fs.readFileSync(path.join(srcDir, 'project.json'), 'utf8'));
  pj.publication.publicationNo = 'PUB-0042';
  pj.input = { pm: '../../etc/passwd' }; // never taken from a package
  for (const f of ['emblem.png', 'publisher-logo.png']) fs.copyFileSync(path.join(GOLDEN, 'Media', f), path.join(srcDir, 'Media', f));
  fs.writeFileSync(path.join(srcDir, 'project.json'), JSON.stringify(pj));
  const zip = Buffer.from(await (await fetch(`${t.base}/api/projects/${src.id}/package.zip`, { headers: { cookie: author.cookie } })).arrayBuffer());

  const r = await form(author, '/api/projects/from-package', { name: 'Golden copy', format: 's1000d' }, { data: zip, name: 'CSDB.zip' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.modules.length, 9);
  assert.equal(r.body.graphics.length, 1);
  assert.equal(r.body.publication, true);
  assert.ok(r.body.settings.applied.includes('identity'));
  const dst = path.join(t.dataDir, 'projects', r.body.project.id);
  assert.equal(sha(fs.readFileSync(path.join(dst, 'publication.xml'))), sha(fs.readFileSync(path.join(srcDir, 'publication.xml'))));
  const npj = JSON.parse(fs.readFileSync(path.join(dst, 'project.json'), 'utf8'));
  assert.equal(npj.publication.publicationNo, 'PUB-0042');
  assert.equal(npj.input.pm, 'publication.xml', 'the build paths stay the project’s own');
  assert.ok(fs.existsSync(path.join(dst, 'Media', 'emblem.png')), 'branding came too');

  const before = (await names(author)).length;
  assert.equal((await form(author, '/api/projects/from-package', { name: 'Not a zip' }, { data: Buffer.from('nope'), name: 'x.zip' })).body.code, 'UNREADABLE');
  const z = new JSZip(); z.file('readme.txt', 'hi'); z.file('../evil.xml', DM);
  const empty = await form(author, '/api/projects/from-package', { name: 'Nothing here' }, { data: await z.generateAsync({ type: 'nodebuffer' }), name: 'x.zip' });
  assert.equal(empty.body.code, 'NOTHING_TO_IMPORT');
  assert.equal((await form(author, '/api/projects/from-package', { name: 'Wrong kind', format: 'jss' }, { data: zip, name: 'x.zip' })).body.code, 'FORMAT_MISMATCH');
  assert.equal((await names(author)).length, before, 'no project left behind');
  assert.equal((await form(pm, '/api/projects/from-package', { name: 'PM package' }, { data: zip, name: 'x.zip' })).status, 403);
});
