import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '../components/ui/Button.jsx';
import { Field, Input, Select } from '../components/ui/Field.jsx';
import { Alert, LoadingBlock, ErrorState } from '../components/ui/States.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { fmtRelative } from '../lib/format.js';
import { get, put } from '../api.js';
import { parseBody, serializeBody, spliceBody, nextBlockId, cleanInlineHtml } from './jssBody.js';

/*
  The Design view of a JSS book (decisions.md ST9): chapters, sections (they
  nest), paragraphs, lists, tables, figures and notice boxes, edited as a
  continuous document rather than as XML — for someone who does not read
  XML, which is the whole of its reason to exist. It is not a second source
  of truth: on save the block tree is serialised straight back into
  <body>...</body> (jssBody.js) inside the same publication.xml the XML view
  edits, through the exact same PUT, so either view always sees the other's
  last save after a reload.

  What this editor does not specifically model (an element outside JSS's
  vocabulary) is kept as an "Other content" block holding its exact source
  XML, edited only in the XML view - never silently dropped.
*/

// ---- immutable tree helpers (a chapter and a section share the same `blocks` shape) ----

function mapContainer(blocks, fn) {
  return blocks.map((b) => {
    const nb = fn(b);
    if (nb === false) return null; // removed
    const next = nb === true ? b : nb;
    if (next.type === 'section' || next.type === 'chapter') return { ...next, blocks: mapContainer(next.blocks, fn) };
    return next;
  }).filter(Boolean);
}
function updateBlocks(chapters, id, patch) {
  return mapContainer(chapters, (b) => (b.id === id ? { ...b, ...patch } : true));
}
function removeBlocks(chapters, id) {
  return mapContainer(chapters, (b) => (b.id === id ? false : true));
}
// Move a block up or down among its own siblings.
function moveBlocks(chapters, id, dir) {
  function walk(blocks) {
    const i = blocks.findIndex((b) => b.id === id);
    if (i >= 0) {
      const j = i + dir;
      if (j < 0 || j >= blocks.length) return blocks;
      const next = blocks.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    }
    return blocks.map((b) => ((b.type === 'section' || b.type === 'chapter') ? { ...b, blocks: walk(b.blocks) } : b));
  }
  return walk(chapters);
}
// Append a new block at the end of a container (chapter/section by id), or at the top level when parentId is null (a new chapter).
function appendBlock(chapters, parentId, block) {
  if (parentId === null) return [...chapters, block];
  function walk(blocks) {
    return blocks.map((b) => {
      if (b.id === parentId && (b.type === 'section' || b.type === 'chapter')) return { ...b, blocks: [...b.blocks, block] };
      if (b.type === 'section' || b.type === 'chapter') return { ...b, blocks: walk(b.blocks) };
      return b;
    });
  }
  return walk(chapters);
}

const blank = { para: () => ({ id: nextBlockId(), type: 'para', html: '' }),
  warning: () => ({ id: nextBlockId(), type: 'warning', html: '' }),
  caution: () => ({ id: nextBlockId(), type: 'caution', html: '' }),
  note: () => ({ id: nextBlockId(), type: 'note', html: '' }),
  list: () => ({ id: nextBlockId(), type: 'list', ordered: false, items: [''] }),
  table: () => ({ id: nextBlockId(), type: 'table', title: '', header: ['', ''], rows: [['', '']] }),
  figure: () => ({ id: nextBlockId(), type: 'figure', title: '', src: '' }),
  section: () => ({ id: nextBlockId(), type: 'section', title: 'New section', blocks: [] }) };

// ---- block editors ----

// Bold/italic/underline on the selection, for a block's own rich text (contentEditable).
function RichText({ html, onChange, placeholder, testId, readOnly }) {
  const ref = useRef(null);
  const focused = useRef(false);
  useEffect(() => { if (ref.current && !focused.current) ref.current.innerHTML = html; }, [html]);
  const commit = () => onChange(cleanInlineHtml(ref.current.innerHTML, DOMParser));
  return (
    <div className="space-y-1">
      {!readOnly ? (
        <div className="flex gap-1">
          {[['bold', 'B'], ['italic', 'I'], ['underline', 'U']].map(([cmd, label]) => (
            <button key={cmd} type="button" title={cmd} tabIndex={-1}
              onMouseDown={(e) => { e.preventDefault(); document.execCommand(cmd); }}
              className="h-6 w-6 grid place-items-center rounded border border-line text-[11px] font-bold text-ink-2 hover:bg-surface-3">{label}</button>
          ))}
        </div>
      ) : null}
      <div ref={ref} contentEditable={!readOnly} suppressContentEditableWarning data-testid={testId}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; if (!readOnly) commit(); }}
        className="min-h-[2.2em] rounded-md border border-line bg-surface px-3 py-2 text-[14px] text-ink outline-none focus:border-accent empty:before:content-[attr(data-placeholder)] empty:before:text-ink-3"
        data-placeholder={placeholder} />
    </div>
  );
}

function Controls({ onUp, onDown, onDelete, label }) {
  return (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <span className="text-[11px] uppercase tracking-wide text-ink-3 mr-1">{label}</span>
      <button type="button" title="Move up" onClick={onUp} className="h-6 w-6 grid place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink">↑</button>
      <button type="button" title="Move down" onClick={onDown} className="h-6 w-6 grid place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink">↓</button>
      <button type="button" title="Delete" onClick={onDelete} className="h-6 w-6 grid place-items-center rounded text-danger hover:bg-danger-soft">×</button>
    </div>
  );
}

function ListEditor({ block, onChange }) {
  const setItem = (i, v) => onChange({ items: block.items.map((it, j) => (j === i ? v : it)) });
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-[12px] text-ink-2">
        <input type="checkbox" checked={block.ordered} onChange={(e) => onChange({ ordered: e.target.checked })} />Numbered
      </label>
      {block.items.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-5 text-[12px] text-ink-3 tabular text-right">{block.ordered ? `${i + 1}.` : '•'}</span>
          <Input value={it} onChange={(e) => setItem(i, e.target.value)} className="flex-1" data-testid="list-item" aria-label={`Item ${i + 1}`} />
          <button type="button" title="Remove item" onClick={() => onChange({ items: block.items.filter((_, j) => j !== i) })}
            className="h-7 w-7 grid place-items-center rounded text-danger hover:bg-danger-soft" disabled={block.items.length === 1}>×</button>
        </div>
      ))}
      <Button size="sm" variant="ghost" icon="plus" onClick={() => onChange({ items: [...block.items, ''] })}>Add item</Button>
    </div>
  );
}

function TableEditor({ block, onChange }) {
  const cols = (block.header || block.rows[0]).length;
  const setHeader = (i, v) => onChange({ header: block.header ? block.header.map((c, j) => (j === i ? v : c)) : null });
  const setCell = (r, c, v) => onChange({ rows: block.rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)) });
  const addRow = () => onChange({ rows: [...block.rows, Array(cols).fill('')] });
  const addCol = () => onChange({ header: block.header ? [...block.header, ''] : null, rows: block.rows.map((r) => [...r, '']) });
  const delRow = (i) => onChange({ rows: block.rows.filter((_, j) => j !== i) });
  const delCol = (c) => onChange({ header: block.header ? block.header.filter((_, j) => j !== c) : null, rows: block.rows.map((r) => r.filter((_, j) => j !== c)) });
  return (
    <div className="space-y-2">
      <Field label="Table title (optional)">{(p) => <Input {...p} value={block.title} onChange={(e) => onChange({ title: e.target.value })} />}</Field>
      <label className="flex items-center gap-2 text-[12px] text-ink-2">
        <input type="checkbox" checked={!!block.header} onChange={(e) => onChange({ header: e.target.checked ? Array(cols).fill('') : null })} />Header row
      </label>
      <div className="overflow-auto">
        <table className="border-collapse">
          <tbody>
            {block.header ? (
              <tr>{block.header.map((c, i) => (
                <td key={i} className="border border-line p-0.5"><Input value={c} onChange={(e) => setHeader(i, e.target.value)} className="font-semibold w-32" aria-label={`Header ${i + 1}`} /></td>
              ))}<td><button type="button" onClick={() => delCol(cols - 1)} className="h-6 w-6 text-danger" title="Remove last column" disabled={cols <= 1}>×</button></td></tr>
            ) : null}
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((c, cI) => <td key={cI} className="border border-line p-0.5"><Input value={c} onChange={(e) => setCell(r, cI, e.target.value)} className="w-32" aria-label={`Row ${r + 1} cell ${cI + 1}`} /></td>)}
                <td><button type="button" onClick={() => delRow(r)} className="h-6 w-6 text-danger" title="Remove row" disabled={block.rows.length <= 1}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2"><Button size="sm" variant="ghost" icon="plus" onClick={addRow}>Row</Button><Button size="sm" variant="ghost" icon="plus" onClick={addCol}>Column</Button></div>
    </div>
  );
}

function FigureEditor({ block, onChange, projectId }) {
  const [list, setList] = useState(null);
  useEffect(() => { get(`/api/projects/${projectId}/graphics`).then((r) => setList(r.graphics.filter((g) => g.present))).catch(() => setList([])); }, [projectId]);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="Caption">{(p) => <Input {...p} value={block.title} onChange={(e) => onChange({ title: e.target.value })} />}</Field>
      <Field label="Artwork">{(p) => (
        list === null ? <LoadingBlock rows={1} /> : (
          <Select {...p} value={block.src || ''} onChange={(e) => onChange({ src: e.target.value })}>
            <option value="">Choose…</option>
            {list.map((g) => <option key={g.icn} value={g.file}>{g.icn}{g.title ? ` – ${g.title}` : ''}</option>)}
          </Select>
        )
      )}</Field>
    </div>
  );
}

const NOTICE_LABEL = { warning: 'Warning', caution: 'Caution', note: 'Note' };

function Inserter({ onInsert, allowSection }) {
  const [open, setOpen] = useState(false);
  const items = [['para', 'Paragraph'], ['list', 'List'], ['table', 'Table'], ['figure', 'Figure'], ['warning', 'Warning'], ['caution', 'Caution'], ['note', 'Note'], ...(allowSection ? [['section', 'Sub-section']] : [])];
  return (
    <div className="relative inline-block">
      <Button size="sm" variant="ghost" icon="plus" onClick={() => setOpen((o) => !o)}>Add</Button>
      {open ? (
        <div className="absolute z-10 mt-1 w-44 rounded-md border border-line bg-surface shadow-pop py-1">
          {items.map(([t, label]) => (
            <button key={t} type="button" onClick={() => { onInsert(t); setOpen(false); }}
              className="block w-full text-left px-3 py-1.5 text-[13px] text-ink-2 hover:bg-surface-3 hover:text-ink">{label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Block({ block, onChange, onUp, onDown, onDelete, projectId, readOnly }) {
  const update = (patch) => onChange(block.id, patch);
  let body;
  if (block.type === 'para') body = <RichText html={block.html} onChange={(html) => update({ html })} placeholder="Type a paragraph…" testId={readOnly ? undefined : 'para-editor'} readOnly={readOnly} />;
  else if (block.type === 'list') body = <ListEditor block={block} onChange={update} readOnly={readOnly} />;
  else if (block.type === 'table') body = <TableEditor block={block} onChange={update} readOnly={readOnly} />;
  else if (block.type === 'figure') body = <FigureEditor block={block} onChange={update} projectId={projectId} readOnly={readOnly} />;
  else if (block.type === 'warning' || block.type === 'caution' || block.type === 'note') {
    body = <RichText html={block.html} onChange={(html) => update({ html })} placeholder={`Type the ${NOTICE_LABEL[block.type].toLowerCase()}…`} readOnly={readOnly} />;
  } else if (block.type === 'unknown') {
    body = <Alert tone="info">This is <code className="font-mono">&lt;{block.tag}&gt;</code> content the Design view does not edit. Use the XML view to change it; it is kept exactly as it is here.</Alert>;
  } else if (block.type === 'section') return null; // sections render through Section below
  return (
    <div className="group rounded-md border border-line p-3 space-y-2 bg-surface">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{block.type === 'unknown' ? block.tag : NOTICE_LABEL[block.type] || block.type}</span>
        {!readOnly ? <Controls onUp={onUp} onDown={onDown} onDelete={onDelete} /> : null}
      </div>
      {body}
    </div>
  );
}

function Section({ node, onChange, onUp, onDown, onDelete, onInsert, projectId, depth, readOnly, isChapter }) {
  return (
    <div className={depth > 0 ? 'ml-5 border-l-2 border-line pl-4' : ''}>
      <div className="group flex items-center gap-2 mb-2">
        {isChapter ? <Input value={node.number} onChange={(e) => onChange(node.id, { number: e.target.value })} className="w-16 font-mono" disabled={readOnly} aria-label="Chapter number" /> : null}
        <Input value={node.title} onChange={(e) => onChange(node.id, { title: e.target.value })} placeholder={isChapter ? 'Chapter title' : 'Section title'}
          className={isChapter ? 'text-[17px] font-semibold flex-1' : 'text-[15px] font-medium flex-1'} disabled={readOnly} aria-label={isChapter ? 'Chapter title' : 'Section title'} />
        {!readOnly ? <Controls onUp={onUp} onDown={onDown} onDelete={onDelete} label={isChapter ? 'chapter' : 'section'} /> : null}
      </div>
      <div className="space-y-2 mb-2">
        {node.blocks.map((b) => (
          b.type === 'section'
            ? <Section key={b.id} node={b} onChange={onChange} onUp={() => onUp(b.id)} onDown={() => onDown(b.id)} onDelete={() => onDelete(b.id)} onInsert={onInsert} projectId={projectId} depth={depth + 1} readOnly={readOnly} isChapter={false} />
            : <Block key={b.id} block={b} onChange={onChange} onUp={() => onUp(b.id)} onDown={() => onDown(b.id)} onDelete={() => onDelete(b.id)} projectId={projectId} depth={depth + 1} readOnly={readOnly} />
        ))}
      </div>
      {!readOnly ? <Inserter onInsert={(t) => onInsert(node.id, t)} allowSection /> : null}
    </div>
  );
}

export default function BookDesignView({ project, canWrite: mayWrite, onSaved, overriding = false }) {
  const toast = useToast();
  const [pm, setPm] = useState(null);
  const [chapters, setChapters] = useState(null);
  const [notBook, setNotBook] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [initialBody, setInitialBody] = useState(null);
  const canWrite = mayWrite && (!(pm && pm.lock) || overriding);

  const load = useCallback(() => {
    get(`/api/projects/${project.id}/publication`).then((r) => {
      setPm(r); setError(null);
      const parsed = parseBody(r.xml);
      if (!parsed.ok) { setNotBook(true); setChapters([]); return; }
      setNotBook(false); setChapters(parsed.chapters); setInitialBody(serializeBody(parsed.chapters));
    }).catch(setError);
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const change = (id, patch) => setChapters((cs) => updateBlocks(cs, id, patch));
  const up = (id) => setChapters((cs) => moveBlocks(cs, id, -1));
  const down = (id) => setChapters((cs) => moveBlocks(cs, id, 1));
  const del = (id) => { if (window.confirm('Delete this? There is no undo here — use the XML view\'s own history if you need it back.')) setChapters((cs) => removeBlocks(cs, id)); };
  const insert = (parentId, type) => setChapters((cs) => appendBlock(cs, parentId, blank[type]()));
  const addChapter = () => setChapters((cs) => [...cs, { id: nextBlockId(), type: 'chapter', number: String(cs.length + 1), title: 'New chapter', blocks: [] }]);

  const bodyNow = chapters ? serializeBody(chapters) : null;
  const dirty = chapters && initialBody !== null && bodyNow !== initialBody;

  async function save() {
    setBusy(true); setSaveError(null);
    try {
      const xml = spliceBody(pm.xml, bodyNow);
      const r = await put(`/api/projects/${project.id}/publication`, { xml, baseRevision: pm.revision });
      setPm({ ...pm, xml, revision: r.revision, revisionAt: new Date().toISOString(), revisionBy: 'you' });
      setInitialBody(bodyNow);
      toast.success('Publication module saved');
      onSaved && onSaved();
    } catch (e) { setSaveError(e); }
    setBusy(false);
  }

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!chapters) return <LoadingBlock rows={6} />;
  if (notBook) return <Alert tone="warn">The publication module is not a JSS book right now (its root is not &lt;jssbook&gt;, or it has no &lt;body&gt;). Fix that in the XML view first.</Alert>;

  return (
    <div className="space-y-4">
      {saveError ? <Alert>{saveError.message}</Alert> : null}
      {!canWrite ? <Alert tone="info">Read only.</Alert> : null}
      {chapters.map((c) => (
        <Section key={c.id} node={c} onChange={change} onUp={() => up(c.id)} onDown={() => down(c.id)} onDelete={() => del(c.id)} onInsert={insert} projectId={project.id} depth={0} readOnly={!canWrite} isChapter />
      ))}
      {canWrite ? (
        <div className="flex items-center justify-between pt-2 border-t border-line">
          <Button variant="ghost" icon="plus" onClick={addChapter}>Add chapter</Button>
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-ink-3">{pm && pm.revisionAt ? `saved ${fmtRelative(pm.revisionAt)}${pm.revisionBy ? ` by ${pm.revisionBy}` : ''}` : ''}{dirty ? ' · unsaved' : ''}</span>
            <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>{dirty ? 'Save publication module' : 'Saved'}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
