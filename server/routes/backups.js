'use strict';
/*
  Backup and restore (Phase 5, decisions.md K1-K12). The Software
  Administrator's alone (admin.backup); anyone else gets 403.

    GET    /api/admin/backups                 every backup, and the backup status (schedule, retention, last, warnings)
    POST   /api/admin/backups                 take a backup now                         { note? }
    POST   /api/admin/backups/:bid/verify     check every file and the database
    DELETE /api/admin/backups/:bid            delete one (never the only usable one)
    POST   /api/admin/backups/:bid/restore    replace all data with it                  { confirm, password, reason }

  A restore asks for the backup id typed again, the administrator's own
  password and a written reason. It ends every session, the caller's too.
*/

const { body } = require('../http/validate');
const { sendError } = require('../http/errors');
const { verifyPassword } = require('../auth/crypto');
const { MaintenanceBusy } = require('../maintenance');

const BID = /^bk-\d{8}-\d{6}-[0-9a-f]{6}$/;

function register({ app, store, authz, backups, limiter, clientIp, log, sessions }) {
  const { can } = authz;
  const me = (req) => req.auth.user;

  // Backup errors carry their own status and a message with no paths in it.
  const run = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof backups.BackupError || e instanceof MaintenanceBusy) {
        return res.status(e.status).json({ error: e.message, code: e.code, ...(e.problems ? { problems: e.problems.slice(0, 20) } : {}) });
      }
      log.error && log.error(`[backup] unexpected error: ${e && e.message}`);
      return sendError(res, 500, 'INTERNAL', 'Something went wrong. Try again, or contact your administrator.');
    }
  };
  const idOk = (req, res) => {
    if (BID.test(req.params.bid)) return true;
    sendError(res, 404, 'NOT_FOUND', 'Not found.');
    return false;
  };

  app.get('/api/admin/backups',
    can('admin.backup'),
    run(async (req, res) => res.json({ backups: backups.list(), status: backups.status() })));

  app.post('/api/admin/backups',
    can('admin.backup'),
    body({ note: { type: 'string', max: 500, label: 'Note' } }),
    run(async (req, res) => {
      const backup = await backups.create({ kind: 'manual', actor: me(req), note: req.valid.note || '', owner: req, ip: clientIp(req) });
      res.status(201).json({ backup });
    }));

  app.post('/api/admin/backups/:bid/verify',
    can('admin.backup'),
    body({}),
    run(async (req, res) => {
      if (!idOk(req, res)) return;
      res.json(await backups.verify(req.params.bid, { actor: me(req), ip: clientIp(req) }));
    }));

  app.delete('/api/admin/backups/:bid',
    can('admin.backup'),
    body({}),
    run(async (req, res) => {
      if (!idOk(req, res)) return;
      backups.remove(req.params.bid, { actor: me(req), ip: clientIp(req) });
      res.json({ ok: true });
    }));

  app.post('/api/admin/backups/:bid/restore',
    can('admin.backup'),
    body({
      confirm: { type: 'string', required: true, max: 40, label: 'Backup id' },
      password: { type: 'password', required: true, max: 256, label: 'Password' },
      reason: { type: 'string', required: true, min: 10, max: 1000, label: 'Reason' },
    }),
    run(async (req, res) => {
      if (!idOk(req, res)) return;
      const user = me(req);
      if (req.valid.confirm !== req.params.bid) return sendError(res, 400, 'CONFIRMATION_MISMATCH', 'Type the backup id exactly to confirm the restore.');
      // The administrator's own password again: a restore replaces everything.
      const rl = limiter.attempt(`restore:${user.username}`, clientIp(req));
      if (!rl.allowed) return sendError(res, 429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
      const row = store.getUser(user.id);
      if (!row || !(await verifyPassword(row.password_hash, req.valid.password))) {
        return sendError(res, 403, 'REAUTH_FAILED', 'That password is not correct. Nothing was restored.');
      }
      limiter.clear(`restore:${user.username}`, clientIp(req));
      const r = await backups.restore(req.params.bid, { actor: user, owner: req, ip: clientIp(req), reason: req.valid.reason });
      // Every session ended with the restore, this one included.
      res.set('Set-Cookie', sessions.clearCookieValue(req));
      res.json({ ok: true, ...r, signedOut: true });
    }));
}

module.exports = { register };
