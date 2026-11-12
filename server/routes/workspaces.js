'use strict';
/*
  Workspaces and folders (Phase 6.5, decisions.md WS1-WS6).

  A workspace holds nested folders and projects; a project may also be in no
  workspace. They arrange projects and grant nothing: ownership, members and
  every permission stay on the project, and the files never move, so moving
  a project changes where it is listed and nothing else (WS4). Deleting a
  folder or a workspace never deletes a project: its projects move up (WS5).

    GET    /api/workspaces                      what the caller can see, with folders and their visible projects
    POST   /api/workspaces          {name}
    PATCH  /api/workspaces/:wid     {name}
    DELETE /api/workspaces/:wid     {confirm: name}  projects become unfiled
    POST   /api/workspaces/:wid/folders {name, parentId?}
    PATCH  /api/folders/:fid        {name?, parentId?}  rename, or nest under another folder ('' = top level)
    DELETE /api/folders/:fid        contents move to the parent
    POST   /api/projects/:id/move   {workspaceId, folderId}  '' = no workspace / top level
*/

const crypto = require('node:crypto');
const { loaders, evaluate, workspaceVisible } = require('../auth/authz');
const { body } = require('../http/validate');
const { sendError } = require('../http/errors');

const NAME = { type: 'string', required: true, min: 1, max: 80, pattern: /^[^\u0000-\u001f\u007f/\\]*$/, label: 'Name' };
const MAX_DEPTH = 8;
const newId = (p) => `${p}-${crypto.randomBytes(5).toString('hex')}`;
const clean = (s) => String(s).replace(/\s+/g, ' ').trim();

function register({ app, store, authz, audit, now, clientIp }) {
  const { can } = authz;
  const nowIso = () => now().toISOString();
  const me = (req) => req.auth.user;
  const log = (req, action, ctx) => audit({ actorId: me(req).id, actorUsername: me(req).username, ip: clientIp(req), action, ...ctx });

  function workspaceOut(w, user) {
    const visible = new Set((user.role === 'software_admin' ? store.listProjects() : store.listProjects({ userId: user.id })).map((p) => p.id));
    const manage = evaluate(user, 'workspace.manage', { workspace: w, visible: true }).ok;
    return {
      id: w.id, name: w.name, owner: { id: w.owner_id, fullName: w.owner_name, username: w.owner_username },
      canManage: manage, createdAt: w.created_at,
      folders: store.listFolders(w.id).map((f) => ({ id: f.id, parentId: f.parent_id || null, name: f.name })),
      projects: store.workspaceProjectIds(w.id).filter((id) => visible.has(id)),
    };
  }

  app.get('/api/workspaces',
    can('project.list'),
    (req, res) => {
      const user = me(req);
      const list = store.listWorkspaces().filter((w) => workspaceVisible(store, w, user));
      res.json({ workspaces: list.map((w) => workspaceOut(w, user)) });
    });

  app.post('/api/workspaces',
    can('workspace.create'),
    body({ name: NAME }),
    (req, res) => {
      const name = clean(req.valid.name);
      if (!name) return sendError(res, 400, 'VALIDATION', 'Name the workspace.');
      if (store.workspaceNameTaken(name)) return sendError(res, 409, 'NAME_TAKEN', 'A workspace with that name already exists.');
      const w = store.createWorkspace({ id: newId('ws'), name, ownerId: me(req).id, now: nowIso() });
      log(req, 'workspace.created', { targetType: 'workspace', targetId: w.id, meta: { name } });
      res.status(201).json({ ok: true, workspace: workspaceOut(w, me(req)) });
    });

  app.patch('/api/workspaces/:wid',
    can('workspace.manage', loaders.workspace),
    body({ name: NAME }),
    (req, res) => {
      const w = req.ctx.workspace;
      const name = clean(req.valid.name);
      if (!name) return sendError(res, 400, 'VALIDATION', 'Name the workspace.');
      if (store.workspaceNameTaken(name, w.id)) return sendError(res, 409, 'NAME_TAKEN', 'A workspace with that name already exists.');
      store.renameWorkspace(w.id, name, nowIso());
      log(req, 'workspace.renamed', { targetType: 'workspace', targetId: w.id, meta: { from: w.name, to: name } });
      res.json({ ok: true, workspace: workspaceOut(store.getWorkspace(w.id), me(req)) });
    });

  // The name typed again: deleting a workspace unfiles every project in it (WS5).
  app.delete('/api/workspaces/:wid',
    can('workspace.manage', loaders.workspace),
    body({ confirm: { type: 'string', required: true, max: 80, label: 'Confirmation' } }),
    (req, res) => {
      const w = req.ctx.workspace;
      if (clean(req.valid.confirm).toLowerCase() !== w.name.toLowerCase()) return sendError(res, 400, 'CONFIRM_MISMATCH', 'Type the workspace name to confirm.');
      const projects = store.workspaceProjectIds(w.id).length;
      store.deleteWorkspace(w.id);
      log(req, 'workspace.deleted', { targetType: 'workspace', targetId: w.id, meta: { name: w.name, projects } });
      res.json({ ok: true, unfiled: projects });
    });

  app.post('/api/workspaces/:wid/folders',
    can('workspace.manage', loaders.workspace),
    body({ name: NAME, parentId: { type: 'string', max: 64 } }),
    (req, res) => {
      const w = req.ctx.workspace;
      const name = clean(req.valid.name);
      const parentId = req.valid.parentId || null;
      if (!name) return sendError(res, 400, 'VALIDATION', 'Name the folder.');
      if (parentId) {
        const parent = store.getFolder(parentId);
        if (!parent || parent.workspace_id !== w.id) return sendError(res, 400, 'BAD_FOLDER', 'That folder is not in this workspace.');
        if (depthOf(parentId) >= MAX_DEPTH) return sendError(res, 400, 'TOO_DEEP', `Folders can be nested ${MAX_DEPTH} levels deep.`);
      }
      if (store.folderNameTaken(w.id, parentId, name)) return sendError(res, 409, 'NAME_TAKEN', 'A folder with that name is already there.');
      const f = store.createFolder({ id: newId('fld'), workspaceId: w.id, parentId, name, userId: me(req).id, now: nowIso() });
      log(req, 'folder.created', { targetType: 'folder', targetId: f.id, meta: { name, workspaceName: w.name } });
      res.status(201).json({ ok: true, folder: { id: f.id, parentId: f.parent_id || null, name: f.name } });
    });

  // Levels from the top of the workspace to this folder (a top-level folder is 1).
  function depthOf(id) {
    let n = 0;
    for (let f = store.getFolder(id); f && n < 100; f = f.parent_id ? store.getFolder(f.parent_id) : null) n++;
    return n;
  }
  // The deepest level below (and including) this folder, counted from it.
  function heightOf(id, workspaceId) {
    const kids = store.listFolders(workspaceId).filter((f) => f.parent_id === id);
    return 1 + (kids.length ? Math.max(...kids.map((k) => heightOf(k.id, workspaceId))) : 0);
  }

  app.patch('/api/folders/:fid',
    can('workspace.manage', loaders.folder),
    body({ name: { ...NAME, required: false }, parentId: { type: 'string', max: 64 } }),
    (req, res) => {
      const { folder, workspace } = req.ctx;
      const name = req.valid.name !== undefined ? clean(req.valid.name) : folder.name;
      let parentId = folder.parent_id || null;
      if (req.valid.parentId !== undefined) {
        parentId = req.valid.parentId || null;
        if (parentId) {
          const parent = store.getFolder(parentId);
          if (!parent || parent.workspace_id !== workspace.id) return sendError(res, 400, 'BAD_FOLDER', 'That folder is not in this workspace.');
          // Not into itself or anything inside it.
          for (let f = parent; f; f = f.parent_id ? store.getFolder(f.parent_id) : null) {
            if (f.id === folder.id) return sendError(res, 400, 'FOLDER_CYCLE', 'A folder cannot be moved into itself or one of its own folders.');
          }
          if (depthOf(parentId) + heightOf(folder.id, workspace.id) > MAX_DEPTH) return sendError(res, 400, 'TOO_DEEP', `Folders can be nested ${MAX_DEPTH} levels deep.`);
        }
      }
      if (!name) return sendError(res, 400, 'VALIDATION', 'Name the folder.');
      if (store.folderNameTaken(workspace.id, parentId, name, folder.id)) return sendError(res, 409, 'NAME_TAKEN', 'A folder with that name is already there.');
      store.updateFolder(folder.id, { name, parentId });
      log(req, parentId !== (folder.parent_id || null) ? 'folder.moved' : 'folder.renamed', { targetType: 'folder', targetId: folder.id, meta: { from: folder.name, to: name, workspaceName: workspace.name } });
      res.json({ ok: true, folder: { id: folder.id, parentId, name } });
    });

  app.delete('/api/folders/:fid',
    can('workspace.manage', loaders.folder),
    body({}),
    (req, res) => {
      const { folder, workspace } = req.ctx;
      const inside = store.folderContents(folder.id);
      store.deleteFolder(folder);
      log(req, 'folder.deleted', { targetType: 'folder', targetId: folder.id, meta: { name: folder.name, workspaceName: workspace.name, projects: inside.projects, folders: inside.folders } });
      res.json({ ok: true, movedUp: inside });
    });

  app.post('/api/projects/:id/move',
    can('project.move', loaders.projectMove),
    body({ workspaceId: { type: 'string', max: 64 }, folderId: { type: 'string', max: 64 } }),
    (req, res) => {
      const { project, target } = req.ctx;
      const folderId = req.valid.folderId || null;
      if (folderId) {
        const f = store.getFolder(folderId);
        if (!f || !target || f.workspace_id !== target.id) return sendError(res, 400, 'BAD_FOLDER', 'That folder is not in the chosen workspace.');
      }
      const from = project.workspace_id ? store.getWorkspace(project.workspace_id) : null;
      store.placeProject(project.id, target ? target.id : null, folderId, nowIso());
      log(req, 'project.moved', { targetType: 'project', targetId: project.id, projectId: project.id,
        meta: { projectName: project.name, from: from ? from.name : null, to: target ? target.name : null } });
      res.json({ ok: true, workspaceId: target ? target.id : null, folderId });
    });
}

module.exports = { register };
