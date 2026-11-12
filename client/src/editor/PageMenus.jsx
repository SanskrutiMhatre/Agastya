import { useEffect, useMemo, useRef, useState } from 'react';
import Button from '../components/ui/Button.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { Field, Input, Select } from '../components/ui/Field.jsx';
import { Alert } from '../components/ui/States.jsx';
import { elementAt } from './xmlDoc.js';
import { allIds } from './ops.js';
import { findText, wordCount, COLWIDTH } from './commands.js';

/*
  The page view's menus (decisions.md PV15): a menu bar over the toolbar, a
  context menu on the right mouse button, and the dialogs the Tools menu
  opens. Menu items are { label, shortcut?, onSelect?, disabled?, title?,
  checked?, testId? } or { divider: true }. Pointer presses on a menu never
  take the focus from the text being edited, so an action applies where the
  caret is.
*/

const keep = (e) => e.preventDefault();

function MenuList({ items, onClose, label, style, className = '' }) {
  const ref = useRef(null);
  useEffect(() => { const first = ref.current && ref.current.querySelector('[role="menuitem"]:not([disabled])'); if (first) first.focus({ preventScroll: true }); }, []);
  const move = (e) => {
    const all = Array.from(ref.current.querySelectorAll('[role="menuitem"]:not([disabled])'));
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (all[i + 1] || all[0]).focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (all[i - 1] || all[all.length - 1]).focus(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  return (
    <div ref={ref} role="menu" aria-label={label} onKeyDown={move} style={style}
      className={`z-30 min-w-56 rounded-md border border-line bg-surface py-1 text-[13px] shadow-pop ${className}`}>
      {items.map((it, i) => (it.divider ? <div key={i} role="separator" className="my-1 h-px bg-line" /> : (
        <button key={i} type="button" role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={it.checked === undefined ? undefined : !!it.checked}
          disabled={!!it.disabled} title={it.title} data-testid={it.testId} onMouseDown={keep}
          onClick={() => { onClose(); if (it.onSelect) it.onSelect(); }}
          className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-ink hover:bg-surface-3 focus:bg-surface-3 focus:outline-none disabled:text-ink-3 disabled:hover:bg-transparent">
          <span className="w-3 text-accent">{it.checked ? '✓' : ''}</span>
          <span className="flex-1">{it.label}</span>
          {it.shortcut ? <span className="font-mono text-[11px] text-ink-3">{it.shortcut}</span> : null}
        </button>
      )))}
    </div>
  );
}

export function MenuBar({ menus }) {
  const [open, setOpen] = useState(null);
  // Menus float over the page (fixed to the window), so the editor's scrolling card never clips them.
  const [at, setAt] = useState(null);
  const openAt = (label, btn) => {
    if (!label) { setOpen(null); return; }
    const r = btn.getBoundingClientRect();
    const top = r.bottom + 4;
    setAt({ position: 'fixed', left: Math.max(8, Math.min(r.left, window.innerWidth - 280)), top, maxHeight: Math.max(160, window.innerHeight - top - 8), overflowY: 'auto' });
    setOpen(label);
  };
  const bar = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (bar.current && !bar.current.contains(e.target)) setOpen(null); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div ref={bar} role="menubar" aria-label="Editor menus" className="flex flex-wrap items-center gap-0.5 text-[12.5px]" data-testid="page-menubar">
      {menus.map((m) => (
        <div key={m.label} className="relative">
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open === m.label} onMouseDown={keep}
            onClick={(e) => openAt(open === m.label ? null : m.label, e.currentTarget)} onMouseEnter={(e) => { if (open && open !== m.label) openAt(m.label, e.currentTarget); }}
            className={`rounded px-2 py-1 font-medium ${open === m.label ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-3 hover:text-ink'}`}>{m.label}</button>
          {open === m.label ? <MenuList items={m.items} label={m.label} onClose={() => setOpen(null)} style={at} /> : null}
        </div>
      ))}
    </div>
  );
}

// The context menu, at the pointer; it closes on Escape, a choice or a click elsewhere.
export function ContextMenu({ x, y, title, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [onClose]);
  const left = Math.max(8, Math.min(x, window.innerWidth - 260));
  const top = Math.max(8, Math.min(y, window.innerHeight - 40 - items.length * 30));
  return (
    <div ref={ref} className="fixed z-40" style={{ left, top }} data-testid="context-menu">
      <MenuList items={[{ label: title, disabled: true }, { divider: true }, ...items]} label={`Actions for ${title}`} onClose={onClose} />
    </div>
  );
}

// ---- tool dialogs ----------------------------------------------------------------------------

/*
  Find and replace in the module's content text. Next and Previous select the
  element holding the match and scroll to it; Replace changes the current
  match, Replace all every one (one undo step either way).
*/
export function FindReplaceDialog({ doc, readOnly, onGo, onReplace, onClose }) {
  const [q, setQ] = useState('');
  const [rep, setRep] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [at, setAt] = useState(0);
  const matches = useMemo(() => findText(doc, q, { matchCase }), [doc, q, matchCase]);
  useEffect(() => { setAt(0); }, [q, matchCase]);
  const cur = matches.length ? matches[Math.min(at, matches.length - 1)] : null;
  const go = (d) => { if (!matches.length) return; const i = (Math.min(at, matches.length - 1) + d + matches.length) % matches.length; setAt(i); onGo(matches[i]); };
  return (
    <Dialog open onClose={onClose} title="Find and replace" size="md" description="Searches the text of the content (the identification has its own dialog).">
      <div className="space-y-3" data-testid="find-replace">
        <Field label="Find">{(p) => <Input {...p} value={q} onChange={(e) => setQ(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); } }} />}</Field>
        {!readOnly ? <Field label="Replace with">{(p) => <Input {...p} value={rep} onChange={(e) => setRep(e.target.value)} maxLength={2000} />}</Field> : null}
        <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />Match case</label>
        <p className="text-[12.5px] text-ink-3" data-testid="find-count" aria-live="polite">
          {!q ? 'Type something to find.' : matches.length ? `${Math.min(at, matches.length - 1) + 1} of ${matches.length}` : 'No matches.'}
        </p>
        {cur ? <p className="rounded bg-surface-2 px-2 py-1 font-mono text-[12px] text-ink-2 truncate" title={cur.context}>…{cur.context}…</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => go(-1)} disabled={!matches.length}>Previous</Button>
          <Button size="sm" onClick={() => go(1)} disabled={!matches.length}>Next</Button>
          {!readOnly ? (
            <>
              <Button size="sm" onClick={() => { if (cur) onReplace([cur], rep); }} disabled={!cur}>Replace</Button>
              <Button size="sm" variant="primary" onClick={() => onReplace(matches, rep)} disabled={!matches.length}>Replace all</Button>
            </>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

export function WordCountDialog({ doc, onClose }) {
  const c = wordCount(doc);
  const rows = [['Words', c.words], ['Characters (no spaces)', c.characters], ['Paragraphs', c.paragraphs], ['Sections', c.sections], ['Steps', c.steps], ['Figures', c.figures], ['Tables', c.tables]];
  return (
    <Dialog open onClose={onClose} title="Word count" size="sm" description="The content of this module, without the identification.">
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-[13px]" data-testid="word-count">
        {rows.map(([k, v]) => [<dt key={`${k}t`} className="text-ink-2">{k}</dt>, <dd key={`${k}d`} className="text-right tabular font-medium">{v}</dd>])}
      </dl>
    </Dialog>
  );
}

export const SHORTCUTS = [
  ['Save', 'Ctrl+S'], ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'], ['Bold, italic, underline', 'Ctrl+B, Ctrl+I, Ctrl+U'],
  ['New paragraph (in a title: the first paragraph; in a bullet: the next bullet)', 'Enter'],
  ['End a list (on an empty last bullet)', 'Enter'], ['Join with the paragraph before / after', 'Backspace at the start / Delete at the end'], ['New section after this one', 'Shift+Enter'],
  ['Block after / before this one', 'Ctrl+Enter / Ctrl+Shift+Enter'],
  ['Demote / promote a section, step or bullet (in a table: next / previous cell)', 'Tab / Shift+Tab'],
  ['Paragraph, section, sub-section', 'Ctrl+Alt+P, Ctrl+Alt+1, Ctrl+Alt+2'],
  ['Warning, caution, note', 'Ctrl+Alt+W, Ctrl+Alt+C, Ctrl+Alt+N'], ['Procedural step', 'Ctrl+Alt+S'],
  ['Figure, table, reference', 'Ctrl+Alt+G, Ctrl+Alt+T, Ctrl+K'], ['Insert any element', '/ in an empty line, Ctrl+/'],
  ['Find and replace', 'Ctrl+H'], ['Print the page', 'Ctrl+P'], ['Validate', 'Ctrl+Shift+V'],
];

export function ShortcutsDialog({ onClose }) {
  return (
    <Dialog open onClose={onClose} title="Keyboard shortcuts" size="md">
      <table className="w-full text-[13px]" data-testid="shortcuts">
        <tbody className="divide-y divide-line">
          {SHORTCUTS.map(([what, keys]) => <tr key={what}><td className="py-1.5 pr-4 text-ink">{what}</td><td className="py-1.5 font-mono text-[12px] text-ink-2 whitespace-nowrap">{keys}</td></tr>)}
        </tbody>
      </table>
    </Dialog>
  );
}

// Column widths of a table: proportional (2*) or absolute (30mm, 1in, 12pt); empty leaves it to the build.
export function ColumnWidthsDialog({ widths, onSave, onClose }) {
  const [v, setV] = useState(widths);
  const bad = v.map((w) => !!w && !COLWIDTH.test(w.trim()));
  return (
    <Dialog open onClose={onClose} title="Column widths" size="sm" description="Proportional, like 2*, or a length, like 30mm. Leave empty for the default."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={bad.some(Boolean)} onClick={() => onSave(v.map((w) => w.trim()))}>Apply</Button></>}>
      <div className="space-y-2" data-testid="column-widths">
        {v.map((w, i) => (
          <Field key={i} label={`Column ${i + 1}`} error={bad[i] ? 'Use a number followed by *, mm, cm, pt, pi or in.' : undefined}>
            {(p) => <Input {...p} value={w} maxLength={12} onChange={(e) => setV(v.map((x, j) => (j === i ? e.target.value : x)))} />}
          </Field>
        ))}
      </div>
    </Dialog>
  );
}

/*
  The attributes of one element, as the schema declares them: a list for
  enumerated ones, text otherwise. An id must be a name not used elsewhere.
*/
export function AttributesDialog({ doc, model, path, onSave, onClose }) {
  const el = elementAt(doc, path);
  const decl = model.attributesOf(el.nodeName);
  const names = Object.keys(decl).filter((a) => !/^xmlns|^xsi:/.test(a)).sort();
  const [v, setV] = useState(() => Object.fromEntries(names.map((a) => [a, el.getAttribute(a) || ''])));
  const ids = useMemo(() => { const s = allIds(doc); s.delete(el.getAttribute('id') || ''); return s; }, [doc, el]);
  const err = (a) => {
    const x = v[a];
    if (!x) return undefined;
    if (decl[a].length && !decl[a].includes(x)) return 'Choose one of the listed values.';
    if (a === 'id' && !/^[A-Za-z_][\w.-]*$/.test(x)) return 'An id starts with a letter and has no spaces.';
    if (a === 'id' && ids.has(x)) return 'Another element already has this id.';
    return undefined;
  };
  const bad = names.some((a) => err(a));
  return (
    <Dialog open onClose={onClose} title={`Attributes of <${el.nodeName}>`} size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={bad} onClick={() => onSave(Object.fromEntries(names.filter((a) => (el.getAttribute(a) || '') !== v[a]).map((a) => [a, v[a]])))}>Apply</Button></>}>
      {!names.length ? <Alert tone="info" title="No attributes">The schema declares no attributes for this element.</Alert> : (
        <div className="grid gap-2 sm:grid-cols-2" data-testid="attributes-form">
          {names.map((a) => (
            <Field key={a} label={a} error={err(a)}>
              {(p) => (decl[a].length
                ? <Select {...p} value={v[a]} onChange={(e) => setV({ ...v, [a]: e.target.value })}><option value="">(none)</option>{decl[a].map((x) => <option key={x} value={x}>{x}</option>)}</Select>
                : <Input {...p} value={v[a]} maxLength={500} onChange={(e) => setV({ ...v, [a]: e.target.value })} />)}
            </Field>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/*
  Print the page as it reads: the page view's content in a frame with the
  application's styles and nothing else (no toolbar, no editing marks).
*/
export function printPage(host, title) {
  if (!host) return;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const d = frame.contentDocument;
  d.open();
  d.write('<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>');
  d.close();
  d.title = title || 'Data module';
  for (const s of Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))) d.head.appendChild(s.cloneNode(true));
  const page = host.cloneNode(true);
  for (const n of Array.from(page.querySelectorAll('[contenteditable]'))) n.removeAttribute('contenteditable');
  for (const n of Array.from(page.querySelectorAll('button[data-testid="edit-ident"]'))) n.remove();
  d.body.appendChild(page);
  const done = () => setTimeout(() => frame.remove(), 1000);
  frame.contentWindow.addEventListener('afterprint', done);
  setTimeout(() => { frame.contentWindow.focus(); frame.contentWindow.print(); done(); }, 50);
}
