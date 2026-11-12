'use strict';
/*
  Project content (Phase 2, checkpoint 2a): data modules, revisions,
  validation, graphics, DMRL spreadsheets, publication wording settings
  and PDF output.

  Every route is guarded by can() with a content action (authz.js):
  content.read / content.build for anyone who can see the project,
  content.write for the Authors who own or are assigned to it. Every write
  of XML goes through the document service (content/documents.js), so the
  safety guard, conflict detection and revision history always apply.
*/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { loaders } = require('../auth/authz');
const { writeFileAtomic } = require('../content/workspace');
const { createKit } = require('./kit');
const workflow = require('../content/workflow');
const { body, query, validateObject } = require('../http/validate');
const { sendError } = require('../http/errors');
const { ContentError, assertWritableXml } = require('../content/xmlcheck');
const dmcLib = require('../content/dmc');
const { renderShell, listShells, SCHEMA_TYPES } = require('../content/shells');
const { validateModule, validateProject, brexIndex } = require('../content/validation');
const graphics = require('../content/graphics');
const dmrl = require('../content/dmrl');
const csdbPackage = require('../content/csdbPackage');
const formats = require('../formats');
const settingsLib = require('../content/settings');
const jssDocTypes = require('../content/jssDocTypes');
const convert = require('../content/convert');
const assets = require('../content/assets');
const releases = require('../content/releases');
const JSZip = require('jszip');
const { projectsApi, projectOut } = require('./projects');
const { LockedError } = require('../content/locks');
const pdf = require('../publish/pdf');
const { createBuildRunner } = require('../publish/runner');
const pmc = require('../../vendor/engine/pmc');
const { resolveDmRefs } = require('../../vendor/engine/resolveDmRefs');

const upload = (maxBytes) => multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 64 * 1024 } }).single('file');

// Per-module previews, kept for the inline viewer; never part of a build.
const PREVIEW_DIR = '.previews';

/*
  A PDF the client shows inline in a frame on its own page: this response
  alone may be framed by the same origin (the app default is DENY).
*/
function sendInlinePdf(res, buf, name) {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${name}"`,
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'",
  });
  res.send(buf);
}

const DMC_SCHEMA = {
  ...Object.fromEntries(dmcLib.NAMES.map((n) => [n, { type: 'string', required: true, max: 14 }])),
  learnCode: { type: 'string', max: 3 }, learnEventCode: { type: 'string', max: 1 },
};

// Defaults for new modules, as in the Agastya original (DMRL import and Create dialog).
const NEW_DM_DEFAULTS = { languageIsoCode: 'en', countryIsoCode: 'IN', securityClassification: '01', issueNumber: '001', inWork: '00' };

function dmOut(m) {
  return {
    id: m.id, dmc: m.dmc, file: path.posix.basename(m.rel_path), schemaType: m.schema_type, issue: m.issue,
    techName: m.tech_name, infoName: m.info_name, status: m.status,
    createdAt: m.created_at, updatedAt: m.updated_at, updatedBy: m.updated_by_name || null,
    deletedAt: m.deleted_at || null,
  };
}

const revOut = (r) => ({ id: r.id, reason: r.reason, createdAt: r.created_at, by: r.created_by_name || r.created_by_username || null, size: r.size, hash: r.hash });

function register(ctx) {
  const { app, store, authz, now, log, events, documents, locks } = ctx;
  const { can } = authz;
  // Auditing (with the administrator's overrides), the workspace and the error wrapper are shared (kit.js).
  const { me, nowIso, dirOf, auditContent, content, unlockOpts } = createKit(ctx);
  const builds = createBuildRunner({ store, events, log, now });

  // The content lock (decisions.md L1): the locked files of a project, and the guard on writes.
  const lockedOf = (req) => locks.lockedFiles(req.ctx.project.id);
  const assertUnlocked = (req, rel) => locks.assertUnlocked(me(req), req.ctx.project.id, rel, unlockOpts(req));
  /*
    Write guards. The administrator writes only inside an override session
    for the document being changed (decisions.md V3): a module's own text is
    its own document; creating, importing, deleting and restoring modules is
    the module list; the publication module and its wording are one; uploads
    are the graphics list.
  */
  const W = {
    modules: loaders.withOverride(loaders.project, () => 'modules'),
    moduleList: loaders.withOverride(loaders.dataModule, () => 'modules'),
    module: loaders.withOverride(loaders.dataModule, (req) => `dm-${req.params.dmId}`),
    publication: loaders.withOverride(loaders.project, () => 'publication'),
    graphics: loaders.withOverride(loaders.project, () => 'graphics'),
  };
  const needDm = (req, res) => {
    if (!req.ctx.dm) { sendError(res, 404, 'NOT_FOUND', 'Not found.'); return null; }
    return req.ctx.dm;
  };

  // The project's own BREX code, if it has one, for new modules to name;
  // otherwise the shell's reference is kept (BREX checks fall back to the default).
  function projectBrex(dir) {
    const first = [...brexIndex(dir).keys()][0];
    return (first && dmcLib.parseDmcString(first)) || null;
  }

  // Create the record and the file for a new data module from its XML.
  async function createModule(req, xml, reason) {
    const project = req.ctx.project;
    // Only formats with data modules hold them (decisions.md FM2): a JSS project is one book.
    if (!formats.adapter(project.format || 's1000d').capabilities.dataModules) {
      throw new ContentError(409, 'FORMAT_HAS_NO_MODULES', `A ${formats.adapter(project.format).label} project holds no data modules: its content is the book itself.`);
    }
    await assertWritableXml(xml); // the safety guard comes before anything reads the content
    const id = dmcLib.readIdentity(xml);
    if (!id.isDataModule || !id.dmc) throw new ContentError(400, 'NOT_A_DATA_MODULE', 'This is not an S1000D data module with a valid data module code in its dmIdent.');
    const code = dmcLib.formatDmc(id.dmc);
    if (store.findLiveDataModule(project.id, code)) throw new ContentError(409, 'DMC_TAKEN', `Data module ${code} already exists in this project.`);
    const { doc, revision } = await documents.writeDocument({
      project, rel: `csdb/${dmcLib.dmcFilename(id.dmc)}`, kind: 'dm', content: xml, userId: me(req).id, reason,
    });
    const dm = store.createDataModule({
      id: crypto.randomUUID(), projectId: project.id, documentId: doc.id, dmc: code,
      schemaType: id.schemaType || 'descript', issue: id.issue, techName: id.techName, infoName: id.infoName, userId: me(req).id, now: nowIso(),
    });
    return { dm, revision };
  }

  // Write an image where the build looks for it, and register it.
  function storeGraphic(req, { icn, rel, format, buffer, title = '' }) {
    const abs = documents.absFor(req.ctx.project, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    store.upsertGraphic({ id: crypto.randomUUID(), projectId: req.ctx.project.id, icn, relPath: rel, format, size: buffer.length, sha256: sha, title, userId: me(req).id, now: nowIso() });
    auditContent(req, 'graphic.uploaded', { targetType: 'graphic', targetId: icn, meta: { icn, format, size: buffer.length, file: rel } });
  }

  // ---- data modules -----------------------------------------------------

  app.get('/api/projects/:id/dms',
    can('content.read', loaders.project),
    query({ search: { type: 'string', max: 200 }, fields: { type: 'string', max: 40 }, deleted: { type: 'string', enum: ['0', '1'] } }),
    content(async (req, res) => {
      const dir = dirOf(req);
      const locked = lockedOf(req);
      let list = store.listDataModules(req.ctx.project.id, { includeDeleted: req.validQuery.deleted === '1' });
      const q = (req.validQuery.search || '').toLowerCase();
      if (q) {
        const fields = (req.validQuery.fields || 'title,code').split(',');
        list = list.filter((m) => {
          if (fields.includes('code') && m.dmc.toLowerCase().includes(q)) return true;
          if (fields.includes('title') && `${m.tech_name} ${m.info_name}`.toLowerCase().includes(q)) return true;
          if (fields.includes('content') && !m.deleted_at) {
            try {
              const text = fs.readFileSync(path.join(dir, m.rel_path), 'utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
              return text.includes(q);
            } catch { return false; }
          }
          return false;
        });
      }
      res.json({ modules: list.map((m) => ({ ...dmOut(m), locked: !m.deleted_at && locked.has(m.rel_path) })), lock: [...locked.values()][0] || null, schemaTypes: Object.entries(SCHEMA_TYPES).map(([id, t]) => ({ id, label: t.label })), shells: listShells() });
    }));

  app.post('/api/projects/:id/dms',
    can('content.write', W.modules),
    body({
      dmc: { type: 'object', required: true },
      techName: { type: 'string', required: true, max: 200, label: 'Technical name' },
      infoName: { type: 'string', max: 200, label: 'Information name' },
      schemaType: { type: 'string', required: true, enum: Object.keys(SCHEMA_TYPES), label: 'Schema' },
      templateId: { type: 'string', max: 20, pattern: /^[a-z]+\d\d$/, label: 'Shell' },
      languageIsoCode: { type: 'string', max: 3, pattern: /^[a-z]{2,3}$/, label: 'Language' },
      countryIsoCode: { type: 'string', max: 2, pattern: /^[A-Z]{2}$/, label: 'Country' },
      securityClassification: { type: 'string', max: 20, pattern: /^(\d{2}|UNCLASSIFIED|RESTRICTED|CONFIDENTIAL|SECRET|TOP SECRET)$/i, label: 'Security classification' },
      issueNumber: { type: 'string', max: 3, pattern: /^\d{3}$/, label: 'Issue number' },
      inWork: { type: 'string', max: 2, pattern: /^\d{2}$/, label: 'In work' },
      originator: { type: 'string', max: 5, pattern: /^[A-Z0-9]{5}$/i, label: 'Originator CAGE' },
      rpcCode: { type: 'string', max: 5, pattern: /^[A-Z0-9]{5}$/i, label: 'RPC CAGE' },
    }),
    content(async (req, res) => {
      const shape = validateObject(DMC_SCHEMA, req.valid.dmc);
      if (!shape.ok) return sendError(res, 400, shape.code, shape.error);
      const v = dmcLib.validateDmc(shape.value);
      if (!v.ok) return sendError(res, 400, 'VALIDATION', v.error);
      const dir = dirOf(req);
      let xml;
      try {
        xml = renderShell({
          ...NEW_DM_DEFAULTS, ...req.valid, dmc: v.dmc, brex: projectBrex(dir), date: now(),
          originator: req.valid.originator && req.valid.originator.toUpperCase(), rpcCode: req.valid.rpcCode && req.valid.rpcCode.toUpperCase(),
        });
      } catch { return sendError(res, 400, 'VALIDATION', 'That shell does not exist for the chosen schema.'); }
      const shell = req.valid.templateId || (listShells().find((x) => x.schemaType === req.valid.schemaType) || {}).id;
      const { dm, revision } = await createModule(req, xml, `Created from shell ${shell}`);
      auditContent(req, 'dm.created', { targetType: 'dm', targetId: dm.id, meta: { dmc: dm.dmc, schemaType: dm.schema_type } });
      res.status(201).json({ ok: true, module: dmOut(dm), revision: revision.id });
    }));

  // Import a single XML data module, sent as text.
  app.post('/api/projects/:id/dms/import',
    can('content.write', W.modules),
    body({ filename: { type: 'string', max: 200 }, content: { type: 'password', required: true, max: 8 * 1024 * 1024 } }),
    content(async (req, res) => {
      const { dm, revision } = await createModule(req, req.valid.content, `Imported${req.valid.filename ? ` from ${path.basename(req.valid.filename).slice(0, 120)}` : ''}`);
      auditContent(req, 'dm.imported', { targetType: 'dm', targetId: dm.id, meta: { dmc: dm.dmc } });
      res.status(201).json({ ok: true, module: dmOut(dm), revision: revision.id });
    }));

  app.get('/api/projects/:id/dms/:dmId',
    can('content.read', loaders.dataModule),
    content(async (req, res) => {
      const dm = needDm(req, res); if (!dm) return;
      const doc = store.getDocument(dm.document_id);
      if (dm.deleted_at) {
        const head = store.headRevision(doc.id);
        return res.json({ module: dmOut(dm), xml: documents.revisionContent(head), revision: head.id, readOnly: true });
      }
      const { content: xml, head } = documents.readDocument(req.ctx.project, doc);
      const lock = locks.lockOf(req.ctx.project.id, dm.rel_path);
      res.json({ module: dmOut(dm), xml, revision: head.id, revisionBy: head.created_by_name || null, revisionAt: head.created_at, lock });
    }));

  // Save. Conflict detection is revision-based: 409 if baseRevision is stale.
  app.put('/api/projects/:id/dms/:dmId',
    can('content.write', W.module),
    body({ xml: { type: 'password', required: true, max: 8 * 1024 * 1024 }, baseRevision: { type: 'integer', required: true, min: 1 } }),
    content(async (req, res) => {
      const dm = needDm(req, res); if (!dm) return;
      if (dm.deleted_at) return sendError(res, 409, 'DELETED', 'Restore this data module before editing it.');
      const project = req.ctx.project;
      assertUnlocked(req, dm.rel_path);
      await assertWritableXml(req.valid.xml);
      const id = dmcLib.readIdentity(req.valid.xml);
      if (!id.isDataModule || !id.dmc) return sendError(res, 400, 'NOT_A_DATA_MODULE', 'The XML must stay an S1000D data module with a valid data module code.');
      const newCode = dmcLib.formatDmc(id.dmc);
      if (newCode !== dm.dmc && store.findLiveDataModule(project.id, newCode)) {
        return sendError(res, 409, 'DMC_TAKEN', `Data module ${newCode} already exists in this project.`);
      }
      let doc = store.getDocument(dm.document_id);
      const { revision } = await documents.writeDocument({
        project, doc, content: req.valid.xml, baseRevision: req.valid.baseRevision, userId: me(req).id, reason: 'Saved',
      });
      // The code is the file name: a changed code renames the file, history follows.
      if (newCode !== dm.dmc) {
        doc = documents.moveDocument(project, doc, `csdb/${dmcLib.dmcFilename(id.dmc)}`);
        auditContent(req, 'dm.renamed', { targetType: 'dm', targetId: dm.id, meta: { from: dm.dmc, to: newCode } });
      }
      store.updateDataModule(dm.id, {
        dmc: newCode, schema_type: id.schemaType || dm.schema_type, issue: id.issue, tech_name: id.techName, info_name: id.infoName,
      }, me(req).id, nowIso());
      // An approved module that is changed is a draft again (decisions.md M3).
      const backToDraft = workflow.afterSave(store, dm);
      auditContent(req, 'dm.saved', { targetType: 'dm', targetId: dm.id, meta: { dmc: newCode, revision: revision.id, ...(backToDraft ? { status: 'approved->draft' } : {}) } });
      store.deleteDraft(me(req).id, req.ctx.project.id, `dm-${dm.id}`); // the save supersedes the autosaved draft
      res.json({ ok: true, module: dmOut(store.getDataModule(dm.id)), revision: revision.id });
    }));

  // Soft delete: the file moves to .deleted/ (never built); record and history are kept.
  app.delete('/api/projects/:id/dms/:dmId',
    can('content.write', W.moduleList),
    body({}),
    content(async (req, res) => {
      const dm = needDm(req, res); if (!dm) return;
      if (dm.deleted_at) return res.json({ ok: true, module: dmOut(dm) });
      assertUnlocked(req, dm.rel_path);
      const doc = store.getDocument(dm.document_id);
      documents.readDocument(req.ctx.project, doc); // record any outside change before moving
      documents.moveDocument(req.ctx.project, doc, `.deleted/${dm.id}-${path.posix.basename(doc.rel_path)}`, { deleted: nowIso() });
      store.updateDataModule(dm.id, { deleted_at: nowIso(), deleted_by: me(req).id }, me(req).id, nowIso());
      auditContent(req, 'dm.deleted', { targetType: 'dm', targetId: dm.id, meta: { dmc: dm.dmc } });
      res.json({ ok: true, module: dmOut(store.getDataModule(dm.id)) });
    }));

  app.post('/api/projects/:id/dms/:dmId/restore',
    can('content.write', W.moduleList),
    body({}),
    content(async (req, res) => {
      const dm = needDm(req, res); if (!dm) return;
      if (!dm.deleted_at) return res.json({ ok: true, module: dmOut(dm) });
      if (store.findLiveDataModule(req.ctx.project.id, dm.dmc)) return sendError(res, 409, 'DMC_TAKEN', `Another data module ${dm.dmc} now exists in this project.`);
      const doc = store.getDocument(dm.document_id);
      const parsed = dmcLib.parseDmcString(dm.dmc);
      documents.moveDocument(req.ctx.project, doc, `csdb/${dmcLib.dmcFilename(parsed)}`, { deleted: null });
      store.updateDataModule(dm.id, { deleted_at: null, deleted_by: null }, me(req).id, nowIso());
      auditContent(req, 'dm.restored', { targetType: 'dm', targetId: dm.id, meta: { dmc: dm.dmc } });
      res.json({ ok: true, module: dmOut(store.getDataModule(dm.id)) });
    }));

  app.get('/api/projects/:id/dms/:dmId/revisions',
    can('content.read', loaders.dataModule),
    content(async (req, res) => {
      const dm = needDm(req, res); if (!dm) return;
      res.json({ revisions: store.listRevisions(dm.document_id).map(revOut) });
    }));

  app.get('/api/projects/:id/dms/:dmId/revisions/:revId',
    can('content.read', loaders.dataModule),
    content(async (req, res) => {
      const dm = needDm(req, res); if (!dm) return;
      const rev = /^\d{1,12}$/.test(req.params.revId) ? store.getRevision(req.params.revId) : null;
      if (!rev || rev.document_id !== dm.document_id) return sendError(res, 404, 'NOT_FOUND', 'Not found.');
      res.json({ revision: revOut({ ...rev, size: Buffer.byteLength(documents.revisionContent(rev)) }), xml: documents.revisionContent(rev) });
    }));

  // Validate the saved module, or text from the editor (not saved).
  app.post('/api/projects/:id/dms/:dmId/validate',
    can('content.read', loaders.dataModule),
    body({ xml: { type: 'password', max: 8 * 1024 * 1024 }, issue: { type: 'string', max: 4, pattern: /^(auto|[0-9][.][0-9])$/, label: 'Issue' } }),
    content(async (req, res) => {
      const dm = needDm(req, res); if (!dm) return;
      const dir = dirOf(req);
      const text = req.valid.xml !== undefined ? req.valid.xml
        : dm.deleted_at ? documents.revisionContent(store.headRevision(dm.document_id))
          : documents.readDocument(req.ctx.project, store.getDocument(dm.document_id)).content;
      res.json(await validateModule(dir, dm.rel_path, text, { schemaType: dm.schema_type, issue: req.valid.issue || null }));
    }));

  app.post('/api/projects/:id/validate',
    can('content.read', loaders.project),
    body({}),
    content(async (req, res) => {
      const dir = dirOf(req);
      let result;
      if (req.ctx.project.format === 'jss') {
        // A JSS book is checked by its adapter, and its images must be where it names them (decisions.md FM3).
        let text = '';
        try { text = fs.readFileSync(path.join(dir, 'publication.xml'), 'utf8'); } catch { /* reported below */ }
        const findings = text ? formats.checkJss(text) : [{ sev: 'error', kind: 'jss', rel: 'publication.xml', line: 1, message: 'publication.xml is missing.' }];
        for (const m of text.matchAll(/<(?:graphic|image|emblem|logo)\b[^>]*\bsrc="([^"]+)"/g)) {
          const rel = m[1];
          if (/^[A-Za-z][\w+.-]*:|\.\.|^\//.test(rel) || !fs.existsSync(path.join(dir, rel))) findings.push({ sev: 'error', kind: 'graphic', rel: 'publication.xml', line: text.slice(0, m.index).split('\n').length, message: `The image ${rel} is not in the project.` });
        }
        const counts = { error: findings.filter((f) => f.sev === 'error').length, warning: findings.filter((f) => f.sev === 'warning').length, info: 0, modules: 0 };
        result = { counts, findings, format: 'jss' };
      } else {
        const mods = store.listDataModules(req.ctx.project.id).map((m) => ({ rel: m.rel_path, schemaType: m.schema_type }));
        result = await validateProject(dir, mods);
      }
      store.recordValidation({ projectId: req.ctx.project.id, userId: me(req).id, errors: result.counts.error, warnings: result.counts.warning, modules: result.counts.modules, now: nowIso() });
      res.json(result);
    }));

  // ---- publication module (raw XML; the structured builder arrives in 2b) -----

  app.get('/api/projects/:id/publication',
    can('content.read', loaders.project),
    content(async (req, res) => {
      const doc = documents.ensureDocument(req.ctx.project, 'publication.xml', 'pm');
      const { content: xml, head } = documents.readDocument(req.ctx.project, doc);
      res.json({ xml, revision: head.id, revisionBy: head.created_by_name || null, revisionAt: head.created_at, lock: locks.lockOf(req.ctx.project.id, 'publication.xml') });
    }));

  /*
    Save guards, from the Agastya original (services/PmcService.writePm):
    the index must read back as a publication module (vendor/engine/pmc.js),
    and an index with no entries is refused unless ?allowEmpty=1, because it
    builds a book with no content. The original's publication.xml.bak is
    covered by the immutable revision history. Entries that name no data
    module in the project are reported, not refused (the author may be
    planning ahead); validation and the build report them as errors.
  */
  app.put('/api/projects/:id/publication',
    can('content.write', W.publication),
    query({ allowEmpty: { type: 'string', enum: ['0', '1', 'true', 'false'] } }),
    body({ xml: { type: 'password', required: true, max: 8 * 1024 * 1024 }, baseRevision: { type: 'integer', required: true, min: 1 } }),
    content(async (req, res) => {
      // A JSS project's publication is its book, checked by the JSS adapter (decisions.md FM3).
      if (req.ctx.project.format === 'jss') {
        assertUnlocked(req, 'publication.xml');
        await assertWritableXml(req.valid.xml);
        const findings = formats.checkJss(req.valid.xml);
        const err = findings.find((f) => f.sev === 'error');
        if (err) return sendError(res, 400, 'NOT_A_JSS_BOOK', err.message);
        const doc = documents.ensureDocument(req.ctx.project, 'publication.xml', 'pm');
        const { revision } = await documents.writeDocument({ project: req.ctx.project, doc, content: req.valid.xml, baseRevision: req.valid.baseRevision, userId: me(req).id, reason: 'Saved' });
        auditContent(req, 'publication.saved', { targetType: 'project', targetId: req.ctx.project.id, meta: { revision: revision.id, via: 'jss' } });
        store.deleteDraft(me(req).id, req.ctx.project.id, 'publication');
        return res.json({ ok: true, revision: revision.id, counts: null, unresolved: [], warnings: findings.map((f) => `Line ${f.line}: ${f.message}`).slice(0, 50) });
      }
      if (!/<pm[\s>]/.test(req.valid.xml) || /<dmodule[\s>]/.test(req.valid.xml)) {
        return sendError(res, 400, 'NOT_A_PUBLICATION_MODULE', 'The XML must be an S1000D publication module (<pm>).');
      }
      assertUnlocked(req, 'publication.xml');
      await assertWritableXml(req.valid.xml);
      let parsed;
      try { parsed = pmc.parsePm(req.valid.xml); } catch { return sendError(res, 400, 'NOT_A_PUBLICATION_MODULE', 'The XML must be an S1000D publication module with a <pm> root element.'); }
      const counts = pmc.countEntries(parsed.entries);
      const allowEmpty = ['1', 'true'].includes(req.validQuery.allowEmpty);
      if (counts.total === 0 && !allowEmpty) {
        return sendError(res, 400, 'EMPTY_PUBLICATION', 'Refusing to save an empty publication: it has no chapters or data module entries. Save again with "allow empty" if that is intended.');
      }
      const unresolved = (resolveDmRefs(req.valid.xml, path.join(dirOf(req), 'csdb'), 'csdb').unresolved || []).map((u) => ({ code: u.code, title: u.title || '' }));
      const doc = documents.ensureDocument(req.ctx.project, 'publication.xml', 'pm');
      const { revision } = await documents.writeDocument({
        project: req.ctx.project, doc, content: req.valid.xml, baseRevision: req.valid.baseRevision, userId: me(req).id, reason: 'Saved',
      });
      auditContent(req, 'publication.saved', { targetType: 'project', targetId: req.ctx.project.id, meta: { revision: revision.id, entries: counts.total, unresolved: unresolved.length } });
      store.deleteDraft(me(req).id, req.ctx.project.id, 'publication');
      res.json({ ok: true, revision: revision.id, counts, unresolved, warnings: parsed.warnings.slice(0, 50) });
    }));

  // ---- publication wording (project.json frontMatter.labels) -----------------

  /*
    The fixed JSS wording on the front-matter pages, as project settings. A
    blank value means the default (the JSS text); "-" leaves an authority
    line out. Stored where the engine already reads label overrides
    (frontMatter.labels.<page>.<key> -> $fm.label.<page>.<key>).
  */
  const WORDING = {
    authorityHeading: { page: 'title', key: 'authorityHeading', label: 'Authority heading', default: 'Under the Authority of' },
    authority: { page: 'title', key: 'authority', label: 'Authority line', default: 'Secretary, Ministry of Defence, Govt. of India' },
    documentNo: { page: 'foreword', key: 'documentNo', label: 'Document number label', default: 'L&T Document No.: ' },
  };
  const projectJsonPath = (req) => path.join(dirOf(req), 'project.json');
  function readProjectJson(req) {
    try { return JSON.parse(fs.readFileSync(projectJsonPath(req), 'utf8')); } catch { throw new ContentError(500, 'SETTINGS_UNREADABLE', 'The project settings could not be read.'); }
  }
  const wordingOf = (pj) => Object.fromEntries(Object.entries(WORDING).map(([k, w]) => {
    const v = pj.frontMatter && pj.frontMatter.labels && pj.frontMatter.labels[w.page] && pj.frontMatter.labels[w.page][w.key];
    return [k, typeof v === 'string' ? v : ''];
  }));
  const wordingDefaults = () => Object.fromEntries(Object.entries(WORDING).map(([k, w]) => [k, { label: w.label, default: w.default }]));

  app.get('/api/projects/:id/settings/wording',
    can('content.read', loaders.project),
    content(async (req, res) => {
      res.json({ wording: wordingOf(readProjectJson(req)), fields: wordingDefaults(), lock: locks.lockOf(req.ctx.project.id, 'project.json') });
    }));

  app.put('/api/projects/:id/settings/wording',
    can('content.write', W.publication),
    body(Object.fromEntries(Object.entries(WORDING).map(([k, w]) => [k, { type: 'string', max: 200, pattern: /^[^\u0000-\u001f\u007f]*$/, label: w.label }]))),
    content(async (req, res) => {
      assertUnlocked(req, 'project.json'); // the build settings of a submitted publication are frozen with it
      const pj = readProjectJson(req);
      const before = wordingOf(pj);
      pj.frontMatter = pj.frontMatter && typeof pj.frontMatter === 'object' ? pj.frontMatter : {};
      pj.frontMatter.labels = pj.frontMatter.labels && typeof pj.frontMatter.labels === 'object' ? pj.frontMatter.labels : {};
      const changed = [];
      for (const [k, w] of Object.entries(WORDING)) {
        if (req.valid[k] === undefined) continue;
        // The document number follows its label directly, so the label keeps a trailing space (as the default does).
        const v = req.valid[k].trim() === '' ? '' : (k === 'documentNo' && req.valid[k] !== '-' ? `${req.valid[k].trimEnd()} ` : req.valid[k]);
        const page = pj.frontMatter.labels[w.page] && typeof pj.frontMatter.labels[w.page] === 'object' ? pj.frontMatter.labels[w.page] : {};
        if (v === '') delete page[w.key]; else page[w.key] = v;
        pj.frontMatter.labels[w.page] = page;
        if ((before[k] || '') !== v) changed.push(k);
      }
      writeFileAtomic(projectJsonPath(req), JSON.stringify(pj, null, 2) + '\n');
      if (changed.length) auditContent(req, 'settings.wording_changed', { targetType: 'project', targetId: req.ctx.project.id, meta: { fields: changed } });
      res.json({ ok: true, wording: wordingOf(pj), changed });
    }));

  // ---- PDF -----------------------------------------------------------------

  app.post('/api/projects/:id/dms/:dmId/preview',
    can('content.build', loaders.dataModule),
    body({}),
    content(async (req, res) => {
      const dm = needDm(req, res); if (!dm) return;
      if (dm.deleted_at) return sendError(res, 409, 'DELETED', 'A deleted data module cannot be previewed.');
      const dir = dirOf(req);
      const r = await builds.run({ project: req.ctx.project, dir, kind: 'preview', user: me(req), target: dm.dmc, dmRel: dm.rel_path });
      const buf = fs.readFileSync(r.pdf);
      // Kept per module so the editor can show it inline (GET .../preview.pdf).
      writeFileAtomic(path.join(dir, PREVIEW_DIR, `${dm.id}.pdf`), buf);
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${path.posix.basename(dm.rel_path, '.xml')}-preview.pdf"`, 'X-Build-Ms': String(r.totalMs) });
      res.send(buf);
    }));

  /*
    A built PDF is served only while it still is what a build now would be
    (decisions.md RL4): made from the same content and settings, in the
    same release state, and the file the build wrote. Otherwise it is
    refused, whoever asks and however, so a PDF built while released (no
    NOT RELEASED mark) cannot be fetched once the content has moved on, and
    one built before an approval does not pass for the approved one.
  */
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  function currentness(req, build, buf) {
    const dir = dirOf(req);
    const st = releases.stateOf(store, req.ctx.project, dir);
    let settings = null;
    try { settings = sha(fs.readFileSync(path.join(dir, 'project.json'))); } catch { /* none */ }
    const why = !build || !build.pdf_sha256 ? 'it was built before build records were kept'
      : build.pdf_sha256 !== sha(buf) ? 'the file is not the one the last build wrote'
        : build.fingerprint !== st.fingerprint ? 'the content changed after it was built'
          : build.settings_hash !== settings ? 'the publication settings changed after it was built'
            : !!build.released !== st.released ? (st.released ? 'the publication has been approved since: build it again for the released copy' : 'the release it carried no longer matches the content')
              : st.released && build.release_number !== st.releaseNumber ? 'a newer release has been approved'
                : null;
    return { ok: !why, why, state: st };
  }
  function sendBuilt(req, res, build, buf, name, { download = false } = {}) {
    const c = currentness(req, build, buf);
    if (!c.ok) return res.status(409).json({ error: `This PDF is out of date: ${c.why}. Build it again.`, code: 'PDF_OUT_OF_DATE', release: { released: c.state.released, releaseNumber: c.state.releaseNumber } });
    res.set({
      'X-Agastya-Release': c.state.released ? `Release ${c.state.releaseNumber}` : 'NOT RELEASED',
      'X-Agastya-Fingerprint': build.fingerprint || '', 'X-Agastya-Build': String(build.id),
    });
    if (download) {
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"` });
      ctx.audit({ actorId: me(req).id, actorUsername: me(req).username, ip: ctx.clientIp(req), projectId: req.ctx.project.id, action: 'publication.downloaded', targetType: 'project', targetId: req.ctx.project.id,
        meta: { buildId: build.id, released: !!build.released, releaseNumber: build.release_number, marking: build.marking } });
      return res.send(buf);
    }
    return sendInlinePdf(res, buf, name);
  }

  app.get('/api/projects/:id/dms/:dmId/preview.pdf',
    can('content.read', loaders.dataModule),
    query({ v: { type: 'string', max: 20, pattern: /^\d+$/ } }),
    (req, res) => {
      const dm = needDm(req, res); if (!dm) return;
      const file = path.join(dirOf(req), PREVIEW_DIR, `${dm.id}.pdf`);
      if (!fs.existsSync(file)) return sendError(res, 404, 'NOT_BUILT', 'No preview has been built for this data module yet.');
      sendBuilt(req, res, store.lastGoodBuild(req.ctx.project.id, 'preview', dm.dmc), fs.readFileSync(file), `${path.posix.basename(dm.rel_path, '.xml')}-preview.pdf`);
    });

  /*
    The text of each page of a module's preview (Phase 9, decisions.md SW3):
    the editor finds the page that holds what is selected. The same
    currentness rule applies: no text from a preview that is out of date.
  */
  const pageTextCache = new Map();
  app.get('/api/projects/:id/dms/:dmId/preview/pages',
    can('content.read', loaders.dataModule),
    content(async (req, res) => {
      const dm = needDm(req, res); if (!dm) return;
      const file = path.join(dirOf(req), PREVIEW_DIR, `${dm.id}.pdf`);
      if (!fs.existsSync(file)) return sendError(res, 404, 'NOT_BUILT', 'No preview has been built for this data module yet.');
      const buf = fs.readFileSync(file);
      const build = store.lastGoodBuild(req.ctx.project.id, 'preview', dm.dmc);
      const c = currentness(req, build, buf);
      if (!c.ok) return sendError(res, 409, 'PDF_OUT_OF_DATE', `This preview is out of date: ${c.why}.`);
      const key = sha(buf);
      if (!pageTextCache.has(key)) {
        const { extractPdfText } = await import('../../scripts/pdf-text.mjs');
        const tmp = path.join(require('node:os').tmpdir(), `agastya-pages-${key}.pdf`);
        fs.writeFileSync(tmp, buf);
        try { pageTextCache.set(key, (await extractPdfText(tmp)).pages.map((p) => p.replace(/\s+/g, ' ').trim())); } finally { fs.rmSync(tmp, { force: true }); }
        if (pageTextCache.size > 50) pageTextCache.delete(pageTextCache.keys().next().value);
      }
      res.json({ pages: pageTextCache.get(key), buildId: build.id, revision: build.fingerprint });
    }));

  app.post('/api/projects/:id/build',
    can('content.build', loaders.project),
    body({}),
    content(async (req, res) => {
      const dir = dirOf(req);
      const r = await builds.run({ project: req.ctx.project, dir, kind: 'full', user: me(req) });
      auditContent(req, 'publication.built', { targetType: 'project', targetId: req.ctx.project.id, meta: { ms: r.totalMs } });
      res.json({ ok: true, totalMs: r.totalMs, messages: r.messages, notes: r.notes, marking: r.marking, provenance: r.provenance, pdfUrl: `/api/projects/${req.ctx.project.id}/output.pdf` });
    }));

  app.get('/api/projects/:id/output.pdf',
    can('content.read', loaders.project),
    query({ download: { type: 'string', enum: ['0', '1'] }, v: { type: 'string', max: 20, pattern: /^\d+$/ } }),
    (req, res) => {
      const file = path.join(dirOf(req), pdf.OUTPUT.pdf);
      if (!fs.existsSync(file)) return sendError(res, 404, 'NOT_BUILT', 'The publication has not been built yet.');
      const name = `${req.ctx.project.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'publication'}.pdf`;
      sendBuilt(req, res, store.lastGoodBuild(req.ctx.project.id, 'full'), fs.readFileSync(file), name, { download: req.validQuery.download === '1' });
    });

  app.get('/api/projects/:id/builds/last',
    can('content.read', loaders.project),
    (req, res) => {
      const b = store.lastBuild(req.ctx.project.id, 'full');
      const v = store.lastValidation(req.ctx.project.id);
      const file = path.join(dirOf(req), pdf.OUTPUT.pdf);
      const built = fs.existsSync(file);
      const good = store.lastGoodBuild(req.ctx.project.id, 'full');
      const c = built ? currentness(req, good, fs.readFileSync(file)) : { ok: false, why: null, state: releases.stateOf(store, req.ctx.project, dirOf(req)) };
      res.json({
        build: b ? { ok: !!b.ok, ms: b.ms, at: b.at, by: b.user_name || null, errorCode: b.error_code, marking: b.marking || null, released: b.released == null ? null : !!b.released, releaseNumber: b.release_number, fingerprint: b.fingerprint } : null,
        validation: v ? { errors: v.errors, warnings: v.warnings, modules: v.modules, at: v.at } : null,
        pdfAvailable: built,
        pdfCurrent: built && c.ok,
        outOfDate: built && !c.ok ? c.why : null,
        release: { released: c.state.released, releaseNumber: c.state.releaseNumber, approvedAt: c.state.approvedAt, stale: c.state.stale },
      });
    });

  // ---- graphics --------------------------------------------------------------

  app.get('/api/projects/:id/graphics',
    can('content.read', loaders.project),
    content(async (req, res) => {
      const dir = dirOf(req);
      const live = store.listDataModules(req.ctx.project.id);
      const texts = live.map((m) => { try { return { m, text: fs.readFileSync(path.join(dir, m.rel_path), 'utf8') }; } catch { return null; } }).filter(Boolean);
      const declared = graphics.declaredEntities(texts.map((t) => t.text));
      // Keyed case-insensitively; the modules' spelling is shown.
      const refs = new Map();
      for (const t of texts) for (const icn of graphics.referencedIcns(t.text)) {
        const k = graphics.icnKey(icn);
        if (!refs.has(k)) refs.set(k, { icn, usedBy: [] });
        refs.get(k).usedBy.push(t.m.dmc);
      }
      const registry = new Map(store.listGraphics(req.ctx.project.id).map((g) => [graphics.icnKey(g.icn), g]));
      const keys = new Set([...refs.keys(), ...registry.keys()]);
      const out = [...keys].sort().map((k) => {
        const g = registry.get(k);
        const icn = refs.has(k) ? refs.get(k).icn : g.icn;
        const found = graphics.findFile(dir, icn, declared);
        const exp = graphics.expectedLocation(icn, declared);
        return {
          icn, title: g ? g.title : '', usedBy: refs.has(k) ? refs.get(k).usedBy : [], expected: exp.rel, file: found,
          present: !!found, resolves: found === exp.rel, format: g ? g.format : null, size: g ? g.size : null,
          uploadedBy: g ? g.uploaded_by_name : null, uploadedAt: g ? g.uploaded_at : null,
        };
      });
      res.json({ graphics: out, counts: { total: out.length, missing: out.filter((g) => g.usedBy.length && !g.present).length } });
    }));

  app.post('/api/projects/:id/graphics',
    can('content.write', W.graphics),
    upload(graphics.MAX_GRAPHIC_BYTES),
    content(async (req, res) => {
      const fields = validateObject({ icn: { type: 'string', max: 90 }, title: { type: 'string', max: 200 } }, req.body || {});
      if (!fields.ok) return sendError(res, 400, fields.code, fields.error);
      if (!req.file) return sendError(res, 400, 'VALIDATION', 'Choose an image file to upload.');
      const given = graphics.normaliseIcn(fields.value.icn || path.basename(req.file.originalname || ''));
      if (!graphics.ICN_RE.test(given)) return sendError(res, 400, 'BAD_ICN', 'The ICN must look like ICN-…, using letters, digits and hyphens only.');
      const format = graphics.detectFormat(req.file.buffer);
      if (!format) return sendError(res, 415, 'UNSUPPORTED_IMAGE', 'Only PNG, JPEG and GIF images are accepted.');

      const dir = dirOf(req);
      const texts = store.listDataModules(req.ctx.project.id).map((m) => { try { return fs.readFileSync(path.join(dir, m.rel_path), 'utf8'); } catch { return ''; } });
      const icn = graphics.canonicalIcn(given, texts.flatMap((t) => graphics.referencedIcns(t)));
      const place = graphics.placeFor(icn, format, graphics.declaredEntities(texts));
      assertUnlocked(req, place.rel); // a graphic of a submitted publication is frozen with it
      storeGraphic(req, { icn, rel: place.rel, format, buffer: req.file.buffer, title: fields.value.title });
      res.status(201).json({ ok: true, icn, file: place.rel, expected: place.expected, resolves: place.matches, warning: place.warning });
    }));

  app.get('/api/projects/:id/graphics/next-icn',
    can('content.read', loaders.project),
    (req, res) => {
      const dir = dirOf(req);
      const existing = [...graphics.icnFiles(dir), ...store.listGraphics(req.ctx.project.id).map((g) => g.icn)];
      const live = store.listDataModules(req.ctx.project.id);
      const model = live[0] ? live[0].dmc.split('-')[0] : req.ctx.project.name;
      res.json({ icn: graphics.nextIcn(existing, model), existing: new Set(existing.map(graphics.icnKey)).size });
    });

  app.get('/api/projects/:id/graphics/:icn/file',
    can('content.read', loaders.project),
    (req, res) => {
      const icn = graphics.normaliseIcn(req.params.icn);
      if (!graphics.ICN_RE.test(icn)) return sendError(res, 400, 'BAD_ICN', 'Invalid ICN.');
      const dir = dirOf(req);
      const texts = store.listDataModules(req.ctx.project.id).map((m) => { try { return fs.readFileSync(path.join(dir, m.rel_path), 'utf8'); } catch { return ''; } });
      const rel = graphics.findFile(dir, icn, graphics.declaredEntities(texts));
      const abs = rel && documents.absFor(req.ctx.project, rel);
      if (!abs || !fs.existsSync(abs)) return sendError(res, 404, 'NOT_FOUND', 'Not found.');
      const buf = fs.readFileSync(abs);
      const format = graphics.detectFormat(buf);
      if (!format) return sendError(res, 415, 'UNSUPPORTED_IMAGE', 'Not a supported image.');
      res.set({ 'Content-Type': graphics.MIME[format], 'Content-Disposition': 'inline' });
      res.send(buf);
    });

  // ---- DMRL ------------------------------------------------------------------

  app.get('/api/projects/:id/dmrl',
    can('content.read', loaders.project),
    content(async (req, res) => {
      const buf = await dmrl.exportDmrl(req.ctx.project, store.listDataModules(req.ctx.project.id));
      const name = `DMRL-${req.ctx.project.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || req.ctx.project.id}.xlsx`;
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name}"` });
      res.send(buf);
    }));

  const DMRL_FIELDS = { schemaType: { type: 'string', enum: [...Object.keys(SCHEMA_TYPES), 'auto'], label: 'Schema' } };

  async function readUpload(req) {
    if (!req.file) throw new ContentError(400, 'VALIDATION', 'Choose a DMRL spreadsheet (.xlsx) to upload.');
    try { return await dmrl.readDmrl(req.file.buffer); } catch { throw new ContentError(400, 'UNREADABLE', 'The spreadsheet could not be read. Save it as an Excel .xlsx workbook and try again.'); }
  }

  app.post('/api/projects/:id/dmrl/preview',
    can('content.write', W.modules),
    upload(10 * 1024 * 1024),
    content(async (req, res) => {
      const fields = validateObject(DMRL_FIELDS, req.body || {});
      if (!fields.ok) return sendError(res, 400, fields.code, fields.error);
      const sheet = await readUpload(req);
      const choice = fields.value.schemaType || 'descript';
      const existing = new Set(store.listDataModules(req.ctx.project.id).map((m) => m.dmc));
      res.json({
        sheetName: sheet.sheetName, columns: sheet.columns, skipped: sheet.skipped,
        rows: sheet.rows.map((r) => ({ row: r.row, dmc: r.dmcString, techName: r.techName, infoName: r.infoName, status: r.status, schemaType: dmrl.schemaFor(choice, r.dmc), exists: existing.has(r.dmcString) })),
      });
    }));

  app.post('/api/projects/:id/dmrl/import',
    can('content.write', W.modules),
    upload(10 * 1024 * 1024),
    content(async (req, res) => {
      const fields = validateObject({ ...DMRL_FIELDS, rows: { type: 'string', max: 20000, pattern: /^\d+(,\d+)*$/ } }, req.body || {});
      if (!fields.ok) return sendError(res, 400, fields.code, fields.error);
      const sheet = await readUpload(req);
      const wanted = fields.value.rows ? new Set(fields.value.rows.split(',').map(Number)) : null;
      const dir = dirOf(req);
      const created = [], duplicates = [];
      for (const r of sheet.rows) {
        if (wanted && !wanted.has(r.row)) continue;
        if (store.findLiveDataModule(req.ctx.project.id, r.dmcString)) { duplicates.push({ row: r.row, dmc: r.dmcString }); continue; }
        // The sheet carries no security, language or issue data: the original's defaults apply.
        const xml = renderShell({ ...NEW_DM_DEFAULTS, schemaType: dmrl.schemaFor(fields.value.schemaType || 'descript', r.dmc), dmc: r.dmc, techName: r.techName || 'Untitled', infoName: r.infoName, brex: projectBrex(dir), date: now() });
        const { dm } = await createModule(req, xml, 'Created from DMRL import');
        created.push(dmOut(dm));
      }
      auditContent(req, 'dmrl.imported', { targetType: 'project', targetId: req.ctx.project.id, meta: { created: created.length, duplicates: duplicates.length, skipped: sheet.skipped.length } });
      res.json({ ok: true, created, duplicates, skipped: sheet.skipped });
    }));

  // ---- CSDB packages (Phase 6, decisions.md CX1 to CX6) -----------------------

  app.get('/api/projects/:id/package.zip',
    can('content.read', loaders.project),
    content(async (req, res) => {
      const project = req.ctx.project;
      const { buffer, manifest } = await csdbPackage.exportPackage({
        dir: dirOf(req), project, modules: store.listDataModules(project.id), by: me(req).fullName || me(req).username, now: now(),
      });
      // A read: audited, but not announced as a content change.
      ctx.audit({ actorId: me(req).id, actorUsername: me(req).username, ip: ctx.clientIp(req), projectId: project.id, action: 'package.exported', targetType: 'project', targetId: project.id,
        meta: { modules: manifest.counts.modules, graphics: manifest.counts.graphics, bytes: buffer.length, missing: manifest.missing.length } });
      const name = `CSDB-${project.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || project.id}.zip`;
      res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` });
      res.send(buffer);
    }));

  const packageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: csdbPackage.MAX_PACKAGE_BYTES, files: 1, fields: 4, fieldSize: 1024 } }).single('file');

  // The plan for an upload in this project (decisions.md CX3); nothing is written.
  async function planFor(req, { validate }) {
    if (!req.file) throw new ContentError(400, 'VALIDATION', 'Choose a .zip package to upload.');
    const pkg = await csdbPackage.readPackage(req.file.buffer);
    const project = req.ctx.project;
    const dir = dirOf(req);
    const live = store.listDataModules(project.id);
    const projectTexts = live.map((m) => { try { return fs.readFileSync(path.join(dir, m.rel_path), 'utf8'); } catch { return ''; } });
    const index = validate ? brexIndex(dir) : null;
    return csdbPackage.planImport(pkg, {
      dir, liveCodes: new Set(live.map((m) => m.dmc)), projectTexts, locked: lockedOf(req),
      validate: validate ? async (rel, text) => {
        const r = await validateModule(dir, rel, text, { index });
        const errors = r.findings.filter((f) => f.sev === 'error');
        return { errors: errors.length, firstError: errors[0] ? `${errors[0].kind === 'brex' ? 'BREX' : 'Schema'}, line ${errors[0].line}: ${errors[0].message}`.slice(0, 300) : null, issue: r.issue.used, schemaChecked: !!r.schema };
      } : null,
    });
  }

  app.post('/api/projects/:id/package/preview',
    can('content.write', W.modules),
    packageUpload,
    content(async (req, res) => {
      res.json(csdbPackage.planOut(await planFor(req, { validate: true })));
    }));

  /*
    The import writes what the plan accepts, modules first. Each one goes
    through the write path and is audited as any import is; a file that can
    no longer be written (taken meanwhile) is reported, and the rest go on.
  */
  app.post('/api/projects/:id/package/import',
    can('content.write', W.modules),
    packageUpload,
    content(async (req, res) => {
      const plan = await planFor(req, { validate: false });
      const name = path.basename(String(req.file.originalname || 'package.zip')).slice(0, 120);
      const done = { modules: [], graphics: [], failed: [] };
      for (const it of plan.items.filter((x) => x.status === 'import' && x.kind === 'module')) {
        try {
          const { dm } = await createModule(req, it._write.text, `Imported from package ${name}`);
          auditContent(req, 'dm.imported', { targetType: 'dm', targetId: dm.id, meta: { dmc: dm.dmc } });
          done.modules.push(dmOut(dm));
        } catch (e) {
          if (!(e instanceof ContentError)) throw e;
          done.failed.push({ name: it.name, message: e.message });
        }
      }
      for (const it of plan.items.filter((x) => x.status === 'import' && x.kind === 'graphic')) {
        try {
          assertUnlocked(req, it.target);
          if (fs.existsSync(documents.absFor(req.ctx.project, it.target))) throw new ContentError(409, 'PATH_TAKEN', 'A file with that name is already in the project.');
          storeGraphic(req, { icn: it._write.icn, rel: it.target, format: it._write.format, buffer: it._write.buffer });
          done.graphics.push({ icn: it.icn, file: it.target });
        } catch (e) {
          if (!(e instanceof ContentError) && !(e instanceof LockedError)) throw e;
          done.failed.push({ name: it.name, message: e.message });
        }
      }
      auditContent(req, 'package.imported', { targetType: 'project', targetId: req.ctx.project.id, meta: {
        modules: done.modules.length, graphics: done.graphics.length, failed: done.failed.length,
        skipped: plan.counts.exists + plan.counts.duplicate, refused: plan.counts.refused, ignored: plan.counts.ignored,
      } });
      res.json({ ok: true, ...done, plan: csdbPackage.planOut(plan) });
    }));

  // ---- New projects from a file (Phase 6.5, decisions.md WS3) -----------------------

  const NEW_FIELDS = {
    name: { type: 'string', required: true, min: 3, max: 80, label: 'Project name' },
    description: { type: 'string', max: 500, label: 'Description' },
    format: { type: 'string', max: 10, label: 'Format' },
    workspaceId: { type: 'string', max: 64 },
    folderId: { type: 'string', max: 64 },
    members: { type: 'string', max: 2000, pattern: /^[A-Za-z0-9_,-]*$/ },
  };
  const newFields = (req) => {
    const f = validateObject(NEW_FIELDS, req.body || {});
    if (!f.ok) throw new ContentError(400, f.code, f.error);
    return { ...f.value, members: (f.value.members || '').split(',').filter(Boolean) };
  };
  // Create the project, or answer the CreateError as a ContentError.
  function makeProject(req, fields, format) {
    try { return projectsApi.create(req, { ...fields, format }); } catch (e) {
      if (e instanceof projectsApi.CreateError) throw new ContentError(e.status, e.code, e.message);
      throw e;
    }
  }
  const formatMismatch = (chosen, found) => (chosen && chosen !== found
    ? new ContentError(400, 'FORMAT_MISMATCH', `The file is ${formats.adapter(found).label}, not ${formats.adapter(chosen) ? formats.adapter(chosen).label : chosen}. Choose ${formats.adapter(found).label} as the format.`)
    : null);
  // Write the publication of a new project through the write path.
  async function writePublication(req, text, reason) {
    const doc = documents.ensureDocument(req.ctx.project, 'publication.xml', 'pm');
    const { head } = documents.readDocument(req.ctx.project, doc); // records the scaffold as the first revision
    return documents.writeDocument({ project: req.ctx.project, doc, content: text, baseRevision: head.id, userId: me(req).id, reason });
  }

  /*
    A project from one XML file: a data module, a publication module or a
    JSS book. Everything is checked before the project is created, so a
    refused file leaves nothing behind. Authors only: a Project Manager
    creates empty projects and does not write content (D2).
  */
  app.post('/api/projects/from-xml',
    can('project.import'),
    upload(csdbPackage.MAX_XML_UPLOAD),
    content(async (req, res) => {
      const fields = newFields(req);
      if (formats.UNAVAILABLE[fields.format]) throw new ContentError(400, 'FORMAT_UNAVAILABLE', formats.UNAVAILABLE[fields.format]);
      if (!req.file) throw new ContentError(400, 'VALIDATION', 'Choose the XML file the project starts from.');
      const dec = csdbPackage.decodeXml(req.file.buffer);
      if (dec.error) throw new ContentError(400, 'NOT_UTF8', dec.error);
      const text = dec.text;
      await assertWritableXml(text);
      const det = formats.detect(text);
      if (!det || !det.format) throw new ContentError(400, 'UNKNOWN_FORMAT', `The root element is <${det ? det.root : '?'}>: not an S1000D data module (<dmodule>), publication module (<pm>) or JSS book (<jssbook>).`);
      const mismatch = formatMismatch(fields.format, det.format);
      if (mismatch) throw mismatch;
      if (det.kind === 'dm') {
        const id = dmcLib.readIdentity(text);
        if (!id.dmc) throw new ContentError(400, 'NOT_A_DATA_MODULE', 'The data module has no valid data module code in its dmIdent.');
      } else if (det.kind === 'pm') {
        try { pmc.parsePm(text); } catch { throw new ContentError(400, 'NOT_A_PUBLICATION_MODULE', 'The publication module cannot be read.'); }
      } else {
        const err = formats.checkJss(text).find((f) => f.sev === 'error');
        if (err) throw new ContentError(400, 'NOT_A_JSS_BOOK', err.message);
      }
      const project = makeProject(req, fields, det.format);
      req.ctx = { project };
      const file = path.basename(String(req.file.originalname || 'source.xml')).slice(0, 120);
      let imported;
      if (det.kind === 'dm') {
        const { dm } = await createModule(req, text, `Imported from ${file}`);
        auditContent(req, 'dm.imported', { targetType: 'dm', targetId: dm.id, meta: { dmc: dm.dmc } });
        imported = { kind: 'module', module: dmOut(dm) };
      } else {
        const { revision } = await writePublication(req, text, `Imported from ${file}`);
        auditContent(req, 'publication.imported', { targetType: 'project', targetId: project.id, meta: { revision: revision.id } });
        imported = { kind: det.kind === 'pm' ? 'publication' : 'book' };
      }
      res.status(201).json({ ok: true, project: projectOut({ ...store.getProject(project.id), author_count: fields.members.length }), imported });
    }));

  /*
    A project from a package (an Agastya export or any zip of modules and
    graphics): planned against an empty workspace first; nothing is created
    when nothing can be imported. Then the modules, graphics, branding,
    publication and checked settings are written, as for any import.
  */
  app.post('/api/projects/from-package',
    can('project.import'),
    packageUpload,
    content(async (req, res) => {
      const fields = newFields(req);
      if (formats.UNAVAILABLE[fields.format]) throw new ContentError(400, 'FORMAT_UNAVAILABLE', formats.UNAVAILABLE[fields.format]);
      if (!req.file) throw new ContentError(400, 'VALIDATION', 'Choose a .zip package to upload.');
      const pkg = await csdbPackage.readPackage(req.file.buffer);
      const empty = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'agastya-plan-'));
      let plan;
      try {
        fs.mkdirSync(path.join(empty, 'csdb')); fs.mkdirSync(path.join(empty, 'Media'));
        plan = await csdbPackage.planImport(pkg, { dir: empty, liveCodes: new Set(), newProject: true });
      } finally { fs.rmSync(empty, { recursive: true, force: true }); }
      const mismatch = formatMismatch(fields.format, plan.format);
      if (mismatch) throw mismatch;
      const importable = plan.items.filter((x) => x.status === 'import' && ['module', 'publication'].includes(x.kind));
      if (!importable.length) throw new ContentError(400, 'NOTHING_TO_IMPORT', 'The package holds no data module or publication that can be imported.', { plan: csdbPackage.planOut(plan) });
      const project = makeProject(req, fields, plan.format);
      req.ctx = { project };
      const dir = dirOf(req);
      const name = path.basename(String(req.file.originalname || 'package.zip')).slice(0, 120);
      const done = { modules: [], graphics: [], branding: [], publication: false, settings: null, failed: [] };
      for (const it of plan.items.filter((x) => x.status === 'import')) {
        try {
          if (it.kind === 'module') {
            const { dm } = await createModule(req, it._write.text, `Imported from package ${name}`);
            auditContent(req, 'dm.imported', { targetType: 'dm', targetId: dm.id, meta: { dmc: dm.dmc } });
            done.modules.push(dmOut(dm));
          } else if (it.kind === 'graphic') {
            storeGraphic(req, { icn: it._write.icn, rel: it.target, format: it._write.format, buffer: it._write.buffer });
            done.graphics.push({ icn: it.icn, file: it.target });
          } else if (it.kind === 'branding') {
            fs.writeFileSync(documents.absFor(project, it.target), it._write.buffer);
            done.branding.push(it.target);
          }
        } catch (e) {
          if (!(e instanceof ContentError)) throw e;
          done.failed.push({ name: it.name, message: e.message });
        }
      }
      const pubItem = plan.items.find((x) => x.status === 'import' && x.kind === 'publication');
      if (pubItem) {
        try { await writePublication(req, pubItem._write.text, `Imported from package ${name}`); done.publication = true; } catch (e) {
          if (!(e instanceof ContentError)) throw e;
          done.failed.push({ name: pubItem.name, message: e.message });
        }
      }
      const setItem = plan.items.find((x) => x.status === 'import' && x.kind === 'settings');
      if (setItem) {
        const pjPath = path.join(dir, 'project.json');
        const r = settingsLib.fromPackage(setItem._write.json, JSON.parse(fs.readFileSync(pjPath, 'utf8')), { mediaDir: path.join(dir, 'Media') });
        writeFileAtomic(pjPath, JSON.stringify(r.pj, null, 2) + '\n');
        done.settings = { applied: r.applied, dropped: r.dropped };
      }
      auditContent(req, 'package.imported', { targetType: 'project', targetId: project.id, meta: {
        modules: done.modules.length, graphics: done.graphics.length, failed: done.failed.length,
        skipped: plan.counts.exists + plan.counts.duplicate, refused: plan.counts.refused, ignored: plan.counts.ignored,
      } });
      res.status(201).json({ ok: true, project: projectOut({ ...store.getProject(project.id), author_count: fields.members.length }), ...done, plan: csdbPackage.planOut(plan) });
    }));

  // ---- Format conversion (Phase 7, decisions.md FM4, FM5) ---------------------------

  /*
    Convert a project into a new project of another format. The source is
    never changed: it is built in a temporary copy, the result goes into a
    new project, and the new project keeps a copy of the source files under
    source/ with the conversion report. Authors only, as for any project
    that starts with content (WS3).
  */
  app.post('/api/projects/:id/convert',
    can('content.read', loaders.project),
    body({ to: { type: 'string', required: true, max: 10 }, name: { type: 'string', required: true, min: 3, max: 80, label: 'Project name' } }),
    content(async (req, res) => {
      const source = req.ctx.project;
      if (!authz.evaluate(me(req), 'project.import', {}).ok) return sendError(res, 403, 'FORBIDDEN', 'Authors convert projects: the result is a new project with content.');
      const problem = formats.conversionProblem(source.format || 's1000d', req.valid.to);
      if (problem) return sendError(res, 400, 'CONVERSION_UNSUPPORTED', problem);
      const srcDir = dirOf(req);
      const modules = store.listDataModules(source.id);
      if (!modules.length) return sendError(res, 400, 'NOTHING_TO_CONVERT', 'The project has no data modules to convert.');
      let out;
      try { out = await convert.s1000dToJss({ srcDir, modules, log }); } catch (e) {
        if (e instanceof convert.ConvertError) return sendError(res, e.status, e.code, e.message);
        throw e;
      }
      await assertWritableXml(out.book);
      const findings = formats.checkJss(out.book);
      const bad = findings.find((f) => f.sev === 'error');
      if (bad) return sendError(res, 422, 'CONVERSION_FAILED', `The converted book is not a valid JSS book: ${bad.message}`);
      out.report.warnings = findings.filter((f) => f.sev === 'warning').map((f) => f.message);

      const project = makeProject(req, { name: req.valid.name, description: `Converted from ${source.name} (S1000D).` }, 'jss');
      const backTo = req.ctx;
      req.ctx = { project };
      const dir = dirOf(req);
      const { revision } = await writePublication(req, out.book, `Converted from ${source.name}`);
      for (const img of out.images) {
        const abs = documents.absFor(project, img.rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, img.buffer);
      }
      // The layout, page and watermark settings come along; identity is already in the book's <bookmeta>.
      const pjPath = path.join(dir, 'project.json');
      const carried = settingsLib.fromPackage(JSON.parse(fs.readFileSync(path.join(srcDir, 'project.json'), 'utf8')), JSON.parse(fs.readFileSync(pjPath, 'utf8')), { mediaDir: path.join(dir, 'Media') });
      writeFileAtomic(pjPath, JSON.stringify({ ...carried.pj, type: 'JSS', pipeline: 's1000dtojss' }, null, 2) + '\n');
      // The original, kept beside the result (never built).
      for (const rel of [...modules.map((m) => m.rel_path), 'publication.xml', 'project.json']) {
        const from = path.join(srcDir, rel);
        if (!fs.existsSync(from)) continue;
        const to = path.join(dir, 'source', rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
      const report = { ...out.report, sourceProject: { id: source.id, name: source.name }, settingsCarried: carried.applied, preservedIn: 'source/' };
      writeFileAtomic(path.join(dir, 'source', 'conversion-report.json'), JSON.stringify(report, null, 2) + '\n');
      auditContent(req, 'project.converted', { targetType: 'project', targetId: project.id, meta: { from: 's1000d', to: 'jss', sourceProjectName: source.name, revision: revision.id, lossy: report.lossy } });
      req.ctx = backTo;
      res.status(201).json({ ok: true, project: projectOut({ ...store.getProject(project.id), author_count: 0 }), report });
    }));

  app.get('/api/projects/:id/conversion-report',
    can('content.read', loaders.project),
    (req, res) => {
      const file = path.join(dirOf(req), 'source', 'conversion-report.json');
      if (!fs.existsSync(file)) return sendError(res, 404, 'NOT_FOUND', 'This project was not made by a conversion.');
      res.json({ report: JSON.parse(fs.readFileSync(file, 'utf8')) });
    });

  // ---- Graphics module: ICNs, symbols and parts (Phase 8, decisions.md GR1-GR6) ----

  // Shared with the cross-project graphics library (routes/graphics.js, decisions.md GL2).
  const moduleTexts = (req) => assets.moduleTextsOf(dirOf(req), store.listDataModules(req.ctx.project.id));
  const assetTexts = (req) => assets.assetTextsOf(dirOf(req), req.ctx.project, store.listDataModules(req.ctx.project.id));

  app.get('/api/projects/:id/assets',
    can('content.read', loaders.project),
    content(async (req, res) => {
      const mods = assetTexts(req);
      const { icns, symbols } = assets.icnCatalogue(dirOf(req), mods, store.listGraphics(req.ctx.project.id));
      const parts = assets.partsCatalogue(mods);
      const problems = [...icns, ...symbols].reduce((n, r) => n + r.problems.length, 0) + parts.reduce((n, p) => n + p.problems.length, 0);
      res.json({ icns, symbols, parts, problems, ipdModules: mods.filter((m) => /<illustratedPartsCatalog[\s>]/.test(m.text)).map((m) => ({ id: m.id, dmc: m.dmc })) });
    }));

  const icnParam = (req) => {
    const icn = graphics.normaliseIcn(req.params.icn);
    if (!graphics.ICN_RE.test(icn)) throw new ContentError(400, 'BAD_ICN', 'Invalid ICN.');
    return icn;
  };

  app.patch('/api/projects/:id/graphics/:icn',
    can('content.write', W.graphics),
    body({ title: { type: 'string', required: true, max: 200, pattern: /^[^\u0000-\u001f\u007f]*$/, label: 'Title' } }),
    content(async (req, res) => {
      const icn = icnParam(req);
      if (!store.setGraphicTitle(req.ctx.project.id, icn, req.valid.title.trim())) return sendError(res, 404, 'NOT_FOUND', 'That graphic is not registered in this project. Upload it first.');
      auditContent(req, 'graphic.updated', { targetType: 'graphic', targetId: icn, meta: { icn, fields: ['title'] } });
      res.json({ ok: true });
    }));

  // A graphic is deleted only when nothing refers to it (GR4): a referenced one would become missing artwork.
  app.delete('/api/projects/:id/graphics/:icn',
    can('content.write', W.graphics),
    body({}),
    content(async (req, res) => {
      const icn = icnParam(req);
      const dir = dirOf(req);
      const mods = assetTexts(req);
      const users = mods.filter((m) => assets.usesOf(m.text).has(graphics.icnKey(icn))).map((m) => m.dmc);
      if (users.length) return sendError(res, 409, 'GRAPHIC_IN_USE', `${icn} is used by ${users.slice(0, 5).join(', ')}${users.length > 5 ? ', …' : ''}. Remove those references first.`);
      const rel = graphics.findFile(dir, icn, graphics.declaredEntities(mods.map((m) => m.text)));
      if (rel) assertUnlocked(req, rel);
      const had = store.deleteGraphic(req.ctx.project.id, icn);
      if (rel) fs.rmSync(documents.absFor(req.ctx.project, rel), { force: true });
      if (!had && !rel) return sendError(res, 404, 'NOT_FOUND', 'Not found.');
      auditContent(req, 'graphic.deleted', { targetType: 'graphic', targetId: icn, meta: { icn, file: rel || null } });
      res.json({ ok: true });
    }));

  // ICNs and symbols as a zip at their project paths, with their metadata; read back by Import package (GR5).
  app.get('/api/projects/:id/graphics.zip',
    can('content.read', loaders.project),
    query({ kind: { type: 'string', enum: ['icn', 'symbol', 'all'] } }),
    content(async (req, res) => {
      const kind = req.validQuery.kind || 'all';
      const dir = dirOf(req);
      const cat = assets.icnCatalogue(dir, assetTexts(req), store.listGraphics(req.ctx.project.id));
      const rows = kind === 'icn' ? cat.icns : kind === 'symbol' ? cat.symbols : [...cat.icns, ...cat.symbols];
      const zip = new JSZip();
      const listed = [];
      for (const r of rows) {
        if (!r.file) continue;
        zip.file(r.file, fs.readFileSync(path.join(dir, r.file)));
        listed.push({ icn: r.icn, kind: r.kind, file: r.file, title: r.title, sha256: r.sha256, usedBy: r.usedBy });
      }
      zip.file('graphics.json', JSON.stringify({ project: req.ctx.project.name, kind, exportedAt: nowIso(), graphics: listed }, null, 2));
      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      ctx.audit({ actorId: me(req).id, actorUsername: me(req).username, ip: ctx.clientIp(req), projectId: req.ctx.project.id, action: 'graphics.exported', targetType: 'project', targetId: req.ctx.project.id, meta: { kind, graphics: listed.length } });
      res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="GRAPHICS-${kind}-${req.ctx.project.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60)}.zip"` });
      res.send(buf);
    }));

  // A part goes into an IPD module through the write path, as any edit of that module (GR3).
  app.post('/api/projects/:id/parts',
    can('content.write', loaders.withOverride(loaders.project, (req) => `dm-${req.body && req.body.dmId}`)),
    body({
      dmId: { type: 'string', required: true, max: 64 }, figureNumber: { type: 'string', required: true, max: 4 }, item: { type: 'string', required: true, max: 4 },
      indenture: { type: 'string', max: 1 }, partNumber: { type: 'string', required: true, max: 32 }, manufacturer: { type: 'string', required: true, max: 5 },
      description: { type: 'string', max: 200 }, quantity: { type: 'string', max: 4 },
    }),
    content(async (req, res) => {
      const dm = store.listDataModules(req.ctx.project.id).find((m) => m.id === req.valid.dmId);
      if (!dm) return sendError(res, 404, 'NOT_FOUND', 'That data module is not in this project.');
      assertUnlocked(req, dm.rel_path);
      const doc = store.getDocument(dm.document_id);
      const { content: xml, head } = documents.readDocument(req.ctx.project, doc);
      let next;
      try { next = assets.addPart(xml, req.valid); } catch (e) {
        if (e instanceof assets.PartError) return sendError(res, 400, e.code, e.message);
        throw e;
      }
      const { revision } = await documents.writeDocument({ project: req.ctx.project, doc, content: next, baseRevision: head.id, userId: me(req).id, reason: `Added part ${req.valid.partNumber}` });
      workflow.afterSave(store, dm); // an approved module that changes is a draft again (M3)
      auditContent(req, 'dm.saved', { targetType: 'dm', targetId: dm.id, meta: { dmc: dm.dmc, revision: revision.id } });
      res.status(201).json({ ok: true, revision: revision.id });
    }));

  // ---- DMC and PMC files (Phase 8, decisions.md GR6) -------------------------------

  app.get('/api/projects/:id/dms/:dmId/file',
    can('content.read', loaders.dataModule),
    content(async (req, res) => {
      const dm = needDm(req, res); if (!dm) return;
      const doc = store.getDocument(dm.document_id);
      const xml = dm.deleted_at ? documents.revisionContent(store.headRevision(doc.id)) : documents.readDocument(req.ctx.project, doc).content;
      res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${path.posix.basename(dm.rel_path)}"` });
      res.send(xml);
    }));

  app.get('/api/projects/:id/publication/file',
    can('content.read', loaders.project),
    content(async (req, res) => {
      const doc = documents.ensureDocument(req.ctx.project, 'publication.xml', 'pm');
      const { content: xml } = documents.readDocument(req.ctx.project, doc);
      const base = req.ctx.project.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'publication';
      res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${req.ctx.project.format === 'jss' ? 'JSS' : 'PMC'}-${base}.xml"` });
      res.send(xml);
    }));

  // ---- Publication settings (Phase 8, decisions.md ST1-ST7) ------------------------

  // What the project builds with under its own settings: the house template merged in (vendor/engine/config.js).
  const houseOf = (dir) => { try { const { effective } = pdf.loadConfig(dir); return { layout: effective.layout, branding: effective.branding }; } catch { return {}; } };
  const mediaImages = (dir) => { try { return fs.readdirSync(path.join(dir, 'Media')).filter((f) => /\.(png|jpe?g|gif)$/i.test(f)).sort().map((f) => `Media/${f}`); } catch { return []; } };
  // Which settings groups a format has (ST2): a JSS book carries its identity and publishers itself.
  const groupsFor = (format) => (format === 'jss' ? ['identity', 'page', 'type', 'watermark'] : settingsLib.GROUPS);

  app.get('/api/projects/:id/settings',
    can('content.read', loaders.project),
    content(async (req, res) => {
      const dir = dirOf(req);
      const pj = readProjectJson(req);
      const current = settingsLib.read(pj, houseOf(dir));
      if (req.ctx.project.format === 'jss') {
        try { current.identity = { ...current.identity, ...formats.readBookmeta(fs.readFileSync(path.join(dir, 'publication.xml'), 'utf8')) }; } catch { /* no book */ }
      }
      res.json({
        settings: current, groups: groupsFor(req.ctx.project.format), format: req.ctx.project.format,
        options: { pageSizes: settingsLib.PAGE_SIZES, pipelines: settingsLib.PIPELINES, fonts: settingsLib.FONTS, watermarkStyles: settingsLib.WATERMARK_STYLES, classifications: settingsLib.CLASSIFICATIONS, identity: settingsLib.IDENTITY, documentTypes: settingsLib.DOCUMENT_TYPES },
        media: mediaImages(dir), lock: locks.lockOf(req.ctx.project.id, 'project.json'),
      });
    }));

  app.put('/api/projects/:id/settings/:group',
    can('content.write', W.publication),
    body({ value: { type: 'object', required: true } }),
    content(async (req, res) => {
      const group = req.params.group;
      const format = req.ctx.project.format || 's1000d';
      if (!groupsFor(format).includes(group)) return sendError(res, 400, 'NOT_FOR_FORMAT', group === 'publishers' || group === 'pipeline'
        ? `A ${formats.adapter(format).label} project has no ${group} setting: ${group === 'publishers' ? 'its publishers are part of the book (edit the XML)' : 'a book is always rendered by the JSS stylesheets'}.`
        : `Unknown settings group "${group.slice(0, 40)}".`);
      const dir = dirOf(req);
      // A JSS project's identity is written into its book, through the write path (ST2).
      if (format === 'jss' && group === 'identity') {
        assertUnlocked(req, 'publication.xml');
        let check;
        try { check = settingsLib.apply({}, 'identity', req.valid.value); } catch (e) {
          if (e instanceof settingsLib.SettingsError) return res.status(400).json({ error: e.message, code: e.code, field: e.field });
          throw e;
        }
        // The document type (decisions.md ST8) resolves to two more things the
        // chosen key alone cannot carry: the running head's short phrase
        // (written into bookmeta beside it) and the cover's title lines
        // (project.json frontMatter.titlePage(Joint).documentType - the one
        // mechanism jsstofo's title pages already read an override from).
        const dt = jssDocTypes.DOCUMENT_TYPES[check.publication.documentType];
        check.publication.documentTypeHeader = dt ? dt.header : '';
        const doc = documents.ensureDocument(req.ctx.project, 'publication.xml', 'pm');
        const { content: book, head } = documents.readDocument(req.ctx.project, doc);
        // A converted book's title page(s) are plain prelim content inlined
        // into it at conversion time (FM4), not read from project.json on
        // every build the way the direct S1000D pipeline's front matter is -
        // so the cover title is a field of the book itself, the same as
        // bookName and the rest of bookmeta just outside <titlePage>.
        const next = formats.writeBookmeta(dt ? formats.writeTitlePageDocType(book, dt.lines) : book, check.publication);
        const { revision } = await documents.writeDocument({ project: req.ctx.project, doc, content: next, baseRevision: head.id, userId: me(req).id, reason: 'Identity changed in Settings' });
        auditContent(req, 'settings.changed', { targetType: 'project', targetId: req.ctx.project.id, meta: { group, fields: Object.keys(req.valid.value), revision: revision.id } });
        return res.json({ ok: true, settings: { ...settingsLib.read(readProjectJson(req), houseOf(dir)), identity: formats.readBookmeta(next) } });
      }
      assertUnlocked(req, 'project.json'); // the build settings of a submitted publication are frozen with it
      let next;
      try { next = settingsLib.apply(readProjectJson(req), group, req.valid.value, { mediaDir: path.join(dir, 'Media') }); } catch (e) {
        if (e instanceof settingsLib.SettingsError) return res.status(400).json({ error: e.message, code: e.code, field: e.field });
        throw e;
      }
      writeFileAtomic(projectJsonPath(req), JSON.stringify(next, null, 2) + '\n');
      auditContent(req, 'settings.changed', { targetType: 'project', targetId: req.ctx.project.id, meta: { group, fields: Array.isArray(req.valid.value) ? ['publishers'] : Object.keys(req.valid.value) } });
      res.json({ ok: true, settings: settingsLib.read(next, houseOf(dir)) });
    }));

  // Branding images (emblem, publisher logos) into Media/, by a safe name and recognised by content (ST4).
  app.post('/api/projects/:id/branding',
    can('content.write', W.publication),
    upload(8 * 1024 * 1024),
    content(async (req, res) => {
      if (!req.file) return sendError(res, 400, 'VALIDATION', 'Choose an image to upload.');
      const given = String(req.file.originalname || '');
      if (/[\\/]/.test(given)) return sendError(res, 400, 'BAD_NAME', 'Give the image a plain file name, without a folder.');
      const name = given.replace(/\s+/g, '-');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(png|jpe?g|gif)$/i.test(name)) return sendError(res, 400, 'BAD_NAME', 'Name the image with letters, digits, dots, hyphens or underscores, ending .png, .jpg or .gif.');
      if (graphics.ICN_RE.test(name.replace(/\.[^.]+$/, ''))) return sendError(res, 400, 'BAD_NAME', 'That is an ICN: upload it on the Graphics tab.');
      const format = graphics.detectFormat(req.file.buffer);
      if (!format) return sendError(res, 415, 'UNSUPPORTED_IMAGE', 'Only PNG, JPEG and GIF images are accepted.');
      const rel = `Media/${name}`;
      assertUnlocked(req, rel);
      fs.mkdirSync(path.join(dirOf(req), 'Media'), { recursive: true });
      fs.writeFileSync(documents.absFor(req.ctx.project, rel), req.file.buffer);
      auditContent(req, 'branding.uploaded', { targetType: 'project', targetId: req.ctx.project.id, meta: { file: rel, format, size: req.file.size } });
      res.status(201).json({ ok: true, file: rel, media: mediaImages(dirOf(req)) });
    }));
}

module.exports = { register };
