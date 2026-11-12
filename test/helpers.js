'use strict';
// Test helpers. Every test builds its own server on a throwaway data
// directory under the OS temp dir and an OS-assigned port, so a test can
// never touch real data.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/server');

const ADMIN = { username: 'admin', bootstrap: 'Bootstrap-Temp-91', password: 'Granite-Harbour-42' };

function tmpdir(prefix = 'agastya-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const quietLog = { log() {}, error() {}, warn() {} };

// A cookie-keeping JSON client over fetch.
function client(base) {
  let cookie = '';
  async function req(method, url, bodyObj, headers = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (bodyObj !== undefined) { h['content-type'] = 'application/json'; payload = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj); }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /agastya_session=([^;]*)/.exec(set);
      if (m) cookie = m[1] ? `agastya_session=${m[1]}` : '';
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  return {
    get: (u, h) => req('GET', u, undefined, h),
    post: (u, b, h) => req('POST', u, b === undefined ? {} : b, h),
    patch: (u, b, h) => req('PATCH', u, b, h),
    del: (u, h) => req('DELETE', u, undefined, h),
    raw: req,
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
}

/*
  Start a server with a bootstrapped admin. opts.now lets a test move the
  clock; opts.log captures output.
*/
async function startServer(opts = {}) {
  const dataDir = tmpdir();
  const srv = createServer({
    dataDir,
    env: { AGASTYA_INITIAL_ADMIN_USERNAME: ADMIN.username, AGASTYA_INITIAL_ADMIN_PASSWORD: ADMIN.bootstrap, ...(opts.env || {}) },
    log: opts.log || quietLog,
    now: opts.now,
    clientDist: opts.clientDist || path.join(dataDir, 'no-client'),
    backupHooks: opts.backupHooks,
    backupFreeSpace: opts.backupFreeSpace,
  });
  const server = await srv.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...srv, base, dataDir, client: () => client(base) };
}

// Sign in as the admin and get past the bootstrap forced change.
async function adminClient(t) {
  const c = t.client();
  let r = await c.post('/api/auth/login', { username: ADMIN.username, password: ADMIN.bootstrap });
  if (r.status !== 200) {
    r = await c.post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password });
    if (r.status !== 200) throw new Error('admin login failed: ' + r.text);
    return c;
  }
  r = await c.post('/api/auth/change-password', { newPassword: ADMIN.password });
  if (r.status !== 200) throw new Error('admin change failed: ' + r.text);
  return c;
}

// Create an account via `creator` and complete onboarding; returns a signed-in client.
async function makeUser(t, creator, { username, fullName, role, password = `Pw-${username}-Strong-7` }) {
  const r = await creator.post('/api/users', { username, fullName: fullName || `${username} Tester`, role });
  if (r.status !== 201) throw new Error(`create ${username} failed: ${r.status} ${r.text}`);
  const c = t.client();
  const l = await c.post('/api/auth/login', { username, password: r.body.tempPassword });
  if (l.status !== 200) throw new Error(`login ${username} failed: ${l.text}`);
  const o = await c.post('/api/auth/onboarding', { fullName: fullName || `${username} Tester`, newPassword: password });
  if (o.status !== 200) throw new Error(`onboard ${username} failed: ${o.text}`);
  c.user = r.body.user;
  c.password = password;
  return c;
}

module.exports = { startServer, adminClient, makeUser, client, tmpdir, quietLog, ADMIN };
