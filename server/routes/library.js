'use strict';
/*
  Cross-project views for the Author Panel redesign: a graphics library over
  every project the signed-in person can see (decisions.md GL1-GL3), and a
  backup download of one or every such project as a zip (decisions.md GL4).

  Neither is a new store of its own. The graphics library re-reads the same
  per-project catalogue (content/assets.js, already used by
  GET /api/projects/:id/assets) across every visible project; the backup
  download reuses the existing CSDB package export
  (content/csdbPackage.js exportPackage, already used by
  GET /api/projects/:id/package.zip) and nests each project's zip, unopened,
  inside one outer zip.

    GET /api/graphics                                every ICN and symbol across visible projects, with which can be uploaded to
    GET /api/backup/projects                         which visible projects can be backed up (id, name, format)
    GET /api/backup/all.zip                           one zip of every visible project's CSDB package
*/

const policy = require('../auth/policy');
const assets = require('../content/assets');
const csdbPackage = require('../content/csdbPackage');
const JSZip = require('jszip');

const { ADMIN } = policy.ROLES;

function register({ app, store, authz, now, clientIp, audit, documents }) {
  const { can } = authz;

  // Every project the caller can see (the same scope GET /api/projects uses).
  const visibleProjects = (user) => (user.role === ADMIN ? store.listProjects() : store.listProjects({ userId: user.id }));
  // Whether the caller writes this project's content (content.write, without an override: the library is read-only for the administrator).
  const mayWrite = (user, project) => project.owner_id === user.id || !!store.getMembership(project.id, user.id);

  app.get('/api/graphics',
    can('project.list'),
    (req, res) => {
      const me = req.auth.user;
      const projects = visibleProjects(me);
      const icns = [], symbols = [];
      for (const p of projects) {
        let dir;
        try { dir = documents.workspaceFor(p); } catch { continue; }
        const mods = assets.assetTextsOf(dir, p, store.listDataModules(p.id));
        const cat = assets.icnCatalogue(dir, mods, store.listGraphics(p.id));
        const tag = { projectId: p.id, projectName: p.name, projectFormat: p.format || 's1000d', canWrite: me.role !== ADMIN && mayWrite(me, p) };
        for (const r of cat.icns) icns.push({ ...r, ...tag });
        for (const r of cat.symbols) symbols.push({ ...r, ...tag });
      }
      res.json({
        icns, symbols,
        // The projects an upload can go into: those the caller writes directly (the administrator uploads per-project, under an override).
        uploadTargets: projects.filter((p) => mayWrite(me, p)).map((p) => ({ id: p.id, name: p.name })),
      });
    });

  app.get('/api/backup/projects',
    can('project.list'),
    (req, res) => {
      const me = req.auth.user;
      res.json({ projects: visibleProjects(me).map((p) => ({ id: p.id, name: p.name, format: p.format || 's1000d', updatedAt: p.updated_at || p.created_at })) });
    });

  /*
    Every visible project's package.zip, nested unopened inside one outer
    zip, so a user downloads one file for everything they can see. A
    project whose package cannot be built (a workspace that fails to read)
    is skipped and named in the manifest rather than failing the whole
    download (as a single project's export never fails outright: missing
    files are listed, not fatal).
  */
  app.get('/api/backup/all.zip',
    can('project.list'),
    async (req, res) => {
      const me = req.auth.user;
      const projects = visibleProjects(me);
      const outer = new JSZip();
      const included = [], failed = [];
      for (const p of projects) {
        let dir;
        try { dir = documents.workspaceFor(p); } catch { failed.push(p.name); continue; }
        try {
          const { buffer, manifest } = await csdbPackage.exportPackage({ dir, project: p, modules: store.listDataModules(p.id), by: me.fullName || me.username, now: now() });
          const safe = p.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || p.id;
          outer.file(`${safe}-${p.id}.zip`, buffer);
          included.push({ id: p.id, name: p.name, modules: manifest.counts.modules, graphics: manifest.counts.graphics });
        } catch { failed.push(p.name); }
      }
      if (!included.length) return res.status(400).json({ error: 'None of your projects could be backed up.', code: 'NOTHING_TO_BACKUP' });
      outer.file('manifest.json', JSON.stringify({ exportedAt: now().toISOString(), exportedBy: me.username, projects: included, failed }, null, 2) + '\n');
      const buf = await outer.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      audit({ actorId: me.id, actorUsername: me.username, ip: clientIp(req), action: 'backup.bundle_exported', targetType: 'user', targetId: me.id,
        meta: { projects: included.length, failed: failed.length, bytes: buf.length } });
      const name = `AGASTYA-BACKUP-${now().toISOString().slice(0, 10)}.zip`;
      res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` });
      res.send(buf);
    });
}

module.exports = { register };
