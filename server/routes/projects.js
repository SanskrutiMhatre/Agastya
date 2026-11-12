'use strict';
// Projects as governance records (Phase 1): create, list within scope, read,
// and assign or remove Authors. Each project has one owner, an Author or a
// Project Manager (decisions.md R9). The on-disk S1000D workspace is
// scaffolded in Phase 2. Anyone who is not the owner, an assigned Author or
// the administrator receives 404 for every project route.

const crypto = require('node:crypto');
const policy = require('../auth/policy');
const fs = require('node:fs');
const path = require('node:path');
const { evaluate, loaders, workspaceVisible } = require('../auth/authz');
const formats = require('../formats');
const { writeFileAtomic } = require('../content/workspace');
const { body, query } = require('../http/validate');
const { sendError } = require('../http/errors');

const { ADMIN } = policy.ROLES;

// Project ids become directory names in Phase 2, so they are generated,
// never taken from input.
const newProjectId = () => `prj-${crypto.randomBytes(5).toString('hex')}`;

const projectOut = (p) => ({
  id: p.id, name: p.name, description: p.description, status: p.status,
  format: p.format || 's1000d', workspaceId: p.workspace_id || null, folderId: p.folder_id || null,
  owner: { id: p.owner_id, username: p.owner_username, fullName: p.owner_name, role: p.owner_role },
  authorCount: p.author_count != null ? Number(p.author_count) : undefined,
  relation: p.relation || undefined,
  assignedAt: p.assigned_at || undefined,
  createdAt: p.created_at,
  updatedAt: p.updated_at || p.created_at,
});

const memberOut = (m) => ({
  id: m.user_id, username: m.username, fullName: m.full_name, addedAt: m.added_at,
  addedBy: m.added_by_username || null, status: m.disabled_at ? 'disabled' : m.onboarding_pending ? 'pending' : 'active',
});

const projectsApi = {};

function register({ app, store, authz, audit, now, clientIp, documents, overrides }) {
  const { can } = authz;
  const nowIso = () => now().toISOString();

  app.get('/api/projects',
    can('project.list'),
    query({ archived: { type: 'string', enum: ['0', '1', 'only'] } }),
    (req, res) => {
      const me = req.auth.user;
      // archived=1 shows active and archived together (to move one back); archived=only shows just the archived ones.
      const opts = { includeArchived: req.validQuery.archived === '1', onlyArchived: req.validQuery.archived === 'only' };
      // Administrator: everything. Anyone else: what they own or are assigned to.
      const rows = me.role === ADMIN ? store.listProjects(opts) : store.listProjects({ userId: me.id, ...opts });
      res.json({ projects: rows.map(projectOut) });
    });

  class CreateError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }

  /*
    Make a project (Phase 6.5, decisions.md WS2): the record, its place in a
    workspace (optional), its format (FM1), its first Authors, and the
    workspace on disk. Shared by plain creation and by creation from an XML
    file or a package (routes/content.js). Throws CreateError.
  */
  function createProject(req, { name, description = '', format = 's1000d', workspaceId = null, folderId = null, members = [] }) {
    const me = req.auth.user;
    name = String(name).replace(/\s+/g, ' ').trim();
    if (formats.UNAVAILABLE[format]) throw new CreateError(400, 'FORMAT_UNAVAILABLE', formats.UNAVAILABLE[format]);
    if (!formats.adapter(format)) throw new CreateError(400, 'VALIDATION', 'Choose the document format: S1000D or JSS.');
    if (store.projectNameTaken(name)) throw new CreateError(409, 'NAME_TAKEN', 'A project with that name already exists.');
    let workspace = null;
    if (workspaceId) {
      workspace = store.getWorkspace(workspaceId);
      const v = evaluate(me, 'workspace.manage', { workspace, visible: workspace ? workspaceVisible(store, workspace, me) : false });
      if (!v.ok) throw new CreateError(v.http === 404 ? 404 : 403, v.http === 404 ? 'NOT_FOUND' : 'WORKSPACE_FORBIDDEN', v.http === 404 ? 'That workspace does not exist.' : 'You can create projects only in a workspace you own.');
    }
    if (folderId) {
      const folder = store.getFolder(folderId);
      if (!folder || !workspace || folder.workspace_id !== workspace.id) throw new CreateError(400, 'BAD_FOLDER', 'That folder is not in the chosen workspace.');
    }
    const authors = [];
    for (const id of new Set(members)) {
      const u = store.getUser(id);
      if (!u || u.role !== policy.ROLES.AUTHOR || u.disabled_at) throw new CreateError(400, 'NOT_AN_AUTHOR', 'Only active Author accounts can be added to a project.');
      if (u.id !== me.id) authors.push(u);
    }
    let project;
    try {
      project = store.createProject({ id: newProjectId(), name, description, ownerId: me.id, createdBy: me.id, now: nowIso() });
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw new CreateError(409, 'NAME_TAKEN', 'A project with that name already exists.');
      throw e;
    }
    store.setProjectFormat(project.id, format);
    if (workspace) store.placeProject(project.id, workspace.id, folderId, nowIso());
    // The workspace on disk; a JSS project's publication is a book, not a publication module.
    const dir = documents.workspaceFor(project);
    if (format === 'jss') {
      writeFileAtomic(path.join(dir, 'publication.xml'), formats.adapter('jss').skeleton({ bookName: 'Technical Manual', systemName: name }));
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
      pj.type = 'JSS';
      writeFileAtomic(path.join(dir, 'project.json'), JSON.stringify(pj, null, 2) + '\n');
    }
    audit({ actorId: me.id, actorUsername: me.username, ip: clientIp(req), action: 'project.created',
      targetType: 'project', targetId: project.id, projectId: project.id, meta: { projectName: project.name, ownerRole: me.role, format, workspaceName: workspace ? workspace.name : undefined } });
    for (const a of authors) {
      store.addMember(project.id, a.id, me.id, nowIso());
      audit({ actorId: me.id, actorUsername: me.username, ip: clientIp(req), action: 'project.member.added',
        targetType: 'user', targetId: a.id, projectId: project.id, meta: { projectName: project.name, username: a.username } });
    }
    return store.getProject(project.id);
  }
  // For routes/content.js (creation from an XML file or a package).
  projectsApi.create = createProject;
  projectsApi.CreateError = CreateError;

  const CREATE_FIELDS = {
    name: { type: 'string', required: true, min: 3, max: 80, label: 'Project name' },
    description: { type: 'string', max: 500, label: 'Description' },
    format: { type: 'string', max: 10, label: 'Format' },
    workspaceId: { type: 'string', max: 64 },
    folderId: { type: 'string', max: 64 },
    members: { type: 'array', max: 50 },
  };
  projectsApi.CREATE_FIELDS = CREATE_FIELDS;

  app.post('/api/projects',
    can('project.create'),
    body(CREATE_FIELDS),
    (req, res) => {
      try {
        const members = (req.valid.members || []).filter((m) => typeof m === 'string').slice(0, 50);
        const project = createProject(req, { ...req.valid, format: req.valid.format || 's1000d', members });
        res.status(201).json({ ok: true, project: projectOut({ ...project, author_count: members.length }) });
      } catch (e) {
        if (e instanceof CreateError) return sendError(res, e.status, e.code, e.message);
        throw e;
      }
    });

  app.get('/api/projects/:id',
    can('project.read', loaders.project),
    (req, res) => {
      const me = req.auth.user;
      const { project } = req.ctx;
      // Each Author's last content action here (an action and a time, never content).
      const last = new Map();
      for (const a of store.listContentActivity([project.id], 300)) if (!last.has(a.actor_id)) last.set(a.actor_id, { action: a.action, at: a.at });
      const members = store.listMembers(project.id).map((m) => ({ ...memberOut(m), lastActivity: last.get(m.user_id || m.id) || null }));
      res.json({
        project: projectOut({ ...project, author_count: members.length }),
        authors: members,
        relation: project.owner_id === me.id ? 'owner' : req.ctx.membership ? 'assigned' : 'oversight',
        // What the project's document format can do (decisions.md FM2); the client shows its tabs from this.
        formatInfo: formats.describe(project.format),
        placement: project.workspace_id ? (() => {
          const w = store.getWorkspace(project.workspace_id);
          const f = project.folder_id ? store.getFolder(project.folder_id) : null;
          return w ? { workspaceId: w.id, workspaceName: w.name, folderId: f ? f.id : null, folderName: f ? f.name : null } : null;
        })() : null,
        permissions: {
          assign: evaluate(me, 'project.assign', req.ctx).ok,
          write: evaluate(me, 'content.write', req.ctx).ok,
          build: evaluate(me, 'content.build', req.ctx).ok,
          drafts: evaluate(me, 'draft.write', req.ctx).ok,
          // The administrator may edit as an override, one document at a time, with a reason (decisions.md V3).
          override: me.role === ADMIN,
          // "Delete project" (decisions.md UI7): its owner or the administrator.
          delete: evaluate(me, 'project.archive', req.ctx).ok,
        },
      });
    });

  /*
    "I opened this project" (Author Panel redesign): recorded so the
    dashboard's "Recently opened" list reflects real use, never the audit
    log (which stays append-only history, not UI state). Not an audited
    action: opening a project is not a content change or a security event.
  */
  app.post('/api/projects/:id/opened',
    can('project.read', loaders.project),
    (req, res) => {
      store.recordProjectOpen(req.auth.user.id, req.ctx.project.id, nowIso());
      res.json({ ok: true });
    });

  /*
    "Delete project" (decisions.md UI7): archiving, never erasing. It only
    changes `status`, so the workspace on disk, every data module and
    revision, graphics, requests and the audit trail are all untouched and
    the project is restored exactly as it was. It drops out of the default
    project list (store.listProjects' status filter) and out of the
    cross-project graphics library and backup downloads, which use the same
    default; a member who still has the id can still read and write it
    (archiving is not a lock), and the administrator can see it either way.
  */
  app.post('/api/projects/:id/archive',
    can('project.archive', loaders.project),
    body({}),
    (req, res) => {
      const { project } = req.ctx;
      if (project.status === 'archived') return sendError(res, 409, 'ALREADY_ARCHIVED', 'This project is already deleted (archived).');
      store.setProjectStatus(project.id, 'archived', nowIso());
      audit({ actorId: req.auth.user.id, actorUsername: req.auth.user.username, ip: clientIp(req), action: 'project.archived',
        targetType: 'project', targetId: project.id, projectId: project.id, meta: { projectName: project.name } });
      res.json({ ok: true });
    });

  app.post('/api/projects/:id/restore',
    can('project.archive', loaders.project),
    body({}),
    (req, res) => {
      const { project } = req.ctx;
      if (project.status !== 'archived') return sendError(res, 409, 'NOT_ARCHIVED', 'This project is not deleted.');
      // Another, active project may have taken this name while it was archived (UI7).
      if (store.projectNameTaken(project.name)) return sendError(res, 409, 'NAME_TAKEN', 'A project with that name already exists; rename it before restoring.');
      store.setProjectStatus(project.id, 'active', nowIso());
      audit({ actorId: req.auth.user.id, actorUsername: req.auth.user.username, ip: clientIp(req), action: 'project.restored',
        targetType: 'project', targetId: project.id, projectId: project.id, meta: { projectName: project.name } });
      res.json({ ok: true });
    });

  // The Authors a new project can be given at creation (the same list a project's owner sees, WS2).
  app.get('/api/authors/assignable',
    can('project.create'),
    (req, res) => {
      res.json({
        authors: store.listAssignableAuthors('').filter((u) => u.id !== req.auth.user.id).map((u) => ({
          id: u.id, username: u.username, fullName: u.full_name, status: u.onboarding_pending ? 'pending' : 'active',
        })),
      });
    });

  app.get('/api/projects/:id/assignable',
    can('project.assign.list', loaders.project),
    (req, res) => {
      res.json({
        authors: store.listAssignableAuthors(req.ctx.project.id).map((u) => ({
          id: u.id, username: u.username, fullName: u.full_name, status: u.onboarding_pending ? 'pending' : 'active',
        })),
      });
    });

  // For the administrator, assigning and removing are overrides with a written reason (V7).
  const REASON = { type: 'string', max: 1000, label: 'Reason' };
  function memberOverride(req, project, author, action) {
    if (req.auth.user.role !== ADMIN) return null;
    return overrides.record(req, {
      kind: 'members', action, projectId: project.id, targetType: 'user', targetId: author.id, reason: req.valid.reason,
      recipients: [author.id, project.owner_id], meta: { projectName: project.name, username: author.username, added: action === 'project.member.added' },
    });
  }

  app.post('/api/projects/:id/members',
    can('project.assign', loaders.withReason(loaders.project)),
    body({ userId: { type: 'string', required: true, max: 64 }, reason: REASON }),
    (req, res) => {
      const me = req.auth.user;
      const { project } = req.ctx;
      const author = store.getUser(req.valid.userId);
      if (!author || author.role !== policy.ROLES.AUTHOR || author.disabled_at) {
        return sendError(res, 400, 'NOT_AN_AUTHOR', 'Only active Author accounts can be assigned to a project.');
      }
      if (author.id === project.owner_id) {
        return sendError(res, 409, 'ALREADY_OWNER', 'That Author owns this project already.');
      }
      if (!store.addMember(project.id, author.id, me.id, nowIso())) {
        return sendError(res, 409, 'ALREADY_ASSIGNED', 'That Author is already assigned to this project.');
      }
      const overrideId = memberOverride(req, project, author, 'project.member.added');
      audit({ actorId: me.id, actorUsername: me.username, ip: clientIp(req), action: 'project.member.added',
        targetType: 'user', targetId: author.id, projectId: project.id,
        meta: { projectName: project.name, username: author.username, byAdmin: me.role === ADMIN || undefined, overrideId: overrideId || undefined } });
      res.status(201).json({ ok: true, authors: store.listMembers(project.id).map(memberOut) });
    });

  app.delete('/api/projects/:id/members/:userId',
    can('project.assign', loaders.withReason(loaders.project)),
    body({ reason: REASON }),
    (req, res) => {
      const me = req.auth.user;
      const { project } = req.ctx;
      const author = store.getUser(req.params.userId);
      if (!author || !store.removeMember(project.id, author.id)) return sendError(res, 404, 'NOT_FOUND', 'Not found.');
      const overrideId = memberOverride(req, project, author, 'project.member.removed');
      audit({ actorId: me.id, actorUsername: me.username, ip: clientIp(req), action: 'project.member.removed',
        targetType: 'user', targetId: author.id, projectId: project.id,
        meta: { projectName: project.name, username: author.username, byAdmin: me.role === ADMIN || undefined, overrideId: overrideId || undefined } });
      res.json({ ok: true, authors: store.listMembers(project.id).map(memberOut) });
    });
}

module.exports = { register, projectOut, memberOut, projectsApi };
