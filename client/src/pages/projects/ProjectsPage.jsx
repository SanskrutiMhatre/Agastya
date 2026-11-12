import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, PageHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import DataTable from '../../components/ui/DataTable.jsx';
import { Field, SearchInput, Select } from '../../components/ui/Field.jsx';
import { Badge, OwnerTag } from '../../components/ui/Badge.jsx';
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog.jsx';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import Icon from '../../components/Icon.jsx';
import NewProjectDialog, { folderPaths } from '../../components/NewProjectDialog.jsx';
import NameDialog from '../../components/NameDialog.jsx';
import useResource from '../../lib/useResource.js';
import { useAuth } from '../../auth.jsx';
import { del, patch, post } from '../../api.js';
import { fmtDate } from '../../lib/format.js';

const SUBTITLE = {
  software_admin: 'Every project in the organisation and who owns it.',
  project_manager: 'Projects you own. Projects owned by Authors are visible only to their owner and assigned Authors.',
  author: 'Projects you own or are assigned to. Other projects are not visible to you.',
};
const FORMAT_LABEL = { s1000d: 'S1000D', jss: 'JSS' };

// Where a project goes: a workspace the caller manages and one of its folders, or none.
function MoveDialog({ open, project, workspaces, onClose, onMoved }) {
  const [place, setPlace] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open && project) { setPlace(project.workspaceId ? `${project.workspaceId}|${project.folderId || ''}` : ''); setError(null); } }, [open, project]);
  const places = useMemo(() => workspaces.filter((w) => w.canManage).flatMap((w) => [
    { v: `${w.id}|`, t: w.name }, ...folderPaths(w).map((f) => ({ v: `${w.id}|${f.id}`, t: `${w.name} / ${f.label}` })),
  ]), [workspaces]);
  async function submit(e) {
    e.preventDefault();
    const [workspaceId, folderId] = place ? place.split('|') : ['', ''];
    setBusy(true); setError(null);
    try { await post(`/api/projects/${project.id}/move`, { workspaceId, folderId }); onMoved(); onClose(); } catch (err) { setError(err.message); }
    setBusy(false);
  }
  return (
    <Dialog open={open} onClose={onClose} title={`Move ${project ? project.name : ''}`} size="sm"
      description="Only where the project is listed changes: its content, history, members and permissions stay as they are."
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" form="move-project" loading={busy}>Move</Button></>}>
      <form id="move-project" onSubmit={submit} className="space-y-3" noValidate>
        {error ? <Alert>{error}</Alert> : null}
        <Field label="Move to">{(p) => (
          <Select {...p} value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="">No workspace</option>
            {places.map((x) => <option key={x.v} value={x.v}>{x.t}</option>)}
          </Select>
        )}</Field>
      </form>
    </Dialog>
  );
}

/*
  The folders of one workspace as a nested list. Each node is a drop target
  for a dragged project or folder (dropNode), and a folder node is itself
  draggable (dragFolder) — the alternative to the existing Move dialogs,
  requested alongside them rather than instead of them.
*/
function FolderTree({ ws, parentId = null, depth = 1, selected, onSelect, dropNode, dragOverKey, dragFolder }) {
  const kids = ws.folders.filter((f) => (f.parentId || null) === parentId).sort((a, b) => a.name.localeCompare(b.name));
  if (!kids.length) return null;
  return (
    <ul role="group">
      {kids.map((f) => (
        <li key={f.id} role="treeitem" aria-selected={selected === `f:${f.id}`}>
          <button type="button" onClick={() => onSelect(`f:${f.id}`)} style={{ paddingLeft: `${8 + depth * 14}px` }}
            {...dropNode(`f:${f.id}`)} {...(dragFolder ? dragFolder(f, ws) : {})}
            className={`w-full text-left flex items-center gap-1.5 py-1 pr-2 rounded text-[13px] ${selected === `f:${f.id}` ? 'bg-accent-soft text-accent-soft-ink' : 'hover:bg-surface-2'} ${dragOverKey === `f:${f.id}` ? 'ring-2 ring-accent bg-accent-soft/60' : ''}`}>
            <Icon name="folder" size={14} />{f.name}
          </button>
          <FolderTree ws={ws} parentId={f.id} depth={depth + 1} selected={selected} onSelect={onSelect} dropNode={dropNode} dragOverKey={dragOverKey} dragFolder={dragFolder} />
        </li>
      ))}
    </ul>
  );
}

export default function ProjectsPage() {
  const { me } = useAuth();
  const toast = useToast();
  const role = me.user.role;
  const [showArchived, setShowArchived] = useState(false);
  const { data, loading, error, reload } = useResource(`/api/projects${showArchived ? '?archived=1' : ''}`);
  const wsRes = useResource('/api/workspaces');
  const workspaces = wsRes.data ? wsRes.data.workspaces : [];
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [node, setNode] = useState('all'); // all | none | w:<id> | f:<id>
  const [dialog, setDialog] = useState(null);
  const [moving, setMoving] = useState(null);
  const [deleting, setDeleting] = useState(null); // "Delete project" (decisions.md UI7): the project pending confirmation
  const reloadAll = () => { reload(); wsRes.reload(); };

  async function archiveProject() {
    await post(`/api/projects/${deleting.id}/archive`, {});
    toast.success('Project deleted', `${deleting.name} moved out of the active list. Restore it with "Show deleted".`);
    setDeleting(null);
    reloadAll();
  }
  async function restoreProject(p) {
    try { await post(`/api/projects/${p.id}/restore`, {}); toast.success('Project restored', p.name); reloadAll(); }
    catch (e) { toast.error('Not restored', e.message); }
  }

  // The Workspace page's "Open" link selects its workspace here (?ws=<id>).
  const [params] = useSearchParams();
  useEffect(() => { const ws = params.get('ws'); if (ws) setNode(`w:${ws}`); }, [params]);

  /*
    Drag and drop (alongside, never instead of, the Move dialogs above): a
    project dropped on a tree node moves there; a folder dropped on another
    node of the SAME workspace nests there (cross-workspace folder moves are
    not offered by the API, so none is offered here either). `dragRef` is
    read on drop rather than decoded from dataTransfer, since the drag never
    leaves this page.
  */
  const dragRef = useRef(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  async function dropOn(nodeKey) {
    const item = dragRef.current;
    setDragOverKey(null);
    if (!item) return;
    const [workspaceId, folderId] = nodeKey === 'all' || nodeKey === 'none' ? ['', '']
      : nodeKey.startsWith('w:') ? [nodeKey.slice(2), '']
        : [folderOf.get(nodeKey.slice(2)).ws.id, nodeKey.slice(2)];
    try {
      if (item.type === 'project') {
        if (item.workspaceId === workspaceId && item.folderId === folderId) return;
        await post(`/api/projects/${item.id}/move`, { workspaceId, folderId });
        toast.success('Project moved', item.name);
      } else if (nodeKey !== 'all' && nodeKey !== 'none') {
        if (item.wsId !== workspaceId) { toast.error('Not moved', 'A folder stays in its own workspace; use "Move folder" to see where else it can go.'); return; }
        if (item.id === folderId) return;
        await patch(`/api/folders/${item.id}`, { parentId: folderId });
        toast.success('Folder moved', item.name);
      } else return;
      reloadAll();
    } catch (e) { toast.error('Not moved', e.message); }
  }
  // Spread onto any tree node button: highlights it while a drag is over it, and handles the drop.
  const dropNode = (key) => ({
    onDragOver: (e) => { if (dragRef.current) e.preventDefault(); },
    onDragEnter: (e) => { if (dragRef.current) { e.preventDefault(); setDragOverKey(key); } },
    onDragLeave: (e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget)) setDragOverKey((k) => (k === key ? null : k)); },
    onDrop: (e) => { e.preventDefault(); dropOn(key); },
  });
  // Spread onto a project row's name cell to make it a drag source.
  const dragProject = (p) => (mayMove(p) ? {
    draggable: true,
    onDragStart: (e) => { dragRef.current = { type: 'project', id: p.id, name: p.name, workspaceId: p.workspaceId || '', folderId: p.folderId || '' }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.name); },
    onDragEnd: () => { dragRef.current = null; setDragOverKey(null); },
  } : {});
  // Spread onto a folder tree node to make it a drag source, within a workspace the caller manages.
  const dragFolder = (f, ws) => (ws.canManage ? {
    draggable: true,
    onDragStart: (e) => { dragRef.current = { type: 'folder', id: f.id, name: f.name, wsId: ws.id }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.name); },
    onDragEnd: () => { dragRef.current = null; setDragOverKey(null); },
  } : {});

  const folderOf = useMemo(() => new Map(workspaces.flatMap((w) => w.folders.map((f) => [f.id, { ...f, ws: w }]))), [workspaces]);
  const selWs = node.startsWith('w:') ? workspaces.find((w) => w.id === node.slice(2)) : node.startsWith('f:') && folderOf.get(node.slice(2)) ? folderOf.get(node.slice(2)).ws : null;
  const selFolder = node.startsWith('f:') ? folderOf.get(node.slice(2)) || null : null;
  // A folder shows the projects in it and in every folder below it.
  const under = useMemo(() => {
    if (!selFolder) return null;
    const ids = new Set([selFolder.id]);
    let grew = true;
    while (grew) { grew = false; for (const f of selFolder.ws.folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; } }
    return ids;
  }, [selFolder]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ? data.projects : []).filter((p) => {
      if (node === 'none' && p.workspaceId) return false;
      if (node.startsWith('w:') && p.workspaceId !== node.slice(2)) return false;
      if (under && !under.has(p.folderId)) return false;
      return !q || p.name.toLowerCase().includes(q) || p.owner.fullName.toLowerCase().includes(q);
    });
  }, [data, search, node, under]);

  const placeName = (p) => {
    if (!p.workspaceId) return null;
    const w = workspaces.find((x) => x.id === p.workspaceId);
    if (!w) return null;
    const f = p.folderId ? folderPaths(w).find((x) => x.id === p.folderId) : null;
    return f ? `${w.name} / ${f.label}` : w.name;
  };
  const mayMove = (p) => role === 'software_admin' || p.owner.id === me.user.id;
  const mayDelete = mayMove; // the same rule the server's project.archive uses (its owner, or the administrator)
  const run = (fn, done) => async (value) => { const r = await fn(value); if (done) toast.success(done); reloadAll(); return r; };

  return (
    <>
      <PageHeader eyebrow="Projects" title={role === 'author' ? 'My projects' : 'Projects'} subtitle={SUBTITLE[role]}
        actions={role !== 'software_admin' ? <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New project</Button> : null} />
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="p-2 self-start" data-testid="workspace-tree">
          <div className="flex items-center justify-between px-2 py-1.5">
            <h2 className="text-[13px] font-semibold">Workspaces</h2>
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setDialog({ kind: 'workspace' })}>New workspace</Button>
          </div>
          <p className="px-2 pb-1.5 text-[11.5px] text-ink-3">Drag a project or folder here to move it, or use Move.</p>
          <ul role="tree" aria-label="Workspaces and folders">
            {[['all', 'All projects', 'grid'], ['none', 'Not in a workspace', 'file']].map(([k, label, icon]) => (
              <li key={k} role="treeitem" aria-selected={node === k}>
                <button type="button" onClick={() => setNode(k)} {...dropNode(k)}
                  className={`w-full text-left flex items-center gap-1.5 px-2 py-1 rounded text-[13px] ${node === k ? 'bg-accent-soft text-accent-soft-ink' : 'hover:bg-surface-2'} ${dragOverKey === k ? 'ring-2 ring-accent bg-accent-soft/60' : ''}`}>
                  <Icon name={icon} size={14} />{label}
                </button>
              </li>
            ))}
            {workspaces.map((w) => (
              <li key={w.id} role="treeitem" aria-selected={node === `w:${w.id}`}>
                <button type="button" onClick={() => setNode(`w:${w.id}`)} {...dropNode(`w:${w.id}`)}
                  className={`w-full text-left flex items-center gap-1.5 px-2 py-1 rounded text-[13px] font-medium ${node === `w:${w.id}` ? 'bg-accent-soft text-accent-soft-ink' : 'hover:bg-surface-2'} ${dragOverKey === `w:${w.id}` ? 'ring-2 ring-accent bg-accent-soft/60' : ''}`}>
                  <Icon name="layers" size={14} />{w.name}{!w.canManage ? <span className="ml-auto text-[11px] text-ink-3">shared</span> : null}
                </button>
                <FolderTree ws={w} selected={node} onSelect={setNode} dropNode={dropNode} dragOverKey={dragOverKey} dragFolder={dragFolder} />
              </li>
            ))}
          </ul>
          {selWs && selWs.canManage ? (
            <div className="border-t border-line mt-2 pt-2 px-1 flex flex-wrap gap-1.5" aria-label="Workspace actions">
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setDialog({ kind: 'folder' })}>New folder</Button>
              <Button size="sm" variant="ghost" icon="edit" onClick={() => setDialog({ kind: selFolder ? 'renameFolder' : 'renameWorkspace' })}>Rename</Button>
              {selFolder ? <Button size="sm" variant="ghost" icon="arrowUp" onClick={() => setDialog({ kind: 'nestFolder' })}>Move folder</Button> : null}
              <Button size="sm" variant="danger-ghost" icon="trash" onClick={() => setDialog({ kind: selFolder ? 'deleteFolder' : 'deleteWorkspace' })}>Delete</Button>
            </div>
          ) : null}
        </Card>
        <Card>
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <SearchInput value={search} onChange={setSearch} placeholder="Search projects or managers" label="Search projects" className="w-full sm:w-80" />
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show deleted
            </label>
            <p className="sm:ml-auto text-[13px] text-ink-3" aria-live="polite">{data ? `${rows.length} of ${data.projects.length}` : ''}</p>
          </div>
          {error ? <ErrorState error={error} onRetry={reload} />
            : loading ? <div className="px-4 pb-4"><LoadingBlock rows={4} /></div>
              : (
                <DataTable
                  caption="Projects"
                  rows={rows}
                  initialSort={{ key: 'name', dir: 'asc' }}
                  empty={search || node !== 'all'
                    ? <EmptyState icon="search" title="No projects here" />
                    : <EmptyState icon="folder" title="No projects yet"
                        action={role !== 'software_admin' ? <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Create a project</Button> : null}>
                        {role === 'author' ? 'Create your own project, or wait to be assigned to one.' : role === 'software_admin' ? 'Project Managers and Authors create projects.' : null}
                      </EmptyState>}
                  columns={[
                    { key: 'name', header: 'Project', sortValue: (p) => p.name, render: (p) => (
                      <div {...dragProject(p)} className={mayMove(p) ? 'cursor-grab' : ''} title={mayMove(p) ? 'Drag to move, or open' : undefined}>
                        <span className="flex items-center gap-1.5">
                          <Link to={`/projects/${p.id}/workspace`} className="font-medium text-ink hover:text-accent hover:underline">{p.name}</Link>
                          {/* A generic accessible name on purpose: it must never share a link-role match with the project's own name link above (many scenarios locate a project by clicking its name). */}
                          <Link to={`/projects/${p.id}`} className="text-ink-3 hover:text-accent" title={`${p.name}: overview, members and settings`} aria-label="Project overview"><Icon name="grid" size={13} /></Link>
                          {p.status === 'archived' ? <Badge tone="warn">Deleted</Badge> : null}
                        </span>
                        <p className="font-mono text-[11.5px] text-ink-3">{p.id}{placeName(p) ? <span className="font-sans"> · {placeName(p)}</span> : null}</p>
                      </div>
                    ) },
                    { key: 'format', header: 'Format', sortValue: (p) => p.format, hideBelow: 'sm', render: (p) => <Badge>{FORMAT_LABEL[p.format] || p.format}</Badge> },
                    { key: 'owner', header: 'Owner', sortValue: (p) => p.owner.fullName, hideBelow: 'sm', render: (p) => <OwnerTag owner={p.owner} /> },
                    ...(role === 'author' ? [{ key: 'relation', header: 'Your role', sortValue: (p) => p.relation,
                      render: (p) => (p.relation === 'owner' ? <Badge tone="accent" icon="key">Owner</Badge> : <Badge icon="users">Assigned</Badge>) }] : []),
                    { key: 'authors', header: 'Authors', align: 'right', sortValue: (p) => p.authorCount, render: (p) => p.authorCount },
                    { key: 'updated', header: 'Last modified', sortValue: (p) => p.updatedAt, render: (p) => <span className="text-ink-2">{fmtDate(p.updatedAt)}</span>, hideBelow: 'md' },
                    { key: 'move', header: <span className="sr-only">Actions</span>, align: 'right', render: (p) => (p.status === 'archived'
                      ? (mayDelete(p) ? <Button size="sm" variant="ghost" icon="refresh" onClick={() => restoreProject(p)} aria-label={`Restore ${p.name}`}>Restore</Button> : null)
                      : (
                        <span className="inline-flex gap-1">
                          {mayMove(p) ? <Button size="sm" variant="ghost" onClick={() => setMoving(p)} aria-label={`Move ${p.name}`}>Move</Button> : null}
                          {mayDelete(p) ? <Button size="sm" variant="danger-ghost" onClick={() => setDeleting(p)} aria-label={`Delete ${p.name}`}>Delete</Button> : null}
                        </span>
                      )) },
                  ]}
                />
              )}
        </Card>
      </div>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} onCreated={() => reloadAll()} role={role}
        placeIn={selWs && selWs.canManage ? { workspaceId: selWs.id, folderId: selFolder ? selFolder.id : '' } : null} />
      <MoveDialog open={!!moving} project={moving} workspaces={workspaces} onClose={() => setMoving(null)} onMoved={() => { toast.success('Project moved'); reloadAll(); }} />
      <NameDialog open={dialog && dialog.kind === 'workspace'} title="New workspace" label="Workspace name" action="Create workspace"
        description="A workspace holds folders and projects. It arranges them and gives nobody access." onClose={() => setDialog(null)}
        onSubmit={run(async (name) => { const r = await post('/api/workspaces', { name }); setNode(`w:${r.workspace.id}`); }, 'Workspace created')} />
      <NameDialog open={dialog && dialog.kind === 'folder'} title={`New folder in ${selFolder ? selFolder.name : selWs ? selWs.name : ''}`} label="Folder name" action="Create folder"
        onClose={() => setDialog(null)} onSubmit={run((name) => post(`/api/workspaces/${selWs.id}/folders`, { name, parentId: selFolder ? selFolder.id : '' }), 'Folder created')} />
      <NameDialog open={dialog && dialog.kind === 'renameWorkspace'} title="Rename workspace" label="Workspace name" action="Rename" initial={selWs ? selWs.name : ''}
        onClose={() => setDialog(null)} onSubmit={run((name) => patch(`/api/workspaces/${selWs.id}`, { name }), 'Workspace renamed')} />
      <NameDialog open={dialog && dialog.kind === 'renameFolder'} title="Rename folder" label="Folder name" action="Rename" initial={selFolder ? selFolder.name : ''}
        onClose={() => setDialog(null)} onSubmit={run((name) => patch(`/api/folders/${selFolder.id}`, { name }), 'Folder renamed')} />
      <NameDialog open={dialog && dialog.kind === 'deleteWorkspace'} danger title={`Delete ${selWs ? selWs.name : ''}`} label="Type the workspace name to confirm" action="Delete workspace"
        description="Its folders are deleted. Its projects are not: they move out of the workspace, with all their content and members."
        onClose={() => setDialog(null)} onSubmit={run(async (confirm) => { await del(`/api/workspaces/${selWs.id}`, { confirm }); setNode('all'); }, 'Workspace deleted')} />
      <NameDialog open={dialog && dialog.kind === 'deleteFolder'} danger title={`Delete ${selFolder ? selFolder.name : ''}`} label="Type the folder name to confirm" action="Delete folder"
        description="Its projects and folders move up one level; nothing in them is deleted."
        onClose={() => setDialog(null)} onSubmit={run(async (typed) => {
          if (typed.toLowerCase() !== selFolder.name.toLowerCase()) throw new Error('Type the folder name to confirm.');
          await del(`/api/folders/${selFolder.id}`, {}); setNode(`w:${selWs.id}`);
        }, 'Folder deleted')} />
      {dialog && dialog.kind === 'nestFolder' && selFolder ? (
        <NestDialog folder={selFolder} ws={selWs} onClose={() => setDialog(null)} onDone={() => { toast.success('Folder moved'); reloadAll(); }} />
      ) : null}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title={`Delete ${deleting ? deleting.name : ''}?`} confirmLabel="Delete project" tone="danger" onConfirm={archiveProject}>
        <p>This moves it out of the active list. Nothing is removed: every data module, revision, graphic and setting stays exactly as it is, and it can be restored any time with "Show deleted".</p>
      </ConfirmDialog>
    </>
  );
}

// Put a folder under another folder of the same workspace, or at the top.
function NestDialog({ folder, ws, onClose, onDone }) {
  const [parent, setParent] = useState(folder.parentId || '');
  const [error, setError] = useState(null);
  const options = folderPaths(ws).filter((f) => f.id !== folder.id);
  async function submit(e) {
    e.preventDefault();
    try { await patch(`/api/folders/${folder.id}`, { parentId: parent }); onDone(); onClose(); } catch (err) { setError(err.message); }
  }
  return (
    <Dialog open onClose={onClose} title={`Move folder ${folder.name}`} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="nest-folder">Move</Button></>}>
      <form id="nest-folder" onSubmit={submit} className="space-y-3" noValidate>
        {error ? <Alert>{error}</Alert> : null}
        <Field label="Put it in">{(p) => (
          <Select {...p} value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">{ws.name} (top level)</option>
            {options.map((f) => <option key={f.id} value={f.id}>{ws.name} / {f.label}</option>)}
          </Select>
        )}</Field>
      </form>
    </Dialog>
  );
}
