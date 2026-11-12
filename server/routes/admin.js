'use strict';
/*
  The Software Administrator's screens (Phase 4, decisions.md V1-V12).
  Every route here is the administrator's alone: anyone else gets 403.

    GET  /api/admin/oversight                  every project, workload, who is working on what, stuck requests
    GET  /api/admin/audit                      the audit log, filtered, newest first (keyset paging)
    GET  /api/admin/audit/actions              the actions present, for the filter
    GET  /api/admin/audit.csv                  the same rows as CSV (at most 50 000)
    GET  /api/admin/health                     toolchain, build queue, database and storage, backup
    POST /api/admin/health/toolchain           run the toolchain checks again
    GET  /api/admin/sessions                   every live session
    POST /api/projects/:id/override-sessions   start editing one document as an override, with a reason (V3)
    POST /api/override-sessions/:sid/end       stop (leaving the document)

  Audit rows leave only through the presenter (auditView.js): listed fields
  per action, never comments, passwords, tokens or the names typed at failed
  sign-ins for unknown accounts.
*/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loaders } = require('../auth/authz');
const { body, query } = require('../http/validate');
const { sendError, handle } = require('../http/errors');
const { projectOut, memberOut } = require('./projects');
const { requestOut } = require('./requests');
const { teamActivity } = require('../content/activity');
const { presentRow, csvLine, CSV_HEADER } = require('../auditView');
const { activeBuilds } = require('../publish/runner');
const toolchain = require('../health/toolchain');

const DAY_MS = 24 * 60 * 60 * 1000;
const DOC_KEY = /^(dm-[0-9a-f-]{36}|modules|publication|graphics)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOOLCHAIN_TTL_MS = 10 * 60 * 1000;
const EXPORT_MAX = 50000;

function dirSize(dir, budget = { files: 200000 }) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (budget.files-- <= 0) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p, budget);
    else { try { total += fs.statSync(p).size; } catch { /* gone */ } }
  }
  return total;
}
const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

function register(ctx) {
  const { app, store, authz, audit, now, clientIp, dataDir, backups } = ctx;
  const { can } = authz;
  const nowIso = () => now().toISOString();
  const me = (req) => req.auth.user;

  // ---- 1. oversight ---------------------------------------------------------

  app.get('/api/admin/oversight',
    can('admin.oversight'),
    (req, res) => {
      const at = now();
      const counts = new Map();
      for (const r of store.dataModuleCountsByProject()) {
        const c = counts.get(r.project_id) || { draft: 0, in_review: 0, approved: 0 };
        c[r.status] = Number(r.n);
        counts.set(r.project_id, c);
      }
      const lastAct = new Map(store.lastActivityPerProject().map((r) => [r.project_id, r.at]));
      const rows = store.listProjects();
      const projects = rows.map((p) => {
        const latest = store.listRequests({ projectId: p.id, limit: 1 })[0] || null;
        const b = store.lastBuild(p.id, 'full');
        return {
          ...projectOut(p),
          modules: counts.get(p.id) || { draft: 0, in_review: 0, approved: 0 },
          lastBuild: b ? { ok: !!b.ok, at: b.at } : null,
          request: latest ? { id: latest.id, status: latest.status, manager: latest.manager_name, submittedAt: latest.submitted_at } : null,
          lastActivityAt: lastAct.get(p.id) || null,
        };
      });
      // Every Author on a project, the owning Author included, for "who is working on what".
      const withAuthors = rows.map((p) => {
        const authors = store.listMembers(p.id).map(memberOut);
        if (p.owner_role === 'author' && !authors.some((a) => a.id === p.owner_id)) authors.unshift({ id: p.owner_id, fullName: p.owner_name, username: p.owner_username });
        return { id: p.id, name: p.name, authors };
      });
      const since = new Date(at.getTime() - 30 * DAY_MS).toISOString();
      const managers = store.managerWorkload(since).map((m) => ({
        id: m.id, username: m.username, fullName: m.full_name, status: m.disabled_at ? 'disabled' : m.onboarding_pending ? 'pending' : 'active',
        pending: Number(m.pending), oldestPending: m.oldest_pending || null, decided30d: Number(m.decided_recent),
        projects: Number(m.owned), authorsCreated: Number(m.authors_created),
        stuck: !!m.disabled_at && Number(m.pending) > 0,
      }));
      const authors = store.authorWorkload().map((a) => ({
        id: a.id, username: a.username, fullName: a.full_name, status: a.disabled_at ? 'disabled' : a.onboarding_pending ? 'pending' : 'active',
        projects: { owned: Number(a.owned), assigned: Number(a.assigned) },
        modules: { draft: Number(a.dm_draft), in_review: Number(a.dm_in_review), approved: Number(a.dm_approved) },
        drafts: Number(a.drafts), pendingRequests: Number(a.pending), lastActionAt: a.last_action_at || null,
      }));
      const all = store.listRequests({ pendingFirst: true, limit: 1000 });
      const byStatus = { pending: 0, approved: 0, rejected: 0, changes_requested: 0, withdrawn: 0, stale: 0 };
      for (const r of all) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      res.json({
        projects,
        managers,
        authors,
        // Pending requests addressed to a disabled Project Manager: nobody can decide them until reassigned (V6).
        stuck: store.listStuckRequests().map((r) => ({
          id: r.id, projectId: r.project_id, projectName: r.project_name, title: r.publication_title, submittedAt: r.submitted_at,
          manager: { id: r.manager_id, name: r.manager_name }, submittedBy: r.submitted_by_name,
        })),
        requests: { byStatus, total: all.length, pending: all.filter((r) => r.status === 'pending').slice(0, 20).map((r) => requestOut(r)) },
        activity: teamActivity(store, withAuthors),
      });
    });

  // ---- 5b. override editing sessions ---------------------------------------

  app.post('/api/projects/:id/override-sessions',
    can('content.override.start', loaders.withReason(loaders.project)),
    body({ key: { type: 'string', required: true, max: 60, pattern: DOC_KEY, label: 'Document' }, reason: { type: 'string', required: true, max: 1000, label: 'Reason' } }),
    (req, res) => {
      const project = req.ctx.project;
      const key = req.valid.key;
      let label = { modules: 'the data module list', publication: 'the publication module and its wording', graphics: 'the graphics' }[key];
      if (key.startsWith('dm-')) {
        const dm = store.getDataModule(key.slice(3));
        if (!dm || dm.project_id !== project.id || dm.deleted_at) return sendError(res, 404, 'NOT_FOUND', 'Not found.');
        label = `data module ${dm.dmc}`;
      }
      // A new reason replaces any session the administrator still has open on this document.
      store.endOverrideSessionsFor(me(req).id, project.id, key, 'replaced', nowIso());
      const s = store.createOverrideSession({
        id: crypto.randomUUID(), adminId: me(req).id, authSessionId: req.auth.session.id, projectId: project.id, docKey: key, reason: req.valid.reason, now: nowIso(),
      });
      audit({
        actorId: me(req).id, actorUsername: me(req).username, ip: clientIp(req), projectId: project.id,
        action: 'override.session.started', targetType: 'project', targetId: project.id,
        meta: { key, reason: s.reason, sessionId: s.id, projectName: project.name },
      });
      res.status(201).json({ session: { id: s.id, key, label, reason: s.reason, startedAt: s.started_at, idleMinutes: 30 } });
    });

  app.post('/api/override-sessions/:sid/end',
    can('override.session.end', loaders.overrideSession),
    body({}),
    (req, res) => {
      store.endOverrideSession(req.ctx.session.id, 'left', nowIso());
      res.json({ ok: true });
    });

  // ---- 3. audit log ----------------------------------------------------------

  const AUDIT_QUERY = {
    user: { type: 'string', max: 64 },
    action: { type: 'string', max: 64, pattern: /^[a-z_.]+$/ },
    category: { type: 'string', max: 32, pattern: /^[a-z_]+$/ },
    project: { type: 'string', max: 64 },
    from: { type: 'string', max: 10, pattern: DATE, label: 'From' },
    to: { type: 'string', max: 10, pattern: DATE, label: 'To' },
    before: { type: 'string', max: 18, pattern: /^\d+$/ },
    limit: { type: 'string', max: 3, pattern: /^\d+$/ },
  };
  // Dates are whole UTC days, both ends included.
  function filtersOf(q) {
    const day = (d) => (d ? new Date(`${d}T00:00:00.000Z`) : null);
    const from = day(q.from);
    const to = day(q.to);
    return {
      actorId: q.user || null, action: q.action || null, actionPrefix: q.category ? `${q.category}.` : null, projectId: q.project || null,
      fromIso: from ? from.toISOString() : null, toIso: to ? new Date(to.getTime() + DAY_MS).toISOString() : null,
    };
  }

  app.get('/api/admin/audit',
    can('admin.audit'),
    query(AUDIT_QUERY),
    (req, res) => {
      const q = req.validQuery;
      const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
      const rows = store.listAudit({ ...filtersOf(q), beforeId: q.before ? Number(q.before) : null, limit: limit + 1 });
      const page = rows.slice(0, limit);
      res.json({ entries: page.map(presentRow), next: rows.length > limit ? String(page[page.length - 1].id) : null });
    });

  app.get('/api/admin/audit/actions',
    can('admin.audit'),
    (req, res) => res.json({
      actions: store.auditActions().map((a) => ({ action: a.action, count: Number(a.n) })),
      users: store.listUsers().map((u) => ({ id: u.id, username: u.username, fullName: u.full_name, role: u.role })),
      projects: store.listProjects().map((p) => ({ id: p.id, name: p.name })),
    }));

  app.get('/api/admin/audit.csv',
    can('admin.audit'),
    query(AUDIT_QUERY),
    (req, res) => {
      const q = req.validQuery;
      const filters = filtersOf(q);
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="agastya-audit-${nowIso().slice(0, 10)}.csv"`,
      });
      res.write('\uFEFF' + CSV_HEADER.join(',') + '\r\n');
      let n = 0;
      for (const row of store.iterateAudit(filters, EXPORT_MAX)) { res.write(csvLine(row) + '\r\n'); n++; }
      res.end();
      const summary = Object.entries(q).filter(([k]) => k !== 'before' && k !== 'limit').map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
      audit({ actorId: me(req).id, actorUsername: me(req).username, ip: clientIp(req), action: 'audit.exported', meta: { filters: summary, rows: n } });
    });

  // ---- 4. system health --------------------------------------------------------

  let checks = null;
  let checking = null;
  function runToolchain() {
    if (!checking) {
      checking = toolchain.runChecks().then((r) => { checks = { ...r, at: nowIso() }; return checks; }).finally(() => { checking = null; });
    }
    return checking;
  }

  async function healthOut() {
    const fresh = checks && now().getTime() - Date.parse(checks.at) < TOOLCHAIN_TTL_MS;
    const tc = fresh ? checks : await runToolchain();
    const db = path.join(dataDir, 'agastya.db');
    const st = store.dbStats();
    let disk = null;
    try { const s = fs.statfsSync(dataDir); disk = { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; } catch { disk = null; }
    return {
      toolchain: {
        checkedAt: tc.at, ok: tc.ok,
        tools: tc.tools,
        checks: tc.results.map((r) => ({ name: r.name, ok: r.ok, note: !!r.note, detail: r.detail })),
      },
      builds: {
        active: activeBuilds(),
        recent: store.listRecentBuilds(15).map((b) => ({ id: b.id, projectId: b.project_id, projectName: b.project_name, kind: b.kind, target: b.target, by: b.user_name, ok: !!b.ok, ms: b.ms, errorCode: b.error_code, at: b.at })),
      },
      storage: {
        database: { file: fileSize(db), wal: fileSize(`${db}-wal`), shm: fileSize(`${db}-shm`), pages: st.pageCount, pageSize: st.pageSize, freePages: st.freePages },
        projects: dirSize(path.join(dataDir, 'projects')),
        snapshots: dirSize(path.join(dataDir, 'snapshots')),
        disk,
      },
      // Phase 5: schedule, retention, the last good backup, and anything wrong (decisions.md K10).
      backup: backups.status(),
      runtime: { node: process.version, platform: `${process.platform} ${process.arch}`, uptimeSeconds: Math.round(process.uptime()) },
    };
  }

  app.get('/api/admin/health',
    can('admin.health'),
    handle(async (req, res) => res.json(await healthOut())));

  app.post('/api/admin/health/toolchain',
    can('admin.health'),
    body({}),
    handle(async (req, res) => {
      await runToolchain();
      res.json(await healthOut());
    }));

  // ---- 2. sessions -------------------------------------------------------------

  app.get('/api/admin/sessions',
    can('admin.sessions'),
    (req, res) => {
      res.json({
        sessions: store.listLiveSessions(nowIso()).map((s) => ({
          id: s.id, createdAt: s.created_at, expiresAt: s.expires_at, lastSeenAt: s.last_seen_at, ip: s.ip, userAgent: s.user_agent,
          user: { id: s.user_id, username: s.username, fullName: s.full_name, role: s.role },
          current: s.id === req.auth.session.id,
        })),
      });
    });
}

module.exports = { register };
