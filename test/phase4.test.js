'use strict';
// Phase 4, the Software Administrator dashboard (decisions.md V1-V12), over
// real HTTP: every override needs a written reason, is the real thing,
// is recorded and audited as an admin override and is told to the people it
// affects; the administrator still cannot submit; nobody else reaches an
// administrator route; an administrator edit makes a pending request stale
// and the Authors can resubmit; reassignment and stuck requests; the
// administrator's editing sessions (one reason, 30 minutes idle, per
// document); the audit viewer, its filters and an export that carries no
// secret; system health and the session list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, adminClient, makeUser, ADMIN } = require('./helpers');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');
const read = (p) => fs.readFileSync(p, 'utf8');
const REASON = 'Release deadline: manager away, decision needed today.';
const COMMENT = 'Private-override-comment-7731: section 3 needs a figure.';
const SPARE = 'AGS-A-31-00-00-00A-040A-D';

let skew = 0; // moves the server's clock forward (override session idle time)
let t, admin, pm, pm2, author, coauthor, outsider, project, ownProject;
const temps = []; // temporary passwords issued during the run

const audits = (action) => t.store.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action).map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
const lastAudit = (action) => audits(action).pop();
const notes = async (c) => (await c.get('/api/notifications')).body.notifications;
const modules = async (c = author) => (await c.get(`/api/projects/${project.id}/dms`)).body.modules;
const byCode = async (code) => (await modules()).find((m) => m.dmc === code);
const submit = (to = pm) => author.post(`/api/projects/${project.id}/requests`, { approverId: to.user.id });
const OV = 'x-agastya-override-session';

async function startSession(key, reason = REASON, c = admin) {
  return c.post(`/api/projects/${project.id}/override-sessions`, { key, reason });
}
async function saveDm(c, dm, headers = {}, mark = '\n') {
  const g = await c.get(`/api/projects/${project.id}/dms/${dm.id}`);
  return c.raw('PUT', `/api/projects/${project.id}/dms/${dm.id}`, { xml: g.body.xml.replace('</dmodule>', `${mark}</dmodule>`), baseRevision: g.body.revision }, headers);
}
async function upload(c, url, fields, file, headers = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields || {})) form.append(k, v);
  if (file) form.append('file', new Blob([file.data]), file.name);
  const res = await fetch(t.base + url, { method: 'POST', body: form, headers: { cookie: c.cookie, ...headers } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
  t = await startServer({ now: () => new Date(Date.now() + skew) });
  admin = await adminClient(t);
  const create = async (by, spec) => {
    const c = await makeUser(t, by, spec);
    return c;
  };
  pm = await create(admin, { username: 'priya.rao', fullName: 'Priya Rao', role: 'project_manager' });
  pm2 = await create(admin, { username: 'vikram.s', fullName: 'Vikram Shah', role: 'project_manager' });
  author = await create(pm, { username: 'arjun.das', fullName: 'Arjun Das', role: 'author' });
  coauthor = await create(pm, { username: 'meera.iyer', fullName: 'Meera Iyer', role: 'author' });
  outsider = await create(pm2, { username: 'ravi.k', fullName: 'Ravi K', role: 'author' });
  // A temporary password that is never used (it must never appear in the audit output either).
  const pending = await admin.post('/api/users', { username: 'not.yet', fullName: 'Not Yet', role: 'author' });
  temps.push(pending.body.tempPassword);
  project = (await pm.post('/api/projects', { name: 'Hydraulics manual' })).body.project;
  for (const u of [author, coauthor]) assert.equal((await pm.post(`/api/projects/${project.id}/members`, { userId: u.user.id })).status, 201);
  ownProject = (await author.post('/api/projects', { name: '=HYPERLINK("http://x")' })).body.project;

  const ws = path.join(t.dataDir, 'projects', project.id);
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) {
    const r = await author.post(`/api/projects/${project.id}/dms/import`, { filename: f, content: read(path.join(GOLDEN, 'csdb', f)) });
    assert.equal(r.status, 201, r.text);
  }
  const icn = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';
  await upload(author, `/api/projects/${project.id}/graphics`, { icn }, { data: fs.readFileSync(path.join(GOLDEN, 'csdb', `${icn}.png`)), name: 'x.png' });
  for (const m of ['emblem.png', 'publisher-logo.png']) fs.copyFileSync(path.join(GOLDEN, 'Media', m), path.join(ws, 'Media', m));
  const g = await author.get(`/api/projects/${project.id}/publication`);
  await author.raw('PUT', `/api/projects/${project.id}/publication`, { xml: read(path.join(GOLDEN, 'publication.xml')), baseRevision: g.body.revision });
  const r = await author.post(`/api/projects/${project.id}/dms`, { dmc: { modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '31', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: '00', disassyCodeVariant: 'A', infoCode: '040', infoCodeVariant: 'A', itemLocationCode: 'D' }, techName: 'Spare', schemaType: 'descript' });
  assert.equal(r.status, 201, r.text);
});
test.after(() => t.stop());

// ---- 6. the administrator cannot submit; nobody else reaches an administrator route --------

test('the administrator cannot create publication requests, list approvers or keep drafts', async () => {
  const s = await admin.post(`/api/projects/${project.id}/requests`, { approverId: pm.user.id });
  assert.equal(s.status, 403);
  assert.equal(s.body.code, 'FORBIDDEN');
  assert.equal((await admin.get(`/api/projects/${project.id}/approvers`)).body.code, 'FORBIDDEN');
  // Not even inside an override session.
  const sess = (await startSession('publication')).body.session;
  assert.equal((await admin.post(`/api/projects/${project.id}/requests`, { approverId: pm.user.id }, { [OV]: sess.id })).status, 403);
  const dm = await byCode(SPARE);
  assert.equal((await admin.raw('PUT', `/api/projects/${project.id}/drafts/dm-${dm.id}`, { content: 'x' })).body.code, 'FORBIDDEN');
  await admin.post(`/api/override-sessions/${sess.id}/end`);
  assert.equal((await author.get(`/api/projects/${project.id}/approvers`)).status, 200, 'Authors still list approvers');
});

test('Project Managers and Authors cannot reach any administrator route (403), anonymous callers get 401', async () => {
  const routes = t.app.router.stack.filter((l) => l.route && /^\/api\/(admin\/|override-sessions|projects\/:id\/override-sessions|requests\/:reqId\/(override-|reassign))/.test(l.route.path))
    .flatMap((l) => Object.keys(l.route.methods).map((m) => ({ method: m.toUpperCase(), path: l.route.path })));
  assert.ok(routes.length >= 12, `found ${routes.length} administrator routes`);
  const r0 = (await author.get(`/api/projects/${project.id}/requests`)).body.requests[0];
  const anon = t.client();
  for (const r of routes) {
    const url = r.path.replace(':id', project.id).replace(':reqId', r0 ? r0.id : 'x').replace(':sid', 'x');
    const body = r.method === 'GET' ? undefined : { reason: REASON, key: 'modules', outcome: 'approve', comment: 'c', managerId: pm.user.id };
    for (const c of [pm, pm2, author, coauthor]) {
      const res = await c.raw(r.method, url, body);
      assert.equal(res.status, 403, `${c.user.username} ${r.method} ${r.path}: ${res.status} ${res.text}`);
    }
    assert.equal((await anon.raw(r.method, url, body)).status, 401, `anonymous ${r.method} ${r.path}`);
  }
});

// ---- 5a. decision override ---------------------------------------------------------------

test('a decision override without a written reason is refused; the reason is 10 to 1000 characters', async () => {
  const req = (await submit()).body.request;
  assert.ok(req, 'submitted');
  const url = `/api/requests/${req.id}/override-decision`;
  assert.equal((await admin.post(url, { outcome: 'approve', comment: COMMENT })).body.code, 'OVERRIDE_REASON_REQUIRED');
  assert.equal((await admin.post(url, { outcome: 'approve', comment: COMMENT, reason: '  too short ' })).body.code, 'OVERRIDE_REASON_REQUIRED');
  assert.equal((await admin.post(url, { outcome: 'approve', comment: COMMENT, reason: 'x'.repeat(1001) })).body.code, 'OVERRIDE_REASON_REQUIRED');
  assert.equal((await admin.post(url, { outcome: 'approve', reason: REASON })).body.code, 'VALIDATION', 'the comment for the Author is required too');
  assert.equal((await admin.post(`/api/requests/${req.id}/decision`, { outcome: 'approve', comment: COMMENT })).body.code, 'OVERRIDE_REQUIRED', 'the normal path stays closed');
  assert.equal((await t.store.getRequest(req.id)).status, 'pending', 'nothing was decided');
  assert.equal(audits('admin.override').length, 0);
});

test('a decision override is the real decision: labelled, audited with its reason (never the comment), told to Author and manager', async () => {
  const req = (await author.get(`/api/projects/${project.id}/requests`)).body.requests.find((r) => r.status === 'pending');
  const before = (await notes(author)).length;
  const r = await admin.post(`/api/requests/${req.id}/override-decision`, { outcome: 'approve', comment: COMMENT, reason: REASON });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.request.status, 'approved');
  assert.equal(r.body.request.decidedBy.id, admin.user ? admin.user.id : t.store.getAdmin().id);
  assert.deepEqual(r.body.request.override, { by: { id: t.store.getAdmin().id, name: 'Software Administrator' }, reason: REASON });
  // The data modules follow the decision (M3).
  const frozen = (await modules()).filter((m) => m.dmc !== SPARE);
  assert.ok(frozen.every((m) => m.status === 'approved'), JSON.stringify(frozen.map((m) => m.status)));
  // Audited as an admin override, with the reason; the comment only as its length.
  const ov = lastAudit('admin.override');
  assert.equal(ov.meta.kind, 'decision');
  assert.equal(ov.meta.reason, REASON);
  assert.equal(ov.meta.commentLength, COMMENT.length);
  assert.ok(t.store.db.prepare('SELECT * FROM admin_overrides WHERE request_id = ?').get(req.id));
  const decided = lastAudit('request.decided');
  assert.equal(decided.meta.override, true);
  assert.ok(!JSON.stringify(t.store.db.prepare('SELECT * FROM audit_log').all()).includes('Private-override-comment'), 'the comment is not in the audit log');
  // The Author and the manager are told, once, with the reason.
  const an = (await notes(author)).slice(0, (await notes(author)).length - before);
  assert.equal(an.length, 1, JSON.stringify(an));
  assert.match(an[0].title, /Decided by the administrator/);
  assert.match(an[0].body, new RegExp(REASON.slice(0, 20)));
  assert.ok((await notes(pm)).some((n) => /Decided by the administrator/.test(n.title) && n.body.includes(REASON)));
  // Everyone involved sees the reason and the comment; the manager sees the override in the review.
  const seen = (await coauthor.get(`/api/projects/${project.id}/requests`)).body.requests.find((x) => x.id === req.id);
  assert.equal(seen.override.reason, REASON);
  assert.equal(seen.decisionComment, COMMENT);
  const rv = (await pm.get(`/api/requests/${req.id}`)).body;
  assert.equal(rv.request.override.reason, REASON);
  assert.equal(rv.overrides.length, 1);
  assert.equal((await pm2.get(`/api/requests/${req.id}`)).status, 404, 'an uninvolved manager sees nothing');
  // A decided request cannot be overridden again.
  assert.equal((await admin.post(`/api/requests/${req.id}/override-decision`, { outcome: 'reject', comment: 'x', reason: REASON })).body.code, 'NOT_PENDING');
});

test('a decision override still refuses content that changed after submission (the fingerprint check)', async () => {
  const req = (await submit()).body.request;
  const ws = path.join(t.dataDir, 'projects', project.id);
  const f = path.join(ws, 'project.json');
  const orig = read(f);
  fs.writeFileSync(f, orig.replace('{', '{ "x": 1,'));
  const r = await admin.post(`/api/requests/${req.id}/override-decision`, { outcome: 'approve', comment: 'ok', reason: REASON });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'STALE');
  fs.writeFileSync(f, orig);
});

// ---- 5b. reset and the stale path --------------------------------------------------------

test('reset: a reason is required; the request goes stale, the lock lifts, the Authors resubmit', async () => {
  const req = (await submit()).body.request;
  assert.equal(req.status, 'pending');
  const dm = (await modules()).find((m) => m.dmc !== SPARE);
  assert.equal((await saveDm(author, dm)).status, 423, 'locked while pending');
  assert.equal((await admin.post(`/api/requests/${req.id}/override-reset`, {})).body.code, 'OVERRIDE_REASON_REQUIRED');
  const r = await admin.post(`/api/requests/${req.id}/override-reset`, { reason: REASON });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.request.status, 'stale');
  assert.match(r.body.request.staleReason, /reset by the administrator/);
  assert.equal(lastAudit('request.stale').meta.cause, 'admin.reset');
  assert.equal(lastAudit('admin.override').meta.kind, 'reset');
  assert.ok((await notes(author)).some((n) => /reset by the administrator/i.test(n.title) && n.body.includes(REASON)));
  assert.ok((await notes(pm)).some((n) => /reset by the administrator/i.test(n.title)));
  assert.equal((await saveDm(author, dm)).status, 200, 'the lock lifted');
  const again = await submit();
  assert.equal(again.status, 201, again.text);
  assert.equal(again.body.request.previousRequestId, req.id, 'the history continues');
});

test('an administrator edit of a frozen file is refused until accepted, then makes the pending request stale with the reason', async () => {
  const req = (await author.get(`/api/projects/${project.id}/requests`)).body.requests.find((r) => r.status === 'pending');
  const dm = (await modules()).find((m) => m.dmc !== SPARE);
  const sess = (await startSession(`dm-${dm.id}`)).body.session;
  const head = (await admin.get(`/api/projects/${project.id}/dms/${dm.id}`)).body.revision;
  const refused = await saveDm(admin, dm, { [OV]: sess.id });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'OVERRIDE_MAKES_STALE');
  assert.equal(refused.body.lock.requestId, req.id);
  assert.equal((await admin.get(`/api/projects/${project.id}/dms/${dm.id}`)).body.revision, head, 'nothing was written');
  assert.equal(t.store.getRequest(req.id).status, 'pending');

  const ok = await saveDm(admin, dm, { [OV]: sess.id, 'x-agastya-override-stale': 'accept' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const after = t.store.getRequest(req.id);
  assert.equal(after.status, 'stale');
  assert.match(after.stale_reason, /edited by the administrator \(override\): Release deadline/);
  const st = lastAudit('request.stale');
  assert.equal(st.meta.cause, 'admin.override');
  assert.ok(st.meta.overrideId);
  assert.ok((await notes(author)).some((n) => /out of date/i.test(n.title)));
  assert.ok((await notes(pm)).some((n) => /out of date/i.test(n.title)));
  // Unlocked at once; the Author edits and resubmits.
  assert.equal((await saveDm(author, dm)).status, 200);
  assert.equal((await submit()).status, 201);
  await admin.post(`/api/override-sessions/${sess.id}/end`);
});

// ---- 5b. editing sessions ------------------------------------------------------------------

test('content overrides: every write route refuses the administrator without an editing session', async () => {
  const dm = await byCode(SPARE);
  const p = `/api/projects/${project.id}`;
  const json = [
    ['POST', `${p}/dms`, { dmc: { modelIdentCode: 'AGS' }, techName: 'x', schemaType: 'descript' }],
    ['POST', `${p}/dms/import`, { filename: 'x.xml', content: '<dmodule/>' }],
    ['PUT', `${p}/dms/${dm.id}`, { xml: '<dmodule/>', baseRevision: 1 }],
    ['DELETE', `${p}/dms/${dm.id}`, {}],
    ['POST', `${p}/dms/${dm.id}/restore`, {}],
    ['PUT', `${p}/publication`, { xml: '<pm/>', baseRevision: 1 }],
    ['PUT', `${p}/publication/model`, { entries: [], baseRevision: 1 }],
    ['POST', `${p}/publication/import`, { xml: '<pm/>', baseRevision: 1 }],
    ['PUT', `${p}/settings/wording`, { authority: 'x' }],
  ];
  for (const [m, url, b] of json) assert.equal((await admin.raw(m, url, b)).body.code, 'OVERRIDE_REQUIRED', `${m} ${url}`);
  for (const url of [`${p}/graphics`, `${p}/dmrl/preview`, `${p}/dmrl/import`]) {
    assert.equal((await upload(admin, url, {}, { data: Buffer.from('x'), name: 'x.bin' })).body.code, 'OVERRIDE_REQUIRED', url);
  }
});

test('starting an editing session needs a reason and names one document of the project', async () => {
  assert.equal((await startSession('modules', '')).body.code, 'OVERRIDE_REASON_REQUIRED');
  assert.equal((await admin.post(`/api/projects/${project.id}/override-sessions`, { key: 'modules' })).body.code, 'OVERRIDE_REASON_REQUIRED');
  assert.equal((await startSession('../../etc')).status, 400);
  assert.equal((await startSession('dm-00000000-0000-0000-0000-000000000000')).status, 404);
  assert.equal((await author.post(`/api/projects/${project.id}/override-sessions`, { key: 'modules', reason: REASON })).status, 403);
  const s = await startSession('modules');
  assert.equal(s.status, 201);
  assert.equal(lastAudit('override.session.started').meta.reason, REASON);
  await admin.post(`/api/override-sessions/${s.body.session.id}/end`);
});

test('one reason per session: each save is audited separately with it; the people involved are told once', async () => {
  const dm = await byCode(SPARE);
  const why = 'Correcting the title before the audit visit.';
  const sess = (await startSession(`dm-${dm.id}`, why)).body.session;
  const before = { author: (await notes(author)).length, coauthor: (await notes(coauthor)).length, pm: (await notes(pm)).length };
  const overridesBefore = audits('admin.override').length;
  assert.equal((await saveDm(admin, dm, { [OV]: sess.id }, '\n<!-- one -->')).status, 200);
  assert.equal((await saveDm(admin, dm, { [OV]: sess.id }, '\n<!-- two -->')).status, 200);
  const rows = audits('admin.override').slice(overridesBefore);
  assert.equal(rows.length, 2, 'each save is its own override record');
  for (const r of rows) {
    assert.equal(r.meta.kind, 'content');
    assert.equal(r.meta.reason, why);
    assert.equal(r.meta.sessionId, sess.id);
    assert.equal(r.meta.action, 'dm.saved');
  }
  assert.equal(audits('dm.saved').slice(-2).filter((r) => r.meta.overrideId).length, 2);
  const told = async (c, n) => (await notes(c)).slice(0, (await notes(c)).length - n).filter((x) => /Edited by the administrator/.test(x.title));
  for (const [c, key] of [[author, 'author'], [coauthor, 'coauthor'], [pm, 'pm']]) {
    const got = await told(c, before[key]);
    assert.equal(got.length, 1, `${key} told once`);
    assert.ok(got[0].body.includes(why));
  }
  // The session is for this document only; an Author cannot use the header at all.
  const other = (await modules()).find((m) => m.dmc !== SPARE);
  assert.equal((await saveDm(admin, other, { [OV]: sess.id })).body.code, 'OVERRIDE_SESSION_ENDED');
  assert.equal((await saveDm(author, dm, { [OV]: sess.id })).body.code, 'OVERRIDE_NOT_ALLOWED');
  // Leaving the document ends it: a new reason is then required.
  assert.equal((await admin.post(`/api/override-sessions/${sess.id}/end`)).status, 200);
  assert.equal((await saveDm(admin, dm, { [OV]: sess.id })).body.code, 'OVERRIDE_SESSION_ENDED');
});

test('an editing session ends after 30 minutes idle, and with the sign-in it was opened from', async () => {
  const dm = await byCode(SPARE);
  const sess = (await startSession(`dm-${dm.id}`)).body.session;
  assert.equal((await saveDm(admin, dm, { [OV]: sess.id })).status, 200);
  skew += 29 * 60 * 1000;
  assert.equal((await saveDm(admin, dm, { [OV]: sess.id })).status, 200, 'still within 30 minutes of the last save');
  skew += 31 * 60 * 1000;
  assert.equal((await saveDm(admin, dm, { [OV]: sess.id })).body.code, 'OVERRIDE_SESSION_ENDED');
  assert.equal(t.store.getOverrideSession(sess.id).end_reason, 'idle');
  // A session belongs to one sign-in.
  const s2 = (await startSession(`dm-${dm.id}`)).body.session;
  const again = t.client();
  await again.post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password });
  assert.equal((await saveDm(again, dm, { [OV]: s2.id })).body.code, 'OVERRIDE_SESSION_ENDED');
  admin = again;
});

test('override sessions cover uploads and the module list (multipart and DELETE included)', async () => {
  const g = (await startSession('graphics')).body.session;
  const icn = 'ICN-AGS-A-310000-A-0AGS1-00009-A-01-1';
  const up = await upload(admin, `/api/projects/${project.id}/graphics`, { icn }, { data: fs.readFileSync(path.join(GOLDEN, 'Media', 'emblem.png')), name: 'e.png' }, { [OV]: g.id });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(lastAudit('admin.override').meta.action, 'graphic.uploaded');
  const m = (await startSession('modules')).body.session;
  const dm = await byCode(SPARE);
  assert.equal((await admin.raw('DELETE', `/api/projects/${project.id}/dms/${dm.id}`, {}, { [OV]: m.id })).status, 200);
  assert.equal(lastAudit('admin.override').meta.action, 'dm.deleted');
  assert.equal((await admin.post(`/api/projects/${project.id}/dms/${dm.id}/restore`, {}, { [OV]: m.id })).status, 200);
  for (const s of [g, m]) await admin.post(`/api/override-sessions/${s.id}/end`);
});

// ---- 5c. members and reassignment; stuck requests ------------------------------------------

test('assigning an Author as an override is told to the Author and the owner, with the reason', async () => {
  const r = await admin.post(`/api/projects/${project.id}/members`, { userId: outsider.user.id, reason: REASON });
  assert.equal(r.status, 201, r.text);
  assert.equal(lastAudit('admin.override').meta.kind, 'members');
  const n = (await notes(outsider))[0];
  assert.match(n.title, /Assigned to Hydraulics manual by the administrator/);
  assert.ok(n.body.includes(REASON));
  assert.ok((await notes(pm)).some((x) => /by the administrator/.test(x.title) && x.body.includes(REASON)));
  assert.equal((await notes(outsider)).filter((x) => /^Assigned to/.test(x.title)).length, 1, 'told once');
  assert.equal((await admin.raw('DELETE', `/api/projects/${project.id}/members/${outsider.user.id}`, { reason: REASON })).status, 200);
});

test('reassignment: a reason, an active manager; the old manager loses sight, all three are told', async () => {
  const req = (await author.get(`/api/projects/${project.id}/requests`)).body.requests.find((r) => r.status === 'pending');
  const url = `/api/requests/${req.id}/reassign`;
  assert.equal((await admin.post(url, { managerId: pm2.user.id })).body.code, 'OVERRIDE_REASON_REQUIRED');
  assert.equal((await admin.post(url, { managerId: author.user.id, reason: REASON })).body.code, 'APPROVER_INVALID');
  assert.equal((await admin.post(url, { managerId: pm.user.id, reason: REASON })).body.code, 'SAME_MANAGER');
  const r = await admin.post(url, { managerId: pm2.user.id, reason: REASON });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.request.manager.id, pm2.user.id);
  assert.equal((await pm.get(`/api/requests/${req.id}`)).status, 404, 'the previous manager no longer sees it');
  assert.ok((await pm2.get('/api/requests/queue')).body.requests.some((x) => x.id === req.id));
  assert.ok((await notes(pm2)).some((n) => /reassigned/.test(n.title) && n.body.includes(REASON)));
  assert.ok((await notes(pm)).some((n) => /Request reassigned/.test(n.title)));
  assert.ok((await notes(author)).some((n) => /Request reassigned/.test(n.title)));
  assert.equal(lastAudit('request.reassigned').meta.toName, 'Vikram Shah');
});

test('a pending request with a disabled manager is flagged until it is reassigned', async () => {
  const req = (await author.get(`/api/projects/${project.id}/requests`)).body.requests.find((r) => r.status === 'pending');
  assert.equal((await admin.post(`/api/users/${pm2.user.id}/disable`)).status, 200);
  let o = (await admin.get('/api/admin/oversight')).body;
  assert.deepEqual(o.stuck.map((s) => s.id), [req.id]);
  assert.equal(o.managers.find((m) => m.id === pm2.user.id).stuck, true);
  assert.equal((await admin.post(`/api/requests/${req.id}/reassign`, { managerId: pm.user.id, reason: REASON })).status, 200);
  o = (await admin.get('/api/admin/oversight')).body;
  assert.deepEqual(o.stuck, []);
  await admin.post(`/api/users/${pm2.user.id}/enable`);
});

// ---- 1. oversight ------------------------------------------------------------------------------

test('oversight: every project, workload and who is working on what, including Author-owned projects', async () => {
  const o = (await admin.get('/api/admin/oversight')).body;
  const names = o.projects.map((p) => p.name);
  assert.ok(names.includes('Hydraulics manual') && names.includes(ownProject.name));
  const h = o.projects.find((p) => p.id === project.id);
  assert.ok(h.modules.draft + h.modules.in_review + h.modules.approved > 5);
  assert.equal(h.request.status, 'pending');
  const priya = o.managers.find((m) => m.username === 'priya.rao');
  assert.equal(priya.pending, 1);
  assert.ok(priya.decided30d >= 0 && priya.projects === 1 && priya.authorsCreated === 2);
  assert.ok(o.authors.find((a) => a.username === 'arjun.das').projects.owned === 1);
  assert.ok(o.activity.items.some((i) => i.author.name === 'Arjun Das'));
  assert.equal(o.requests.byStatus.pending, 1);
});

// ---- 3. audit log viewer and export ----------------------------------------------------------

test('a failed sign-in for an unknown account keeps no typed name; older rows are redacted on display', async () => {
  const typed = 'Hunter2-Typed-Into-Username';
  await t.client().post('/api/auth/login', { username: typed, password: 'whatever-1' });
  const row = lastAudit('auth.login.failed');
  assert.equal(row.meta.reason, 'unknown-user');
  assert.equal(row.meta.username, undefined, 'not stored');
  // A row written by the earlier code (append-only, so it stays): dropped by the presenter.
  t.store.appendAudit({ at: new Date().toISOString(), action: 'auth.login.failed', ip: '127.0.0.1', meta: { username: 'Legacy-Typed-Password-99', reason: 'unknown-user' } });
  const view = (await admin.get('/api/admin/audit?action=auth.login.failed')).body.entries;
  assert.ok(view.length >= 2);
  assert.ok(!JSON.stringify(view).includes('Legacy-Typed-Password-99'));
  assert.deepEqual(view[0].details, { reason: 'unknown-user' });
});

test('the audit viewer filters by user, action, category, project and date, and pages', async () => {
  const adminId = t.store.getAdmin().id;
  const byUser = (await admin.get(`/api/admin/audit?user=${author.user.id}&limit=200`)).body.entries;
  assert.ok(byUser.length && byUser.every((e) => e.actor.id === author.user.id));
  const ov = (await admin.get('/api/admin/audit?action=admin.override')).body.entries;
  assert.ok(ov.length >= 6 && ov.every((e) => e.action === 'admin.override' && e.actor.id === adminId));
  assert.ok(ov.every((e) => typeof e.details.reason === 'string' && e.details.reason.length >= 10), 'the reason is shown (V2)');
  const req = (await admin.get('/api/admin/audit?category=request')).body.entries;
  assert.ok(req.length && req.every((e) => e.action.startsWith('request.')));
  const inProject = (await admin.get(`/api/admin/audit?project=${project.id}&limit=200`)).body.entries;
  assert.ok(inProject.length && inProject.every((e) => e.project && e.project.id === project.id));
  const today = new Date(Date.now() + skew).toISOString().slice(0, 10);
  assert.ok((await admin.get(`/api/admin/audit?from=${today}&to=${today}`)).body.entries.length > 0);
  assert.equal((await admin.get('/api/admin/audit?from=2001-01-01&to=2001-01-02')).body.entries.length, 0);
  assert.equal((await admin.get('/api/admin/audit?from=yesterday')).status, 400);
  assert.equal((await admin.get('/api/admin/audit?evil=1')).body.code, 'UNKNOWN_FIELD');
  // Keyset paging: two pages, no overlap.
  const p1 = (await admin.get('/api/admin/audit?limit=5')).body;
  const p2 = (await admin.get(`/api/admin/audit?limit=5&before=${p1.next}`)).body;
  assert.equal(p1.entries.length, 5);
  assert.ok(p2.entries.every((e) => e.id < p1.entries[4].id));
  // The decision comment never appears; its length does.
  const decided = (await admin.get('/api/admin/audit?action=request.decided')).body.entries;
  assert.ok(decided.some((e) => e.details.commentLength === COMMENT.length));
  assert.ok(!JSON.stringify(decided).includes('Private-override-comment'));
  assert.ok(!decided.some((e) => 'fingerprint' in e.details), 'no hashes');
});

test('the CSV export holds the filtered rows and no secret: no password, temporary password, token, hash or comment', async () => {
  const res = await fetch(`${t.base}/api/admin/audit.csv`, { headers: { cookie: admin.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="agastya-audit-\d{4}-\d{2}-\d{2}\.csv"/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 byte-order mark, so spreadsheets read the names correctly');
  const csv = bytes.subarray(3).toString('utf8');
  assert.match(csv, /^id,at,actor_username,/);
  assert.ok(csv.split('\r\n').length > 50);
  assert.ok(csv.includes(REASON), 'override reasons are exported (V2)');
  const secrets = [
    ADMIN.bootstrap, ADMIN.password, ...[pm, pm2, author, coauthor, outsider].map((c) => c.password), ...temps,
    ...[admin, pm, pm2, author, coauthor, outsider].map((c) => c.cookie.replace('agastya_session=', '')).filter(Boolean),
    ...t.store.db.prepare('SELECT password_hash FROM users').all().map((u) => u.password_hash),
    ...t.store.db.prepare('SELECT content_fingerprint FROM publication_requests').all().map((r) => r.content_fingerprint),
    COMMENT, 'Private-override-comment', 'Legacy-Typed-Password-99', 'Hunter2-Typed-Into-Username',
  ];
  for (const s of secrets) assert.ok(!csv.includes(s), `the export contains a secret: ${String(s).slice(0, 12)}…`);
  // A value a spreadsheet would run as a formula is neutralised.
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`), 'formula-looking cells are prefixed');
  assert.ok(!/(^|,)"=HYPERLINK/m.test(csv));
  // Filters apply, and the export is itself audited.
  const f = await (await fetch(`${t.base}/api/admin/audit.csv?action=admin.override`, { headers: { cookie: admin.cookie } })).text();
  const lines = f.split('\r\n').filter(Boolean);
  assert.ok(lines.slice(1).every((l) => l.includes('"admin.override"')));
  assert.equal(lastAudit('audit.exported').meta.filters, 'action=admin.override');
  assert.equal((await fetch(`${t.base}/api/admin/audit.csv`, { headers: { cookie: pm.cookie } })).status, 403);
});

// ---- 4. health; 2. sessions --------------------------------------------------------------------

test('system health: the real tool paths and versions, the build queue, storage, and no backup configured', async () => {
  const h = (await admin.get('/api/admin/health')).body;
  const java = h.toolchain.tools.find((x) => x.name === 'Java runtime');
  const xslt = h.toolchain.tools.find((x) => x.name === 'xsltproc');
  for (const tool of [java, xslt]) {
    assert.ok(tool && tool.path && tool.realPath && tool.version, JSON.stringify(tool));
    assert.ok(path.isAbsolute(tool.realPath));
  }
  assert.ok(h.toolchain.checks.length >= 20);
  assert.ok(Array.isArray(h.builds.active));
  assert.ok(h.builds.recent.some((b) => b.kind === 'snapshot' && b.ok));
  assert.ok(h.storage.database.file > 0);
  assert.ok(h.storage.snapshots > 0);
  // Phase 5 fills this in (decisions.md K10): with no schedule and no backup yet it still says so.
  assert.equal(h.backup.configured, false);
  assert.equal(h.backup.last, null);
  assert.equal(h.backup.message, 'No backup configured');
  const again = await admin.post('/api/admin/health/toolchain');
  assert.equal(again.status, 200);
  assert.ok(Date.parse(again.body.toolchain.checkedAt) >= Date.parse(h.toolchain.checkedAt));
});

test('the session list shows every live session and one can be ended', async () => {
  const list = (await admin.get('/api/admin/sessions')).body.sessions;
  const mine = list.find((s) => s.current);
  assert.equal(mine.user.username, 'admin');
  const theirs = list.find((s) => s.user.username === 'meera.iyer');
  assert.ok(theirs && !('token_hash' in theirs) && !('tokenHash' in theirs));
  assert.equal((await admin.post(`/api/sessions/${theirs.id}/revoke`)).status, 200);
  assert.equal((await coauthor.get('/api/auth/me')).status, 401);
});
