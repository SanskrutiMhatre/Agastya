'use strict';
// Rate limit, CSRF, body validation, error hygiene, no bypass switch, audit
// sanitising and audit-failure tolerance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, adminClient, makeUser } = require('./helpers');
const { sanitiseMeta } = require('../server/audit');

let t, admin;
test.before(async () => { t = await startServer(); admin = await adminClient(t); });
test.after(() => t.stop());

test('sign-in is limited to 10 attempts per 15 minutes per username + IP', async () => {
  const c = t.client();
  for (let i = 0; i < 10; i++) {
    assert.equal((await c.post('/api/auth/login', { username: 'victim', password: `guess-${i}-xxxx` })).status, 401);
  }
  const blocked = await c.post('/api/auth/login', { username: 'victim', password: 'guess-x-xxxx' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // Forgot-password shares the limiter for the same username.
  assert.equal((await c.post('/api/auth/forgot', { username: 'victim' })).status, 429);
  // A different username is a different bucket.
  assert.equal((await c.post('/api/auth/login', { username: 'someone-else', password: 'x-x-x-x-x' })).status, 401);
});

test('a forged X-Forwarded-For does not escape the limiter', async () => {
  const c = t.client();
  for (let i = 0; i < 10; i++) await c.post('/api/auth/login', { username: 'spoof', password: 'nope-nope-1' }, { 'x-forwarded-for': `10.0.0.${i}` });
  assert.equal((await c.post('/api/auth/login', { username: 'spoof', password: 'nope-nope-1' }, { 'x-forwarded-for': '10.9.9.9' })).status, 429);
});

test('temporary-password sign-ins are rate-limited like any other', async () => {
  const r = await admin.post('/api/users', { username: 'limited', fullName: 'Lim Ited', role: 'author' });
  const c = t.client();
  for (let i = 0; i < 10; i++) await c.post('/api/auth/login', { username: 'limited', password: 'wrong-wrong-1' });
  assert.equal((await c.post('/api/auth/login', { username: 'limited', password: r.body.tempPassword })).status, 429);
});

test('CSRF: a cross-origin write is refused; same-origin and no-Origin pass', async () => {
  const host = new URL(t.base).host;
  const bad = await admin.post('/api/users', { username: 'csrf.x', fullName: 'C X', role: 'author' }, { origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
  assert.equal(bad.body.code, 'CROSS_ORIGIN');
  assert.equal((await admin.post('/api/auth/logout', {}, { origin: 'null' })).status, 403, 'opaque origin refused');
  assert.equal((await admin.post('/api/users', { username: 'csrf.ok', fullName: 'C Ok', role: 'author' }, { origin: `http://${host}` })).status, 201);
  assert.equal(t.store.findUserByUsername('csrf.x'), null);
  // GET is never blocked by the Origin check.
  assert.equal((await admin.get('/api/users', { origin: 'https://evil.example' })).status, 200);
});

test('unknown fields are rejected, so no one can smuggle a role or creator', async () => {
  const pm = await makeUser(t, admin, { username: 'smuggler', role: 'project_manager' });
  const r = await pm.post('/api/users', { username: 'sneaky', fullName: 'S N', role: 'author', created_by: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'UNKNOWN_FIELD');
  assert.equal((await t.client().post('/api/auth/login', { username: 'a', password: 'b', remember: true })).body.code, 'UNKNOWN_FIELD');
  assert.equal((await admin.post(`/api/users/${pm.user.id}/disable`, { reason: 'x' })).body.code, 'UNKNOWN_FIELD');
  assert.equal((await admin.get('/api/users?admin=1')).body.code, 'UNKNOWN_FIELD');
  assert.equal((await admin.post('/api/users', { username: 42, fullName: 'N', role: 'author' })).body.code, 'VALIDATION');
  assert.equal((await pm.post('/api/projects', ['array'])).body.code, 'BAD_REQUEST');
});

test('errors never leak internals', async () => {
  const bad = await admin.raw('POST', '/api/users', '{"username": nope', {});
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.body).sort(), ['code', 'error']);
  assert.ok(!/[A-Z]:\\|\/home\/|node_modules|at .*\.js/.test(bad.text));
  const big = await admin.raw('POST', '/api/projects', JSON.stringify({ name: 'x'.repeat(200 * 1024) }), {});
  assert.equal(big.status, 413);
  const unknown = await admin.get('/api/does/not/exist');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'NOT_FOUND');
});

test('no self-registration: registration-like routes do not exist, user creation needs a session', async () => {
  const anon = t.client();
  for (const url of ['/api/auth/register', '/api/register', '/api/auth/signup', '/api/auth/setup', '/api/signup']) {
    const r = await anon.post(url, { username: 'mallory', password: 'Mallory-Pass-1', fullName: 'M' });
    assert.equal(r.status, 404, url);
  }
  assert.equal((await anon.post('/api/users', { username: 'mallory', fullName: 'M', role: 'author' })).status, 401);
  assert.equal(t.store.findUserByUsername('mallory'), null);
});

test('unauthenticated requests are denied on every guarded route', async () => {
  const anon = t.client();
  const urls = ['/api/auth/me', '/api/users', '/api/users/x', '/api/resets', '/api/projects', '/api/projects/x',
    '/api/dashboard/admin', '/api/dashboard/manager', '/api/dashboard/author', '/api/notifications'];
  for (const u of urls) assert.equal((await anon.get(u)).status, 401, u);
  assert.equal((await anon.get('/api/auth/me', { cookie: 'agastya_session=forged-token-value-1234567890' })).status, 401);
});

test('there is no authentication-bypass switch in the code', () => {
  const dir = path.join(__dirname, '..', 'server');
  const src = [];
  const spawning = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) {
        const text = fs.readFileSync(p, 'utf8');
        src.push(text);
        if (/child_process/.test(text)) spawning.push({ rel: path.relative(dir, p).split(path.sep).join('/'), text });
      }
    }
  })(dir);
  const all = src.join('\n');
  const envNames = new Set([...all.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...envNames].sort(), ['AGASTYA_BACKUP_DIR', 'AGASTYA_BACKUP_KEEP', 'AGASTYA_BACKUP_KEY', 'AGASTYA_BACKUP_SCHEDULE', 'AGASTYA_DATA_DIR', 'AGASTYA_INITIAL_ADMIN_PASSWORD', 'AGASTYA_INITIAL_ADMIN_USERNAME', 'AGASTYA_SECURE_COOKIES', 'AGASTYA_TRUST_PROXY', 'HOST', 'PORT'],
    'every environment switch the server reads; none may weaken authentication');
  assert.ok(!/AUTH_DISABLED|SKIP_AUTH|NO_AUTH|MASTER_PASSWORD/i.test(all));
  // The only process the server itself starts is the health screen's toolchain check (V11), with execFile and argument arrays.
  assert.deepEqual(spawning.map((f) => f.rel), ['health/toolchain.js'], 'the server starts external processes only for the toolchain checks');
  for (const f of spawning) {
    const imports = [...f.text.matchAll(/const \{([^}]*)\} = require\('node:child_process'\)/g)].map((m) => m[1].trim());
    assert.deepEqual(imports, ['execFile'], `${f.rel}: imports execFile only from child_process`);
    assert.ok(!/shell\s*:\s*true/.test(f.text), `${f.rel}: never a shell`);
  }
});

test('audit metadata drops anything that looks like a secret', () => {
  const m = sanitiseMeta({ username: 'x', password: 'p', tempPassword: 't', newPasswordHash: 'h', token: 'k', nested: { cookie: 'c', ok: 1 } });
  assert.deepEqual(m, { username: 'x', nested: { ok: 1 } });
});

test('a failing audit write does not break the operation', async () => {
  const orig = t.store.appendAudit;
  t.store.appendAudit = () => { throw new Error('disk full'); };
  try {
    const r = await admin.post('/api/users', { username: 'audit.fail', fullName: 'Audit Fail', role: 'author' });
    assert.equal(r.status, 201);
  } finally { t.store.appendAudit = orig; }
  assert.ok(t.store.findUserByUsername('audit.fail'));
});

test('security headers are set', async () => {
  const r = await t.client().get('/api/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('access-control-allow-origin'), null, 'no CORS');
  assert.equal(r.headers.get('x-powered-by'), null);
});
