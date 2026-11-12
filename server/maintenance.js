'use strict';
/*
  The maintenance gate (decisions.md K3). A backup and a restore each need a
  moment in which nothing changes underneath them:

    backup    state-changing API requests (anything but GET/HEAD) are held
              off with 503 MAINTENANCE while the database is copied and the
              files are read; reads carry on.
    restore   every API request except the liveness probe is held off, and
              no WebSocket is accepted, while the data is swapped.

  enter() first lets the requests already in flight finish (it waits for
  them, up to a timeout), so a save that began before the backup is either
  wholly in it or wholly after it. The request that asked for the operation
  is its owner and is not waited for.
*/

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

class MaintenanceBusy extends Error {
  constructor(message) { super(message); this.status = 503; this.code = 'MAINTENANCE_BUSY'; }
}

function createMaintenance({ log = console } = {}) {
  let mode = null;
  const inflight = new Set();
  let wake = null;

  const blocks = (req) => {
    if (!mode || !req.path.startsWith('/api/')) return false;
    if (req.path === '/api/health') return false;
    return mode === 'restore' || !SAFE.has(req.method);
  };

  function middleware(req, res, next) {
    if (blocks(req)) {
      res.set('Retry-After', '30');
      return res.status(503).json({
        error: mode === 'restore' ? 'Agastya is restoring a backup. Try again in a minute; you will need to sign in again.' : 'A backup is being taken. Saving is paused for a moment; try again shortly.',
        code: 'MAINTENANCE',
      });
    }
    if (!req.path.startsWith('/api/')) return next();
    inflight.add(req);
    const done = () => { if (inflight.delete(req) && wake) wake(); };
    res.on('finish', done);
    res.on('close', done);
    next();
  }

  // Requests that must finish before the gate is closed: writes for a backup, everything for a restore.
  const pending = (owner) => [...inflight].filter((r) => r !== owner && (mode === 'restore' || !SAFE.has(r.method)));

  async function enter(newMode, { owner = null, timeoutMs = 60000, idle = null } = {}) {
    if (mode) throw new MaintenanceBusy('Another backup or restore is in progress.');
    mode = newMode;
    const until = Date.now() + timeoutMs;
    try {
      while (pending(owner).length || (idle && !idle())) {
        if (Date.now() > until) throw new MaintenanceBusy('Agastya stayed busy (saves or PDF builds in progress), so the operation was not started. Try again in a moment.');
        await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 200); });
        wake = null;
      }
    } catch (e) {
      mode = null;
      throw e;
    }
    log.log && log.log(`[maintenance] ${newMode}: writes paused`);
  }

  function exit() {
    if (mode) log.log && log.log(`[maintenance] ${mode}: resumed`);
    mode = null;
  }

  return { middleware, enter, exit, blocks, mode: () => mode, MaintenanceBusy };
}

module.exports = { createMaintenance, MaintenanceBusy };
