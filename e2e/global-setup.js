'use strict';
/*
  Starts Agastya on a temporary data directory with the built client, seeds
  the accounts and content the scenarios need, and saves one signed-in
  browser session per role. The server runs until the test run ends.

    admin        Software Administrator
    priya.rao    Project Manager (created the Authors below; owns "Managed manual")
    other.pm     a second Project Manager
    arjun.das    Author: owns "PDU-200 Manual" (golden sample), assigned to "Managed manual"
    meera.iyer   Author: assigned to "PDU-200 Manual"
    ravi.k       Author on no project
    sign.in      Author used only by the sign-in scenario

  Passwords are generated per run; nothing here is a default credential.
*/

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServer } = require('../server/server');

const ROOT = path.join(__dirname, '..');
const GOLDEN = path.join(ROOT, 'samples', 'golden');
const STATE_DIR = path.join(__dirname, '.state');

function client(base) {
  let cookie = '';
  async function req(method, url, body) {
    const headers = { origin: base };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    const m = set && /agastya_session=([^;]*)/.exec(set);
    if (m) cookie = m[1] ? `agastya_session=${m[1]}` : '';
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { json = null; }
    if (res.status >= 400) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 200)}`);
    return json;
  }
  return { get: (u) => req('GET', u), post: (u, b = {}) => req('POST', u, b), put: (u, b) => req('PUT', u, b), get cookie() { return cookie; } };
}

module.exports = async function globalSetup() {
  const dist = path.join(ROOT, 'client', 'dist', 'index.html');
  if (!fs.existsSync(dist)) throw new Error('Build the client first: npm run build:client');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agastya-e2e-'));
  const pw = () => `E2e-${crypto.randomBytes(6).toString('hex')}-Run`;
  const adminBoot = pw(), adminPw = pw();
  const srv = createServer({
    dataDir,
    env: { AGASTYA_INITIAL_ADMIN_USERNAME: 'admin', AGASTYA_INITIAL_ADMIN_PASSWORD: adminBoot },
    log: { log() {}, error() {}, warn() {} },
  });
  const server = await srv.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = client(base);
  await admin.post('/api/auth/login', { username: 'admin', password: adminBoot });
  await admin.post('/api/auth/change-password', { newPassword: adminPw });
  const accounts = { admin: { username: 'admin', password: adminPw, fullName: 'Software Administrator' } };
  async function make(by, username, fullName, role) {
    const r = await by.post('/api/users', { username, fullName, role });
    const c = client(base);
    const password = pw();
    await c.post('/api/auth/login', { username, password: r.tempPassword });
    await c.post('/api/auth/onboarding', { fullName, newPassword: password });
    accounts[username] = { username, password, fullName, id: r.user.id, role };
    return c;
  }
  const pm = await make(admin, 'priya.rao', 'Priya Rao', 'project_manager');
  await make(admin, 'other.pm', 'Other Manager', 'project_manager');
  const arjun = await make(pm, 'arjun.das', 'Arjun Das', 'author');
  await make(pm, 'meera.iyer', 'Meera Iyer', 'author');
  await make(pm, 'ravi.k', 'Ravi Kumar', 'author');
  await make(pm, 'sign.in', 'Sana Inamdar', 'author');

  // The Author's project: the golden sample, its graphic and logos, its publication module.
  const project = (await arjun.post('/api/projects', { name: 'PDU-200 Manual', description: 'Organisational maintenance for the PDU-200 power distribution unit.' })).project;
  await arjun.post(`/api/projects/${project.id}/members`, { userId: accounts['meera.iyer'].id });
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) {
    await arjun.post(`/api/projects/${project.id}/dms/import`, { filename: f, content: fs.readFileSync(path.join(GOLDEN, 'csdb', f), 'utf8') });
  }
  const icn = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';
  const form = new FormData();
  form.append('icn', icn);
  form.append('file', new Blob([fs.readFileSync(path.join(GOLDEN, 'csdb', `${icn}.png`))]), 'figure.png');
  const up = await fetch(`${base}/api/projects/${project.id}/graphics`, { method: 'POST', body: form, headers: { cookie: arjun.cookie, origin: base } });
  if (up.status !== 201) throw new Error(`graphic upload failed: ${up.status}`);
  const ws = path.join(dataDir, 'projects', project.id);
  for (const m of ['emblem.png', 'publisher-logo.png']) fs.copyFileSync(path.join(GOLDEN, 'Media', m), path.join(ws, 'Media', m));
  const pmDoc = await arjun.get(`/api/projects/${project.id}/publication`);
  await arjun.put(`/api/projects/${project.id}/publication`, { xml: fs.readFileSync(path.join(GOLDEN, 'publication.xml'), 'utf8'), baseRevision: pmDoc.revision });

  // A Project Manager's project with the Author assigned (the manager reads and builds only).
  const managed = (await pm.post('/api/projects', { name: 'Managed manual', description: 'Owned by a Project Manager.' })).project;
  await pm.post(`/api/projects/${managed.id}/members`, { userId: accounts['arjun.das'].id });
  for (const f of ['DMC-AGS-A-24-00-00-00A-040A-D.xml', 'DMC-AGS-A-00-00-00-00A-018A-D.xml']) {
    await arjun.post(`/api/projects/${managed.id}/dms/import`, { filename: f, content: fs.readFileSync(path.join(GOLDEN, 'csdb', f), 'utf8') });
  }

  // One saved browser session per role (each account has a single active session).
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const host = new URL(base).hostname;
  for (const username of ['admin', 'priya.rao', 'other.pm', 'arjun.das', 'meera.iyer', 'ravi.k']) {
    const c = client(base);
    await c.post('/api/auth/login', { username, password: accounts[username].password });
    const value = c.cookie.replace(/^agastya_session=/, '');
    fs.writeFileSync(path.join(STATE_DIR, `${username}.json`), JSON.stringify({
      cookies: [{ name: 'agastya_session', value, domain: host, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
      origins: [],
    }));
  }
  fs.writeFileSync(path.join(STATE_DIR, 'run.json'), JSON.stringify({ base, dataDir, projectId: project.id, managedId: managed.id, accounts }, null, 2));
  process.env.AGASTYA_E2E_BASE = base;

  return async () => {
    await srv.stop();
    for (const d of [dataDir, `${dataDir}-backups`]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  };
};
