'use strict';
/*
  END-TO-END SECURITY REGRESSION (Phase 1, extended through Phase 4).

  Starts the REAL server (node server/server.js) as a child process with its
  own throwaway data directory and an OS-assigned port, drives it over HTTP
  as each role, and finally searches everything the server printed for any
  credential it was given or issued (passwords, temporary passwords, session
  tokens, hashes). Exits non-zero on any failed assertion or any leak.

  Run: npm run test:security
*/

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; process.stdout.write('.'); } else { failures.push(msg); process.stdout.write('X'); }
}
const eq = (a, b, msg) => ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agastya-sec-'));
const YEAR = new Date().getFullYear();
const SECRETS = new Set(['Bootstrap-Temp-91', 'Granite-Harbour-42', 'Marigold-River-7', 'Tangerine-Harbour-3', 'Lantern-Fjord-58']);
const TOKENS = new Set();
const DECISION_COMMENT = 'Private-review-comment-5521: please rework section 2.';

let serverOut = '';
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server', 'server.js')], {
      env: {
        ...process.env,
        PORT: '0', HOST: '127.0.0.1', AGASTYA_DATA_DIR: DATA,
        AGASTYA_INITIAL_ADMIN_USERNAME: 'admin', AGASTYA_INITIAL_ADMIN_PASSWORD: 'Bootstrap-Temp-91',
        // Legacy-style bypass variables must have no effect.
        AGASTYA_AUTH_DISABLED: '1', AUTH_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (d) => {
      serverOut += d.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(serverOut);
      if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}` });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { serverOut += d.toString(); });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}):\n${serverOut}`)));
    setTimeout(() => reject(new Error('server did not start in time')), 20000);
  });
}

function client(base) {
  let cookie = '';
  async function req(method, url, body, headers = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /agastya_session=([^;]*)/.exec(set);
      if (m) { cookie = m[1] ? `agastya_session=${m[1]}` : ''; if (m[1]) TOKENS.add(m[1]); }
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  return {
    get: (u, h) => req('GET', u, undefined, h),
    post: (u, b = {}, h) => req('POST', u, b, h),
    patch: (u, b, h) => req('PATCH', u, b, h),
    raw: req,
    get cookie() { return cookie; },
  };
}

async function main() {
  const { child, base } = await startServer();
  const anon = client(base);
  try {
    // ---- health and headers --------------------------------------------
    const h = await anon.get('/api/health');
    eq(h.status, 200, 'health answers');
    eq(h.headers.get('x-frame-options'), 'DENY', 'X-Frame-Options');
    ok(/default-src 'self'/.test(h.headers.get('content-security-policy') || ''), 'CSP present');
    eq(h.headers.get('access-control-allow-origin'), null, 'no CORS reflection');

    // ---- bypass switches have no effect ----------------------------------
    eq((await anon.get('/api/users')).status, 401, 'AUTH_DISABLED env does nothing: users needs a session');
    eq((await anon.get('/api/dashboard/admin')).status, 401, 'dashboard needs a session');

    // ---- bootstrap admin + forced change ----------------------------------
    const admin = client(base);
    let r = await admin.post('/api/auth/login', { username: 'admin', password: 'Bootstrap-Temp-91' });
    eq(r.status, 200, 'bootstrap admin signs in');
    const sc = r.headers.get('set-cookie') || '';
    ok(/HttpOnly/.test(sc) && /SameSite=Lax/.test(sc), 'cookie is HttpOnly + SameSite=Lax');
    ok(!/agastya_session/.test(JSON.stringify(r.body)), 'token never in a response body');
    eq(r.body.gates.mustChangePassword, true, 'bootstrap password must be changed');
    eq((await admin.get('/api/users')).body.code, 'PASSWORD_CHANGE_REQUIRED', 'gate blocks admin work');
    eq((await admin.post('/api/auth/change-password', { newPassword: 'Granite-Harbour-42' })).status, 200, 'admin changes password');
    eq((await client(base).post('/api/auth/login', { username: 'admin', password: 'Bootstrap-Temp-91' })).status, 401, 'bootstrap password no longer works');

    // ---- account creation hierarchy --------------------------------------
    r = await admin.post('/api/users', { username: 'priya', fullName: 'Priya Rao', role: 'project_manager' });
    eq(r.status, 201, 'admin creates a Project Manager');
    eq(r.body.tempPassword, `priya@${YEAR}`, 'temporary password is username@year');
    SECRETS.add(r.body.tempPassword);
    const pmId = r.body.user.id;
    const pm = client(base);
    eq((await pm.post('/api/auth/login', { username: 'priya', password: r.body.tempPassword })).body.gates.onboarding, true, 'PM must onboard');
    eq((await pm.get('/api/dashboard/manager')).body.code, 'ONBOARDING_REQUIRED', 'onboarding gate blocks');
    eq((await pm.post('/api/auth/onboarding', { fullName: 'Priya Rao', newPassword: 'Marigold-River-7' })).status, 200, 'PM onboards');
    eq((await client(base).post('/api/auth/login', { username: 'priya', password: `priya@${YEAR}` })).status, 401, 'temporary password is dead after onboarding');

    r = await pm.post('/api/users', { username: 'arjun', fullName: 'Arjun Das', role: 'author' });
    eq(r.status, 201, 'PM creates an Author');
    SECRETS.add(r.body.tempPassword);
    const arjunId = r.body.user.id;
    const author = client(base);
    await author.post('/api/auth/login', { username: 'arjun', password: r.body.tempPassword });
    eq((await author.post('/api/auth/onboarding', { fullName: 'Arjun Das', newPassword: 'Tangerine-Harbour-3' })).status, 200, 'Author onboards');

    eq((await author.post('/api/users', { username: 'x1x', fullName: 'X', role: 'author' })).status, 403, 'Author cannot create anyone');
    eq((await pm.post('/api/users', { username: 'pm2x', fullName: 'X', role: 'project_manager' })).status, 403, 'PM cannot create a PM');
    eq((await pm.post('/api/users', { username: 'adm2', fullName: 'X', role: 'software_admin' })).status, 403, 'PM cannot create an admin');
    eq((await admin.post('/api/users', { username: 'adm2', fullName: 'X', role: 'software_admin' })).status, 403, 'admin cannot create a second admin');
    eq((await admin.patch(`/api/users/${arjunId}`, { role: 'software_admin' })).status, 403, 'nobody can be promoted to admin');
    eq((await pm.patch(`/api/users/${arjunId}`, { role: 'project_manager' })).status, 403, 'PM cannot change roles');
    const dash = (await admin.get('/api/dashboard/admin')).body;
    eq(dash.users.software_admin.active + dash.users.software_admin.disabled, 1, 'exactly one Software Administrator');

    // ---- no self-registration --------------------------------------------
    for (const url of ['/api/auth/register', '/api/register', '/api/auth/signup', '/api/auth/setup']) {
      eq((await anon.post(url, { username: 'mallory', password: 'Mallory-Pass-1' })).status, 404, `${url} does not exist`);
    }
    eq((await anon.post('/api/users', { username: 'mallory', fullName: 'M', role: 'author' })).status, 401, 'user creation needs a session');

    // ---- cross-role and scope ---------------------------------------------
    eq((await author.get('/api/dashboard/admin')).status, 403, 'Author cannot see the admin dashboard');
    eq((await author.get('/api/dashboard/manager')).status, 403, 'Author cannot see the PM dashboard');
    eq((await pm.get('/api/dashboard/admin')).status, 403, 'PM cannot see the admin dashboard');
    eq((await admin.get('/api/dashboard/author')).status, 403, 'admin sees only the admin dashboard');
    eq((await author.get('/api/users')).status, 403, 'Author has no user directory');

    r = await admin.post('/api/users', { username: 'kavya', fullName: 'Kavya Nair', role: 'project_manager' });
    SECRETS.add(r.body.tempPassword);
    const pm2 = client(base);
    await pm2.post('/api/auth/login', { username: 'kavya', password: r.body.tempPassword });
    await pm2.post('/api/auth/onboarding', { fullName: 'Kavya Nair', newPassword: 'Lantern-Fjord-58' });
    eq((await pm2.get(`/api/users/${arjunId}`)).status, 404, 'another PM\'s Author is not disclosed');
    eq((await pm2.post(`/api/users/${arjunId}/reset`)).status, 404, 'another PM cannot reset that Author');

    const proj = (await pm.post('/api/projects', { name: 'Sonar Handbook' })).body.project;
    eq((await author.get(`/api/projects/${proj.id}`)).status, 404, 'non-member gets 404');
    eq((await pm2.get(`/api/projects/${proj.id}`)).status, 404, 'other PM gets 404');
    eq((await pm.post(`/api/projects/${proj.id}/members`, { userId: arjunId })).status, 201, 'PM assigns the Author');
    eq((await author.get(`/api/projects/${proj.id}`)).status, 200, 'member can read');

    // ---- Author-owned projects ----------------------------------------------
    r = await author.post('/api/projects', { name: 'Arjun Field Notes' });
    eq(r.status, 201, 'an Author creates a project');
    const ownProj = r.body.project;
    eq(ownProj.owner.id, arjunId, 'the Author owns it');
    eq((await pm.get(`/api/projects/${ownProj.id}`)).status, 404, 'the Author\'s own manager cannot see it');
    eq((await pm2.get(`/api/projects/${ownProj.id}`)).status, 404, 'another manager cannot see it');
    eq((await author.post(`/api/projects/${ownProj.id}/members`, { userId: arjunId })).body.code, 'ALREADY_OWNER', 'the owning Author manages members, but cannot add themselves');
    eq((await pm.post(`/api/projects/${ownProj.id}/members`, { userId: arjunId })).status, 404, 'a manager cannot assign to a project they cannot see');
    eq((await admin.post(`/api/projects/${ownProj.id}/members`, { userId: arjunId, reason: 'Checking the owner rule as an override.' })).body.code, 'ALREADY_OWNER', 'the owner is not added as a member');
    eq((await admin.post('/api/projects', { name: 'Admin Project' })).status, 403, 'the administrator does not create projects');

    // ---- content (checkpoint 2a) ---------------------------------------------
    const DMC = { modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '24', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: '00', disassyCodeVariant: 'A', infoCode: '040', infoCodeVariant: 'A', itemLocationCode: 'D' };
    r = await author.post(`/api/projects/${ownProj.id}/dms`, { dmc: DMC, techName: 'Sec test', schemaType: 'descript' });
    eq(r.status, 201, 'owner Author creates a data module');
    const dmId = r.body.module.id;
    const got = await author.get(`/api/projects/${ownProj.id}/dms/${dmId}`);
    const xxe = got.body.xml.replace('<dmodule', '<!DOCTYPE dmodule [<!ENTITY x SYSTEM "file:///C:/Windows/win.ini">]>\n<dmodule').replace('<description></description>', '<description><levelledPara><title>X</title><para>&x;</para></levelledPara></description>');
    eq((await author.raw('PUT', `/api/projects/${ownProj.id}/dms/${dmId}`, { xml: xxe, baseRevision: got.body.revision })).body.code, 'XML_REFUSED', 'XXE save refused');
    eq((await author.post(`/api/projects/${ownProj.id}/dms/import`, { content: xxe })).body.code, 'XML_REFUSED', 'XXE import refused');
    eq((await author.raw('PUT', `/api/projects/${ownProj.id}/dms/${dmId}`, { xml: got.body.xml + got.body.xml, baseRevision: got.body.revision })).body.code, 'DOCUMENT_DOUBLED', 'doubled document refused');
    eq((await author.post(`/api/projects/${ownProj.id}/dms`, { dmc: { ...DMC, modelIdentCode: '..\\..' }, techName: 'x', schemaType: 'descript' })).status, 400, 'hostile code refused');
    const stale = await author.raw('PUT', `/api/projects/${ownProj.id}/dms/${dmId}`, { xml: got.body.xml, baseRevision: got.body.revision + 1000 });
    eq(stale.status, 409, 'stale save is a conflict');
    eq((await pm2.get(`/api/projects/${ownProj.id}/dms`)).status, 404, 'non-member manager cannot list content');
    eq((await pm2.get(`/api/projects/${ownProj.id}/dms/${dmId}`)).status, 404, 'non-member manager cannot read a data module');
    eq((await anon.get(`/api/projects/${ownProj.id}/dms/${dmId}`)).status, 401, 'anonymous cannot read content');
    eq((await admin.post(`/api/projects/${ownProj.id}/dms`, { dmc: { ...DMC, infoCode: '041' }, techName: 'x', schemaType: 'descript' })).body.code, 'OVERRIDE_REQUIRED', 'admin content writes need an override');
    eq((await author.get(`/api/projects/${ownProj.id}/graphics/..%2F..%2Fproject.json/file`)).status, 400, 'graphic path traversal refused');
    const v = await author.post(`/api/projects/${ownProj.id}/dms/${dmId}/validate`, {});
    ok(v.status === 200 && !/[A-Z]:\\|\/Users\/|node_modules/.test(v.text), 'validation output carries no internal paths');
    // Added before checkpoint 2b (Agastya comparison): reference data, wording settings, next ICN, publication guards.
    eq((await anon.get('/api/reference-data')).status, 401, 'reference data needs a session');
    eq((await author.get('/api/reference-data')).status, 200, 'reference data for signed-in users');
    eq((await pm2.get(`/api/projects/${ownProj.id}/settings/wording`)).status, 404, 'non-member cannot read wording settings');
    eq((await author.raw('PUT', `/api/projects/${ownProj.id}/settings/wording`, { authority: 'x', templateRef: 'y' })).body.code, 'UNKNOWN_FIELD', 'wording settings reject unknown fields');
    eq((await admin.raw('PUT', `/api/projects/${ownProj.id}/settings/wording`, { authority: 'x' })).body.code, 'OVERRIDE_REQUIRED', 'admin wording writes need an override');
    eq((await pm2.get(`/api/projects/${ownProj.id}/graphics/next-icn`)).status, 404, 'non-member cannot ask for an ICN');
    const pmDoc = await author.get(`/api/projects/${ownProj.id}/publication`);
    const xxePm = pmDoc.body.xml.replace('<pm ', '<!DOCTYPE pm [<!ENTITY x SYSTEM "file:///C:/Windows/win.ini">]>\n<pm ').replace('<content>', '<content><pmEntry><pmEntryTitle>&x;</pmEntryTitle></pmEntry>');
    eq((await author.raw('PUT', `/api/projects/${ownProj.id}/publication`, { xml: xxePm, baseRevision: pmDoc.body.revision })).body.code, 'XML_REFUSED', 'XXE in the publication module refused');
    eq((await author.raw('PUT', `/api/projects/${ownProj.id}/publication`, { xml: pmDoc.body.xml, baseRevision: pmDoc.body.revision })).body.code, 'EMPTY_PUBLICATION', 'empty publication refused by default');

    // ---- checkpoint 2b: WebSocket, XInclude, builder, drafts, requests -------
    const host = new URL(base).host;
    const wsStatus = (cookie, query, origin = `http://${host}`) => new Promise((resolve) => {
      const s = new WebSocket(`ws://${host}/ws${query}`, { headers: { cookie: cookie || '', origin } });
      s.on('open', () => { s.close(); resolve(101); });
      s.on('unexpected-response', (rq, rs) => resolve(rs.statusCode));
      s.on('error', () => resolve(0));
    });
    eq(await wsStatus('', `?project=${ownProj.id}`), 401, 'WebSocket without a session refused');
    eq(await wsStatus(author.cookie, `?project=${ownProj.id}`, 'http://evil.example'), 403, 'cross-site WebSocket refused');
    eq(await wsStatus(pm2.cookie, `?project=${ownProj.id}`), 404, 'WebSocket for a project the user cannot see is a 404');
    eq(await wsStatus(author.cookie, `?project=${ownProj.id}&x=1`), 404, 'WebSocket with extra parameters refused');
    eq(await wsStatus(author.cookie, `?project=${ownProj.id}`), 101, 'WebSocket for an own project accepted');
    const dmXml = (await author.get(`/api/projects/${ownProj.id}/dms/${dmId}`)).body;
    const xi = dmXml.xml.replace('<dmodule ', '<dmodule xmlns:xi="http://www.w3.org/2001/XInclude" ').replace('<description></description>', '<description><xi:include href="../../agastya.db" parse="text"/></description>');
    eq((await author.raw('PUT', `/api/projects/${ownProj.id}/dms/${dmId}`, { xml: xi, baseRevision: dmXml.revision })).body.code, 'XML_REFUSED', 'XInclude in a data module refused');
    eq((await author.post(`/api/projects/${ownProj.id}/dms/import`, { content: xi })).body.code, 'XML_REFUSED', 'XInclude in an imported module refused');
    const pmModel = await author.get(`/api/projects/${ownProj.id}/publication/model`);
    eq((await author.raw('PUT', `/api/projects/${ownProj.id}/publication/model`, { entries: [{ type: 'include', href: 'file:///C:/Windows/win.ini' }], baseRevision: pmModel.body.revision })).body.code, 'XML_REFUSED', 'builder include outside csdb refused');
    eq((await author.raw('PUT', `/api/projects/${ownProj.id}/publication/model`, { entries: [{ type: 'folder', title: 'x', children: [], owner_id: 'x' }], baseRevision: pmModel.body.revision })).body.code, 'VALIDATION', 'builder rejects unknown entry fields');
    eq((await pm2.get(`/api/projects/${ownProj.id}/publication/model`)).status, 404, 'builder model hidden from non-members');
    eq((await author.raw('PUT', `/api/projects/${ownProj.id}/drafts/..%2F..%2Fsecret`, { content: 'x' })).status, 404, 'draft key traversal refused');
    eq((await pm2.raw('PUT', `/api/projects/${ownProj.id}/drafts/publication`, { content: 'x' })).status, 404, 'drafts are for writers of the project only');
    eq((await admin.post(`/api/projects/${ownProj.id}/requests`, { approverId: 'x' })).status, 403, 'the administrator cannot submit requests');
    eq((await pm2.post(`/api/projects/${ownProj.id}/requests`, { approverId: 'x' })).status, 404, 'a non-member cannot submit');
    eq((await anon.get('/api/requests/mine')).status, 401, 'request list needs a session');
    eq((await author.get('/api/requests/00000000-0000-0000-0000-000000000000')).status, 404, 'unknown request is a 404');

    // ---- the content lock (before 2c) ------------------------------------------
    const pool = (await author.get(`/api/projects/${ownProj.id}/publication/model`)).body;
    const placed = pool.pool.find((m) => m.id === dmId);
    r = await author.raw('PUT', `/api/projects/${ownProj.id}/publication/model`, { entries: [{ type: 'folder', title: 'Chapter', children: [{ type: 'dm', dmCode: placed.dmCode }] }], baseRevision: pool.revision });
    eq(r.status, 200, 'publication set up for the lock checks');
    r = await author.post(`/api/projects/${ownProj.id}/requests`, { approverId: pmId });
    eq(r.status, 201, 'request submitted for the lock checks');
    const lockedReq = r.body && r.body.request;
    const cur = await author.get(`/api/projects/${ownProj.id}/dms/${dmId}`);
    const lockedSave = await author.raw('PUT', `/api/projects/${ownProj.id}/dms/${dmId}`, { xml: cur.body.xml, baseRevision: cur.body.revision });
    eq(lockedSave.status, 423, 'a locked data module refuses the save');
    eq(lockedSave.body.code, 'LOCKED_PENDING_APPROVAL', 'with the lock code');
    ok(!/[A-Z]:\\|\/Users\/|snapshots/.test(lockedSave.text), 'the lock error carries no server paths');
    eq((await author.raw('DELETE', `/api/projects/${ownProj.id}/dms/${dmId}`)).status, 423, 'a locked data module cannot be deleted');
    const lockedModel = await author.get(`/api/projects/${ownProj.id}/publication/model`);
    eq((await author.raw('PUT', `/api/projects/${ownProj.id}/publication/model`, { entries: lockedModel.body.entries, baseRevision: lockedModel.body.revision })).status, 423, 'a locked publication module refuses the save');
    const lockedPm = await pm2.raw('PUT', `/api/projects/${ownProj.id}/dms/${dmId}`, { xml: cur.body.xml, baseRevision: cur.body.revision });
    eq(lockedPm.status, 404, 'a non-member gets 404, not the lock');
    eq((await anon.raw('PUT', `/api/projects/${ownProj.id}/dms/${dmId}`, { xml: cur.body.xml, baseRevision: cur.body.revision })).status, 401, 'anonymous gets 401, not the lock');
    eq((await admin.raw('PUT', `/api/projects/${ownProj.id}/dms/${dmId}`, { xml: cur.body.xml, baseRevision: cur.body.revision })).body.code, 'OVERRIDE_REQUIRED', 'the administrator is exempt from the lock but needs the override');
    eq((await author.post(`/api/requests/${lockedReq.id}/withdraw`)).status, 200, 'withdraw');
    eq((await author.raw('PUT', `/api/projects/${ownProj.id}/dms/${dmId}`, { xml: cur.body.xml, baseRevision: cur.body.revision })).status, 200, 'withdrawing lifts the lock');

    // ---- Phase 3: approvals queue, review and decisions ----------------------
    r = await author.post(`/api/projects/${ownProj.id}/requests`, { approverId: pmId });
    eq(r.status, 201, 'request submitted for the decision checks');
    const dreq = r.body && r.body.request;
    eq((await anon.get('/api/requests/queue')).status, 401, 'the queue needs a session');
    eq((await author.get('/api/requests/queue')).status, 403, 'Authors have no approvals queue');
    eq((await pm2.get('/api/requests/queue')).body.requests.length, 0, 'another manager\'s queue is empty');
    eq((await pm2.get(`/api/requests/${dreq.id}`)).status, 404, 'another manager cannot open the review');
    eq((await pm2.get(`/api/requests/${dreq.id}/source?rel=publication.xml`)).status, 404, 'another manager cannot read a frozen source');
    eq((await pm2.post(`/api/requests/${dreq.id}/decision`, { outcome: 'approve', comment: 'x' })).status, 404, 'another manager cannot decide');
    eq((await author.post(`/api/requests/${dreq.id}/decision`, { outcome: 'approve', comment: 'x' })).status, 403, 'the submitter cannot decide');
    eq((await admin.post(`/api/requests/${dreq.id}/decision`, { outcome: 'approve', comment: 'x' })).body.code, 'OVERRIDE_REQUIRED', 'the administrator\'s decision is a Phase 4 override');
    eq((await pm.post(`/api/requests/${dreq.id}/decision`, { outcome: 'approve' })).status, 400, 'a decision without a comment is refused');
    eq((await pm.post(`/api/requests/${dreq.id}/decision`, { outcome: 'approve', comment: 'x', decided_by: pmId })).body.code, 'UNKNOWN_FIELD', 'decision rejects unknown fields');
    eq((await pm.post(`/api/requests/${dreq.id}/decision`, { outcome: 'approve', comment: 'x' }, { origin: 'https://evil.example' })).status, 403, 'cross-origin decision refused');
    for (const rel of ['../manifest.json', '../../agastya.db', 'csdb/../../../agastya.db', 'csdb/DMC-NOT-IN-THE-SNAPSHOT.xml']) {
      const sr = await pm.get(`/api/requests/${dreq.id}/source?rel=${encodeURIComponent(rel)}`);
      ok([400, 404].includes(sr.status) && !/[A-Z]:\\|\/Users\/|snapshots/.test(sr.text), `frozen source outside the manifest refused: ${rel}`);
    }
    eq((await pm.get(`/api/requests/${dreq.id}/revisions/99999999`)).status, 404, 'an unknown revision is refused');
    r = await pm.post(`/api/requests/${dreq.id}/decision`, { outcome: 'changes', comment: DECISION_COMMENT });
    eq(r.status, 200, 'the chosen manager decides with a comment');
    eq((await pm.post(`/api/requests/${dreq.id}/decision`, { outcome: 'approve', comment: 'again' })).body.code, 'NOT_PENDING', 'a request is decided once');
    eq((await pm2.get(`/api/projects/${ownProj.id}/requests`)).status, 404, 'decision comments are not visible outside the project');
    const after = await author.get(`/api/projects/${ownProj.id}/dms/${dmId}`);
    eq(after.body.status || (after.body.module && after.body.module.status), 'draft', 'changes requested returns the module to draft');

    // ---- temporary passwords: single use, reissue -------------------------
    r = await pm.post(`/api/users/${arjunId}/reset`);
    eq(r.status, 200, 'creating PM can reissue');
    SECRETS.add(r.body.tempPassword);
    eq((await author.get('/api/auth/me')).status, 401, 'reset revokes live sessions');
    const once = client(base);
    eq((await once.post('/api/auth/login', { username: 'arjun', password: r.body.tempPassword })).status, 200, 'temporary sign-in works once');
    eq((await client(base).post('/api/auth/login', { username: 'arjun', password: r.body.tempPassword })).body.code, 'TEMP_PASSWORD_USED', '...and only once');
    eq((await once.get('/api/projects')).body.code, 'PASSWORD_CHANGE_REQUIRED', 'forced change after temporary sign-in');
    eq((await once.post('/api/auth/change-password', { newPassword: 'Tangerine-Harbour-3' })).status, 200, 'Author sets a new password');

    // ---- disable: immediate loss of access ---------------------------------
    eq((await once.get('/api/dashboard/author')).status, 200, 'Author dashboard works');
    eq((await pm2.post(`/api/users/${arjunId}/disable`)).status, 404, 'another PM cannot disable that Author');
    eq((await pm.post(`/api/users/${pmId}/disable`)).status, 404, 'a PM cannot disable a PM (themselves included)');
    eq((await once.post(`/api/users/${pmId}/disable`)).status, 403, 'an Author cannot disable anyone');
    eq((await admin.post('/api/users/' + (await admin.get('/api/auth/me')).body.user.id + '/disable')).status, 403, 'the administrator cannot be disabled');
    eq((await pm.post(`/api/users/${arjunId}/disable`)).status, 200, 'the creating PM disables their Author (M7)');
    eq((await once.get('/api/dashboard/author')).status, 401, 'disabled account loses access immediately');
    eq((await client(base).post('/api/auth/login', { username: 'arjun', password: 'Tangerine-Harbour-3' })).body.code, 'BAD_CREDENTIALS', 'disabled account cannot sign in');
    await admin.post(`/api/users/${arjunId}/enable`);

    // ---- forgot password ---------------------------------------------------
    const f1 = await anon.post('/api/auth/forgot', { username: 'arjun' });
    const f2 = await anon.post('/api/auth/forgot', { username: 'ghost-user' });
    eq(f1.status, 202, 'forgot is 202');
    eq(f1.text, f2.text, 'forgot response is identical for unknown accounts');
    eq((await pm.get('/api/resets')).body.requests.length, 1, 'request routed to the creating PM');
    eq((await pm2.get('/api/resets')).body.requests.length, 0, 'not to another PM');

    // ---- CSRF, validation, error hygiene -----------------------------------
    eq((await admin.post('/api/users', { username: 'csrf1', fullName: 'C', role: 'author' }, { origin: 'https://evil.example' })).status, 403, 'cross-origin write refused');
    eq((await admin.post('/api/users', { username: 'extra1', fullName: 'E', role: 'author', created_by: 'x' })).body.code, 'UNKNOWN_FIELD', 'unknown fields refused');
    const bad = await admin.raw('POST', '/api/projects', '{"name": broken', {});
    eq(bad.status, 400, 'malformed JSON is 400');
    ok(!/node_modules|\\|\/Users\/|\/home\/|at [A-Za-z]/.test(bad.text), 'no internals in error bodies');

    // ---- rate limit ---------------------------------------------------------
    const brute = client(base);
    for (let i = 0; i < 10; i++) await brute.post('/api/auth/login', { username: 'priya', password: `wrong-${i}-pass` }, { 'x-forwarded-for': `203.0.113.${i}` });
    eq((await brute.post('/api/auth/login', { username: 'priya', password: 'Marigold-River-7' })).status, 429, '11th attempt is limited, even with the right password and a spoofed XFF');

    // ---- Phase 4: administrator screens and overrides -----------------------
    const writer = client(base);
    eq((await writer.post('/api/auth/login', { username: 'arjun', password: 'Tangerine-Harbour-3' })).status, 200, 'the Author signs in again');
    const ADMIN_GETS = ['/api/admin/oversight', '/api/admin/audit', '/api/admin/audit/actions', '/api/admin/audit.csv', '/api/admin/health', '/api/admin/sessions'];
    for (const u of ADMIN_GETS) {
      eq((await pm.get(u)).status, 403, `a Project Manager cannot read ${u}`);
      eq((await writer.get(u)).status, 403, `an Author cannot read ${u}`);
      eq((await anon.get(u)).status, 401, `anonymous cannot read ${u}`);
    }
    const why = 'Security regression: checking the override rules.';
    for (const [c, who] of [[pm, 'a Project Manager'], [writer, 'an Author']]) {
      eq((await c.post(`/api/requests/${dreq.id}/override-decision`, { outcome: 'approve', comment: 'x', reason: why })).status, 403, `${who} cannot decide as an override`);
      eq((await c.post(`/api/requests/${dreq.id}/override-reset`, { reason: why })).status, 403, `${who} cannot reset a request`);
      eq((await c.post(`/api/requests/${dreq.id}/reassign`, { managerId: pmId, reason: why })).status, 403, `${who} cannot reassign a request`);
      eq((await c.post(`/api/projects/${ownProj.id}/override-sessions`, { key: 'modules', reason: why })).status, 403, `${who} cannot open an override session`);
    }
    eq((await admin.post(`/api/requests/${dreq.id}/override-decision`, { outcome: 'approve', comment: 'x' })).body.code, 'OVERRIDE_REASON_REQUIRED', 'an override needs a written reason');
    eq((await admin.post(`/api/projects/${ownProj.id}/requests`, { approverId: pmId })).status, 403, 'the administrator cannot submit a publication request');
    eq((await admin.post(`/api/projects/${ownProj.id}/dms`, { dmc: { ...DMC, infoCode: '042' }, techName: 'x', schemaType: 'descript' }, { 'x-agastya-override-session': '00000000-0000-0000-0000-000000000000' })).body.code, 'OVERRIDE_SESSION_ENDED', 'a forged override session is refused');
    eq((await writer.post(`/api/projects/${ownProj.id}/dms`, { dmc: { ...DMC, infoCode: '043' }, techName: 'x', schemaType: 'descript' }, { 'x-agastya-override-session': 'x' })).body.code, 'OVERRIDE_NOT_ALLOWED', 'an Author cannot send an override session');
    // A password typed into the username box of a failed sign-in is not kept (V9).
    await client(base).post('/api/auth/login', { username: 'Lantern-Fjord-58', password: 'nothing-here-1' });
    const csvRes = await admin.get('/api/admin/audit.csv');
    eq(csvRes.status, 200, 'the administrator exports the audit log');
    for (const s of [...SECRETS, ...TOKENS]) ok(!csvRes.text.includes(s), `the audit export contains a credential (${s.slice(0, 4)}...)`);
    ok(!/\$argon2|\$scrypt\$/.test(csvRes.text), 'no hashes in the audit export');
    ok(!csvRes.text.includes(DECISION_COMMENT), 'decision comments are not in the audit export');
    ok(/commentLength=/.test(csvRes.text), 'the export records comment lengths only');
    const view = await admin.get('/api/admin/audit?limit=200');
    for (const s of [...SECRETS, ...TOKENS, DECISION_COMMENT]) ok(!view.text.includes(s), `the audit viewer shows a secret (${s.slice(0, 4)}...)`);

    // ---- Phase 5: backup and restore -----------------------------------------
    for (const [c, who] of [[pm, 'a Project Manager'], [writer, 'an Author']]) {
      eq((await c.get('/api/admin/backups')).status, 403, `${who} cannot list backups`);
      eq((await c.post('/api/admin/backups', {})).status, 403, `${who} cannot take a backup`);
    }
    eq((await anon.get('/api/admin/backups')).status, 401, 'anonymous cannot list backups');
    const bk = await admin.post('/api/admin/backups', { note: 'security regression' });
    eq(bk.status, 201, 'the administrator takes a backup');
    const bkId = bk.body.backup && bk.body.backup.id;
    eq((await admin.post('/api/admin/backups/..%2F..%2Fetc/verify', {})).status, 404, 'a path as a backup id is not found');
    eq((await admin.post(`/api/admin/backups/${bkId}/restore`, { confirm: bkId, password: 'not-the-password', reason: 'Security regression restore attempt.' })).body.code, 'REAUTH_FAILED', 'a restore needs the administrator\'s password');
    eq((await admin.post(`/api/admin/backups/${bkId}/restore`, { confirm: bkId, password: 'Granite-Harbour-42', reason: 'x' })).status, 400, 'a restore needs a written reason');
    eq((await pm.get('/api/auth/me')).status, 200, 'a refused restore signs nobody out');
    // Nothing in a backup is a credential in clear: passwords are hashes, session tokens are stored as SHA-256 only.
    {
      const backupRoot = `${DATA}-backups`;
      const all = [];
      (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(p); } })(path.join(backupRoot, bkId));
      ok(all.some((f) => f.endsWith('manifest.json')) && all.some((f) => f.endsWith('agastya.db')), 'the backup folder holds a manifest and the database');
      for (const f of all) {
        const buf = fs.readFileSync(f);
        for (const sec of [...SECRETS, ...TOKENS]) ok(!buf.includes(Buffer.from(sec)), `the backup file ${path.basename(f)} contains a credential (${sec.slice(0, 4)}...)`);
        ok(!buf.includes(Buffer.from(DECISION_COMMENT)) || f.endsWith('agastya.db'), 'decision comments appear only inside the database copy');
      }
      if (process.platform !== 'win32') ok((fs.statSync(path.join(backupRoot, bkId)).mode & 0o077) === 0, 'the backup folder is private to the server account');
    }

    // ---- sign-out ------------------------------------------------------------
    eq((await pm2.post('/api/auth/logout')).status, 200, 'sign-out');
    eq((await pm2.get('/api/auth/me')).status, 401, 'signed-out session is dead');
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }

  // ---- credential leak scan over everything the server printed -------------
  for (const s of [...SECRETS, ...TOKENS]) ok(!serverOut.includes(s), `server output leaked a credential (${s.slice(0, 4)}...)`);
  ok(!/\$argon2|\$scrypt\$/.test(serverOut), 'no hashes in server output');
  ok(!new RegExp(`[a-z0-9._-]+@${YEAR}`).test(serverOut), 'no username@year value in server output');

  // Same scan over the audit log on disk.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DATA, 'agastya.db'));
  const auditText = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  db.close();
  for (const s of [...SECRETS, ...TOKENS]) ok(!auditText.includes(s), `audit log contains a credential (${s.slice(0, 4)}...)`);
  ok(!/\$argon2|\$scrypt\$/.test(auditText), 'no hashes in the audit log');
  ok(!auditText.includes(DECISION_COMMENT), 'decision comments are not copied into the audit log');
  ok(!serverOut.includes(DECISION_COMMENT), 'decision comments are not in server output');

  console.log(`\n\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log('  FAIL: ' + f);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('\nsecurity regression aborted:', e.message); process.exitCode = 1; })
  .finally(() => {
    for (const d of [DATA, `${DATA}-backups`]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ } }
  });
