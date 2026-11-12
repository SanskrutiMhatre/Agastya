import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Dialog, ConfirmDialog } from '../../components/ui/Dialog.jsx';
import { SearchInput, Select } from '../../components/ui/Field.jsx';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import Icon from '../../components/Icon.jsx';
import TextPromptDialog from '../../components/TextPromptDialog.jsx';
import { api, get, post, put } from '../../api.js';
import { fmtRelative } from '../../lib/format.js';
import { countOf, dmcOf, dropTarget, getAt, insertAt, labelFor, moveBy, moveTo, poolToEntry, removeAt, updateAt } from '../../lib/pmcTree.js';
import useLive from '../../lib/useLive.js';
import { LockBanner } from '../../components/LockBanner.jsx';

/*
  The publication module builder: which data modules go in the book, and in
  what order. After the Agastya original's PmcBuilder: a chapter tree you
  rearrange by dragging (or with the move buttons), a pool of the project's
  modules the publication does not place yet, import of a whole PM, and the
  two export forms. It edits publication.xml only when you save, through the
  server's write path (conflict detection, revision history). While you work
  the unsaved tree is autosaved as your draft.
*/

const keyOf = (p) => p.join('.');
const pathOf = (k) => k.split('.').map(Number);
const DRAFT_KEY = 'publication-tree';

function Row({ entry, path, depth, expanded, onToggle, selected, onSelect, drag, setDrag, onDrop, missing, readOnly, titles }) {
  const isFolder = entry.type === 'folder';
  const k = keyOf(path);
  const open = expanded.has(k);
  const hint = drag && drag.over === k ? drag.where : null;
  const dmc = dmcOf(entry);
  const isMissing = (entry.type === 'dm' && missing.has(dmc)) || (entry.type === 'include' && missing.has(entry.href));
  const zoneFor = (ev) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const y = (ev.clientY - r.top) / r.height;
    if (y < 0.28) return 'before';
    if (y > 0.72) return 'after';
    return isFolder ? 'inside' : 'after';
  };
  return (
    <>
      <div role="treeitem" aria-selected={selected === k} aria-expanded={isFolder ? open : undefined} aria-level={depth + 1}
        data-testid={`pm-row-${k}`} tabIndex={selected === k ? 0 : -1}
        draggable={!readOnly}
        onDragStart={(ev) => { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', k); setDrag({ from: k, over: null, where: null }); }}
        onDragEnd={() => setDrag(null)}
        onDragOver={(ev) => {
          if (!drag) return;
          ev.preventDefault();
          const where = zoneFor(ev);
          if (drag.over !== k || drag.where !== where) setDrag({ ...drag, over: k, where });
        }}
        onDrop={(ev) => { ev.preventDefault(); ev.stopPropagation(); onDrop(k, zoneFor(ev)); }}
        onClick={() => onSelect(path)}
        className={`relative flex items-center gap-2 pr-3 py-1.5 cursor-pointer border-l-2 text-[13px]
          ${selected === k ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-surface-2'}
          ${drag && drag.from === k ? 'opacity-40' : ''} ${hint === 'inside' ? 'outline-2 outline-accent -outline-offset-2' : ''}`}
        style={{ paddingLeft: 10 + depth * 18 }}>
        {hint === 'before' || hint === 'after' ? <span className={`absolute left-0 right-0 h-0.5 bg-accent pointer-events-none ${hint === 'before' ? '-top-px' : '-bottom-px'}`} /> : null}
        {isFolder ? (
          <button type="button" onClick={(ev) => { ev.stopPropagation(); onToggle(k); }} aria-label={open ? 'Collapse chapter' : 'Expand chapter'}
            className="h-5 w-5 grid place-items-center text-ink-3 hover:text-ink">
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
          </button>
        ) : <span className="w-5" />}
        <Icon name={isFolder ? 'folder' : 'file'} size={15} className={isFolder ? 'text-accent' : 'text-ink-3'} />
        <span className={`truncate ${isFolder ? 'font-semibold text-ink' : 'text-ink-2'}`}>{labelFor(entry, titles)}</span>
        {entry.page ? <Badge tone="accent">{entry.page === 'a3-landscape' ? 'A3 landscape' : 'A4 landscape'}</Badge> : null}
        {entry.type === 'include' ? <Badge>file ref</Badge> : null}
        {isMissing ? <Badge tone="danger" icon="alert">not in project</Badge> : null}
        {dmc ? <span className="ml-auto font-mono text-[11px] text-ink-3 truncate max-w-[45%]">{dmc}</span> : null}
        {isFolder ? <span className="ml-auto text-[11px] tabular text-ink-3">{countOf(entry.children).dms}</span> : null}
      </div>
      {isFolder && open ? (entry.children || []).map((c, i) => (
        <Row key={keyOf([...path, i])} entry={c} path={[...path, i]} depth={depth + 1} expanded={expanded} onToggle={onToggle}
          selected={selected} onSelect={onSelect} drag={drag} setDrag={setDrag} onDrop={onDrop} missing={missing} readOnly={readOnly} titles={titles} />
      )) : null}
    </>
  );
}

export default function PmcBuilder({ project, canWrite, onSaved, overriding = false, drafts = true }) {
  const toast = useToast();
  const [model, setModel] = useState(null);
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const [selected, setSelected] = useState(null);
  const [drag, setDrag] = useState(null);
  const [poolQuery, setPoolQuery] = useState('');
  const [undoSnap, setUndoSnap] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmImport, setConfirmImport] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState(null);
  const [newer, setNewer] = useState(null);
  const fileRef = useRef(null);
  const draftTimer = useRef(null);
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const m = await get(`/api/projects/${project.id}/publication/model`);
      setModel(m); setEntries(m.entries); setDirty(false); setUndoSnap(null); setNewer(null);
      setExpanded(new Set(m.entries.map((_, i) => String(i))));
      if (canWrite && drafts) {
        try {
          const d = (await get(`/api/projects/${project.id}/drafts/${DRAFT_KEY}`)).draft;
          if (d && d.content !== JSON.stringify(m.entries)) setDraft(d); else setDraft(null);
        } catch { setDraft(null); }
      }
    } catch (e) { setError(e); }
  }, [project.id, canWrite, drafts]);
  useEffect(() => { load(); }, [load]);

  // Another person's save makes this view out of date; say so rather than overwrite it later.
  useLive(project.id, {
    onContent: (e) => {
      if (!model || savingRef.current || !['publication.saved', 'publication.imported'].includes(e.action)) return;
      if (e.revision && e.revision > model.revision) setNewer({ by: e.by, revision: e.revision });
    },
  });

  // Autosave the unsaved tree as the user's draft (a few seconds after the last change).
  useEffect(() => {
    if (!canWrite || !drafts || !dirty || !model) return undefined;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      put(`/api/projects/${project.id}/drafts/${DRAFT_KEY}`, { content: JSON.stringify(entries), baseRevision: model.revision })
        .then(() => setNotice((n) => (n && n.kind === 'draft' ? n : { kind: 'draft', at: new Date().toISOString() })))
        .catch(() => { /* a failed autosave is retried on the next change */ });
    }, 2000);
    return () => clearTimeout(draftTimer.current);
  }, [entries, dirty, canWrite, drafts, model, project.id]);

  const counts = useMemo(() => countOf(entries), [entries]);
  const missing = useMemo(() => new Set(model ? model.missing : []), [model]);
  const pool = useMemo(() => {
    if (!model) return [];
    const placed = new Set();
    (function walk(list) { for (const e of list || []) { if (e.type === 'folder') walk(e.children); if (e.type === 'dm') placed.add(dmcOf(e).toUpperCase()); if (e.type === 'include') placed.add(e.href.replace(/^.*\//, '').toUpperCase()); } })(entries);
    const q = poolQuery.trim().toLowerCase();
    return model.pool.filter((m) => !placed.has(m.dmc.toUpperCase()) && !placed.has(m.file.toUpperCase()))
      .filter((m) => !q || m.dmc.toLowerCase().includes(q) || `${m.techName || ''} ${m.infoName || ''}`.toLowerCase().includes(q));
  }, [model, entries, poolQuery]);

  const apply = useCallback((next) => { setUndoSnap(entries); setEntries(next); setDirty(true); }, [entries]);

  const onDrop = useCallback((targetKey, where) => {
    if (!drag) return;
    const { parentPath, index } = dropTarget(entries, pathOf(targetKey), where);
    const next = moveTo(entries, pathOf(drag.from), parentPath, index);
    setDrag(null);
    if (next !== entries) apply(next);
  }, [drag, entries, apply]);

  const selectedNode = selected ? getAt(entries, pathOf(selected)) : null;

  function addFromPool(m) {
    const sel = selected ? pathOf(selected) : null;
    const node = sel ? getAt(entries, sel) : null;
    const parentPath = node && node.type === 'folder' ? sel : [];
    const index = node && node.type === 'folder' ? (node.children || []).length : entries.length;
    apply(insertAt(entries, parentPath, index, poolToEntry(m)));
    if (node && node.type === 'folder') setExpanded((s) => new Set([...s, keyOf(sel)]));
  }
  function move(delta) {
    if (!selected) return;
    const r = moveBy(entries, pathOf(selected), delta);
    if (r.entries !== entries) { apply(r.entries); setSelected(keyOf(r.path)); }
  }

  async function save(allowEmpty = false) {
    if (counts.total === 0 && !allowEmpty) { setConfirmEmpty(true); return; }
    setBusy('save');
    savingRef.current = true;
    try {
      const r = await put(`/api/projects/${project.id}/publication/model${allowEmpty ? '?allowEmpty=1' : ''}`, { entries, baseRevision: model.revision });
      setModel({ ...r.model, revision: r.revision, revisionAt: new Date().toISOString(), revisionBy: 'you' });
      setEntries(r.model.entries); setDirty(false); setUndoSnap(null); setDraft(null); setNotice(null); setNewer(null);
      toast.success('Publication saved', `${r.counts.dms} module${r.counts.dms === 1 ? '' : 's'} in ${r.counts.folders} chapter${r.counts.folders === 1 ? '' : 's'}`);
      if (r.unresolved.length) toast.info('Some entries name modules this project does not have', r.unresolved.map((u) => u.code).slice(0, 3).join(', '));
      onSaved && onSaved();
    } catch (e) {
      if (e.code === 'CONFLICT') {
        // Keep the refused tree as the user's draft at once (decisions.md B11).
        clearTimeout(draftTimer.current);
        if (drafts) await put(`/api/projects/${project.id}/drafts/${DRAFT_KEY}`, { content: JSON.stringify(entries), baseRevision: model.revision }).catch(() => {});
        setConflict(e.body.conflict || {});
      } else toast.error('Not saved', e.message);
    }
    savingRef.current = false;
    setBusy(null);
  }

  async function importFile(file) {
    setBusy('import');
    savingRef.current = true;
    try {
      const xml = await file.text();
      const r = await post(`/api/projects/${project.id}/publication/import`, { xml, baseRevision: model.revision });
      toast.success('Publication module imported', `${r.counts.dms} modules in ${r.counts.folders} chapters${r.unresolved.length ? `; ${r.unresolved.length} not in this project` : ''}`);
      await load();
      onSaved && onSaved();
    } catch (e) {
      if (e.code === 'CONFLICT') setConflict(e.body.conflict || {}); else toast.error('Not imported', e.message);
    }
    savingRef.current = false;
    setBusy(null);
  }

  async function discardDraft() {
    try { await api(`/api/projects/${project.id}/drafts/${DRAFT_KEY}`, { method: 'DELETE' }); } catch { /* already gone */ }
    setDraft(null);
  }
  function restoreDraft() {
    try {
      const restored = JSON.parse(draft.content);
      setUndoSnap(entries); setEntries(restored); setDirty(true); setDraft(null);
      toast.info('Draft restored', 'Save to make it the publication.');
    } catch { toast.error('That draft could not be read'); discardDraft(); }
  }

  if (error) return <Card><ErrorState error={error} onRetry={load} /></Card>;
  if (!model) return <Card className="p-6"><LoadingBlock rows={6} /></Card>;
  const readOnly = !canWrite || (!!model.lock && !overriding);

  return (
    <div className="space-y-4">
      <LockBanner lock={model.lock} override={overriding} what="The publication module" />
      {draft && !readOnly ? (
        <Alert tone="info" title="You have an unsaved draft of this publication">
          Autosaved {fmtRelative(draft.updatedAt)}{draft.baseRevision && draft.baseRevision !== model.revision ? `, from revision ${draft.baseRevision} (the publication has been saved since)` : ''}.
          <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" onClick={restoreDraft}>Restore draft</Button><Button size="sm" variant="ghost" onClick={discardDraft}>Discard</Button></div>
        </Alert>
      ) : null}
      {newer ? (
        <Alert tone="warn" title={`${newer.by || 'Someone'} saved the publication`}>
          Your view is out of date.{dirty ? ' Saving now would be refused; reload to see their version (your changes stay in your draft).' : ''}
          <div className="mt-2"><Button size="sm" icon="refresh" onClick={load}>Reload</Button></div>
        </Alert>
      ) : null}
      {model.warnings && model.warnings.length ? (
        <Alert tone="info" title="Kept as-is from the source file">
          <ul className="list-disc pl-4">{model.warnings.slice(0, 8).map((w) => <li key={w}>{w}</li>)}</ul>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2.5 border-b border-line bg-surface-2">
            {!readOnly ? (
              <>
                <Button size="sm" icon="plus" onClick={() => setPrompt({ kind: 'add' })}>Add chapter</Button>
                <Button size="sm" icon="edit" onClick={() => setPrompt({ kind: 'rename' })} disabled={!selectedNode}>Rename</Button>
                {/* Resize Pages for one chapter or module: the pmEntry id the stage-1 stylesheet reads (decisions.md ST6). */}
                <div className="w-40">
                  <Select aria-label="Page of the selected entry" value={selectedNode && selectedNode.page ? selectedNode.page : ''} disabled={!selectedNode}
                    onChange={(e) => apply(updateAt(entries, pathOf(selected), (x) => { const n = { ...x }; if (e.target.value) n.page = e.target.value; else delete n.page; return n; }))}>
                    <option value="">Page: as the book</option>
                    <option value="a4-landscape">A4 landscape</option>
                    <option value="a3-landscape">A3 landscape</option>
                  </Select>
                </div>
                <Button size="sm" icon="arrowUp" onClick={() => move(-1)} disabled={!selectedNode} aria-label="Move up" />
                <Button size="sm" icon="arrowDown" onClick={() => move(1)} disabled={!selectedNode} aria-label="Move down" />
                <Button size="sm" icon="trash" variant="danger-ghost" onClick={() => { apply(removeAt(entries, pathOf(selected)).entries); setSelected(null); }} disabled={!selectedNode}>Remove</Button>
                <Button size="sm" icon="undo" variant="ghost" onClick={() => { setEntries(undoSnap); setUndoSnap(null); setDirty(true); }} disabled={!undoSnap}>Undo</Button>
                <span className="mx-1 h-5 w-px bg-line" />
                <Button size="sm" icon="upload" variant="ghost" onClick={() => fileRef.current && fileRef.current.click()} loading={busy === 'import'}>Import PM</Button>
                <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" className="sr-only" tabIndex={-1} aria-label="Choose a publication module file"
                  onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) setConfirmImport(f); }} />
              </>
            ) : null}
            <span className="ml-auto flex items-center gap-2">
              <span className="text-[12px] text-ink-3" data-testid="pm-counts">{counts.dms} module{counts.dms === 1 ? '' : 's'} · {counts.folders} chapter{counts.folders === 1 ? '' : 's'}{dirty ? ' · unsaved' : ''}{notice && notice.kind === 'draft' && dirty ? ' · draft autosaved' : ''}</span>
              <Button size="sm" variant="ghost" icon="refresh" onClick={load} aria-label="Reload" />
              {!readOnly ? <Button size="sm" variant="primary" icon="check" onClick={() => save()} loading={busy === 'save'} disabled={!dirty}>{dirty ? 'Save publication' : 'Saved'}</Button> : null}
            </span>
          </div>
          <div role="tree" aria-label="Publication chapters" className="py-1 min-h-64 max-h-[60vh] overflow-y-auto"
            onDragOver={(ev) => { if (drag) ev.preventDefault(); }}
            onDrop={(ev) => { if (!drag) return; ev.preventDefault(); const next = moveTo(entries, pathOf(drag.from), [], entries.length); setDrag(null); if (next !== entries) apply(next); }}>
            {entries.length ? entries.map((e, i) => (
              <Row key={i} entry={e} path={[i]} depth={0} expanded={expanded} onToggle={(k) => setExpanded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                selected={selected} onSelect={(p) => setSelected(keyOf(p))} drag={drag} setDrag={setDrag} onDrop={onDrop} missing={missing} readOnly={readOnly} titles={model.titles} />
            )) : (
              <EmptyState icon="book" title="The publication is empty">{readOnly ? 'No chapters or modules yet.' : 'Add a chapter, then add data modules to it from the list on the right.'}</EmptyState>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-line text-[12px] text-ink-3">
            <p>
              {model.revisionAt ? `Saved ${fmtRelative(model.revisionAt)}${model.revisionBy ? ` by ${model.revisionBy}` : ''} · revision ${model.revision}` : `Revision ${model.revision}`}
              {!readOnly ? ' · Drag to rearrange; drop on the middle of a chapter to put it inside.' : ''}
            </p>
            <span className="flex gap-3">
              <a href={`/api/projects/${project.id}/publication/ietm-form`} className="inline-flex items-center gap-1 text-accent hover:underline"><Icon name="download" size={14} />IETM form</a>
              <a href={`/api/projects/${project.id}/publication/pdf-form`} className="inline-flex items-center gap-1 text-accent hover:underline"><Icon name="download" size={14} />PDF form</a>
            </span>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="px-4 pt-4 pb-3 border-b border-line">
            <p className="font-medium text-ink">Not in the publication</p>
            <p className="text-[12px] text-ink-3 mb-2">{readOnly ? 'Data modules this publication does not place.' : `Added to ${selectedNode && selectedNode.type === 'folder' ? `"${selectedNode.title}"` : 'the end'}.`}</p>
            <SearchInput value={poolQuery} onChange={setPoolQuery} label="Search unplaced modules" placeholder="Code or title" />
          </div>
          <ul className="divide-y divide-line max-h-[52vh] overflow-y-auto" aria-label="Unplaced data modules">
            {pool.length ? pool.map((m) => (
              <li key={m.id} className="flex items-center gap-2 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-ink truncate">{m.techName}{m.infoName ? ` – ${m.infoName}` : ''}</p>
                  <p className="font-mono text-[11px] text-ink-3 truncate">{m.dmc}</p>
                </div>
                {!readOnly ? <Button size="icon-sm" variant="ghost" icon="plus" onClick={() => addFromPool(m)} aria-label={`Add ${m.dmc} to the publication`} /> : null}
              </li>
            )) : <li className="px-4 py-6 text-center text-[13px] text-ink-3">{model.pool.length ? 'Every module is placed.' : 'No other data modules.'}</li>}
          </ul>
        </Card>
      </div>

      <TextPromptDialog open={!!prompt} onClose={() => setPrompt(null)}
        title={prompt && prompt.kind === 'add' ? 'Add a chapter' : 'Rename'} label="Title" confirmLabel={prompt && prompt.kind === 'add' ? 'Add chapter' : 'Rename'}
        initial={prompt && prompt.kind === 'rename' && selectedNode ? (selectedNode.title || '') : 'New chapter'}
        onSubmit={(title) => {
          if (prompt.kind === 'add') {
            const next = insertAt(entries, [], entries.length, { type: 'folder', title, children: [] });
            apply(next); setSelected(String(entries.length)); setExpanded((s) => new Set([...s, String(entries.length)]));
          } else if (selected) {
            apply(updateAt(entries, pathOf(selected), (e) => ({ ...e, title })));
          }
          setPrompt(null);
        }} />
      <ConfirmDialog open={confirmEmpty} onClose={() => setConfirmEmpty(false)} title="Save an empty publication?" tone="danger" confirmLabel="Save it empty"
        onConfirm={async () => { setConfirmEmpty(false); await save(true); }}>
        The publication will have no chapters and no data modules, and the PDF will have no content.
      </ConfirmDialog>
      <ConfirmDialog open={!!confirmImport} onClose={() => setConfirmImport(null)} title="Replace the publication module?" confirmLabel="Import"
        onConfirm={async () => { const f = confirmImport; setConfirmImport(null); await importFile(f); }}>
        {confirmImport ? `The publication will be replaced by "${confirmImport.name}".` : ''}{dirty ? ' Your unsaved changes are kept in your draft.' : ''} The current version stays in the revision history.
      </ConfirmDialog>
      <Dialog open={!!conflict} onClose={() => setConflict(null)} title="Someone else saved the publication" size="md"
        description={conflict ? `Revision ${conflict.current || ''} was saved${conflict.updatedBy ? ` by ${conflict.updatedBy}` : ''} after you opened it. Your changes were not saved.` : ''}
        footer={<Button variant="primary" icon="refresh" onClick={() => { setConflict(null); load(); }}>Load the latest version</Button>}>
        <p className="text-ink-2">Your unsaved tree is kept as your draft: after loading, you can restore it and apply your changes again. Nothing is merged automatically.</p>
      </Dialog>
    </div>
  );
}
