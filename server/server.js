'use strict';
// Agastya server. createServer() assembles the application without listening,
// so tests can build it against a throwaway data directory; start() listens.
//
// Request pipeline, in order:
//   security headers -> CSRF Origin check -> JSON body (100 KB) -> static client
//   -> routes (each: guard first, then body validation, then handler)
//   -> /api 404 -> SPA fallback -> error handler (no internals leak)
//
// There is no switch that disables authentication. Nothing here reads a
// header to learn the client's IP: rate limiting uses the raw socket address.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');

const { Store } = require('./db/store');
const { SessionService } = require('./auth/sessions');
const { RateLimiter } = require('./auth/rateLimit');
const { createAuthz } = require('./auth/authz');
const { ensureBootstrapAdmin } = require('./auth/bootstrap');
const { createAudit } = require('./audit');
const { createNotifier } = require('./notify');
const { createErrorHandler } = require('./http/errors');
const { createDocumentService } = require('./content/documents');
const { createRealtime } = require('./realtime');
const { createLocks } = require('./content/locks');
const { createOverrides } = require('./overrides');
const { createMaintenance } = require('./maintenance');
const { createBackupService } = require('./backup/service');
const { recoverInterruptedRestore } = require('./backup/recovery');
const { activeBuilds } = require('./publish/runner');

const ROUTES = [
  require('./routes/auth'),
  require('./routes/users'),
  require('./routes/resets'),
  require('./routes/projects'),
  require('./routes/workspaces'),
  require('./routes/library'),
  require('./routes/dashboard'),
  require('./routes/content'),
  require('./routes/tools'),
  require('./routes/publication'),
  require('./routes/requests'),
  require('./routes/drafts'),
  require('./routes/admin'),
  require('./routes/backups'),
  require('./routes/misc'), // last: /api 404 and the SPA fallback
];

const DEFAULT_CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
}

/*
  Cross-origin write refusal, on top of SameSite=Lax: a state-changing
  request whose Origin host differs from Host is refused. A request with no
  Origin passes; it cannot come from a browser page on another site
  carrying the user's cookie (decisions.md A6).
*/
function csrfOriginCheck(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin === undefined) return next();
  let host = null;
  try { host = new URL(origin).host; } catch { host = null; }
  if (!host || host !== req.headers.host) {
    return res.status(403).json({ error: 'Cross-origin request refused.', code: 'CROSS_ORIGIN' });
  }
  next();
}

function createServer({
  dataDir = path.join(__dirname, '..', 'data'),
  env = process.env,
  log = console,
  now = () => new Date(),
  clientDist = DEFAULT_CLIENT_DIST,
  limiter = new RateLimiter(),
  backupHooks = {},
  backupFreeSpace = null,
} = {}) {
  // A restore cut short by a crash is undone before the database is opened (decisions.md K5).
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    recoverInterruptedRestore(dataDir, log);
  }
  const store = new Store(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'agastya.db'));
  store.migrate(now().toISOString());

  const sessions = new SessionService(store, { now, secureCookies: env.AGASTYA_SECURE_COOKIES === '1' });
  const authz = createAuthz({ store, sessions, now });
  const notifier = createNotifier({ store, now });
  // In-process hub: content changes, build progress and audited actions, for the WebSocket and the request stale check.
  const events = new EventEmitter();
  events.setMaxListeners(50);
  // Every audited action is also announced, so live sockets are re-checked after sign-outs, revocations and membership changes.
  const audit = createAudit({ store, notifier: (id, row) => { notifier(id, row); events.emit('audit', { action: row.action }); }, now, log });

  const app = express();
  app.disable('x-powered-by');
  // Only for req.secure (Secure cookies behind a TLS proxy). Client IPs never
  // come from forwarded headers: see clientIp below.
  if (env.AGASTYA_TRUST_PROXY === '1') app.set('trust proxy', 1);

  // Backups and restores pause writes (or everything) for a moment (decisions.md K3).
  const maintenance = createMaintenance({ log });
  app.use(securityHeaders);
  app.use(maintenance.middleware);
  app.use(csrfOriginCheck);
  /*
    JSON bodies are capped at 100 KB, except data module and publication
    saves, imports, validation and drafts, which carry whole XML documents
    or the publication tree (8 MB, matching the write path's own limit).
  */
  const jsonSmall = express.json({ limit: '100kb', strict: true });
  const jsonLarge = express.json({ limit: '9mb', strict: true });
  const LARGE_BODY = /^\/api\/projects\/[^/]+\/(publication(\/model|\/import)?|drafts\/[^/]+|dms(\/import|\/[^/]+(\/validate)?)?)$/;
  app.use((req, res, next) => (LARGE_BODY.test(req.path) ? jsonLarge : jsonSmall)(req, res, next));
  app.use(express.static(clientDist, { index: false, maxAge: '1y', immutable: true, fallthrough: true }));

  const clientIp = (req) => (req.socket && req.socket.remoteAddress) || '';
  const userAgent = (req) => String(req.headers['user-agent'] || '').slice(0, 200);
  const resolvedDataDir = dataDir === ':memory:' ? path.join(require('node:os').tmpdir(), 'agastya-memory') : dataDir;
  const documents = createDocumentService({ store, dataDir: resolvedDataDir, now });
  const locks = createLocks({ store, dataDir: resolvedDataDir });
  const overrides = createOverrides({ store, audit, now, clientIp });
  // Backups live beside the data folder, never inside it: <dataDir>-backups unless AGASTYA_BACKUP_DIR says otherwise.
  const backupDir = env.AGASTYA_BACKUP_DIR || `${path.resolve(resolvedDataDir)}-backups`;
  let afterRestore = () => {};
  const backups = createBackupService({
    store, dataDir: resolvedDataDir, backupDir, env, now, log, audit, maintenance, activeBuilds,
    onRestored: () => afterRestore(), hooks: backupHooks, freeSpace: backupFreeSpace,
  });
  const ctx = { app, store, sessions, authz, audit, limiter, now, clientIp, userAgent, log, clientDist, dataDir: resolvedDataDir, documents, events, locks, overrides, backups, maintenance };
  for (const r of ROUTES) r.register(ctx);
  app.use(createErrorHandler(log));

  const ready = ensureBootstrapAdmin({ store, audit, env, log: (m) => log.log(m), now });

  const realtime = createRealtime({ store, sessions, events, log });
  // After a restore: cached lock manifests are dropped and every socket is re-checked (all sessions have ended).
  afterRestore = () => { locks.reset(); realtime.sweep(); };
  backups.start();
  const pidFile = dataDir === ':memory:' ? null : path.join(resolvedDataDir, 'server.pid');
  let server = null;
  const envPort = env.PORT !== undefined && env.PORT !== '' ? Number(env.PORT) : 3535;
  async function start(port = envPort, host = env.HOST || '127.0.0.1') {
    await ready;
    await new Promise((resolve, reject) => {
      // Express 5 calls this back with the error when listening fails (a port in use, for example).
      server = app.listen(port, host, (err) => (err ? reject(err) : resolve()));
    }).catch((e) => {
      if (e && e.code === 'EADDRINUSE') e.message = `port ${port} on ${host} is already in use by another program. Stop it, or set PORT to a free port in .env (for example PORT=3536).`;
      throw e;
    });
    server.on('upgrade', (req, socket, head) => {
      if (maintenance.mode() === 'restore') { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return socket.destroy(); }
      realtime.handleUpgrade(req, socket, head);
    });
    // Lets the backup command see that a server is using this data folder.
    if (pidFile) { try { fs.writeFileSync(pidFile, String(process.pid)); } catch { /* informational */ } }
    return server;
  }
  async function stop() {
    // The warm FOP renderer is a JVM child process started by the first build.
    try { require('../vendor/engine/fopd').stop(); } catch { /* never started */ }
    realtime.close();
    backups.stop();
    if (pidFile) { try { if (fs.readFileSync(pidFile, 'utf8') === String(process.pid)) fs.unlinkSync(pidFile); } catch { /* gone */ } }
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    store.close();
  }

  return { app, store, audit, limiter, ready, start, stop, documents, events, realtime, backups, maintenance, backupDir, dataDir: resolvedDataDir };
}

if (require.main === module) {
  const srv = createServer({ dataDir: process.env.AGASTYA_DATA_DIR || undefined });
  srv.start().then((s) => {
    const a = s.address();
    console.log(`[agastya] listening on http://${a.address}:${a.port}`);
  }).catch((e) => {
    console.error('[agastya] failed to start:', e.message);
    process.exit(1);
  });
  const shutdown = () => srv.stop().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, csrfOriginCheck };
