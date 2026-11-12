import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../components/ui/Dialog.jsx';
import Button from '../components/ui/Button.jsx';
import { Alert } from '../components/ui/States.jsx';
import Icon from '../components/Icon.jsx';
import {
  parseXml, serializeXml, elementAt, elementChildren, childNames, displayText, contentProblems, insertElement, insertInline, setText,
  removeElement, moveElement, setAttribute, namesAfterMove, namesAfterRemove,
} from './xmlDoc.js';
import {
  FORMATS, wrapText, unwrap, insertBlock, insertInlineSpec, elementIndexAt, referenceTargets, labelFor,
  addRow, deleteRow, addColumn, deleteColumn, tableContext, addListItem, indentItem, outdentItem, listSpec,
  cellActions, mergeRight, mergeDown, splitCell, setIdent,
} from './ops.js';
import {
  nearest, nearestSlot, insertNamed, blockAround, newSection, newSubSection, canDemote, demote, canPromote, promote,
  canMoveIntoPrevious, moveIntoPrevious, canAddSibling, addSibling, exitList, cellAlignOptions, setCellAttr, cellRange, mergeRange,
  addColumnSpanned, canDeleteColumnSpanned, deleteColumnSpanned, columnWidths, setColumnWidths, replaceMatches,
  resequenceIds, RESEQUENCE_KINDS, assignIds, reindent, liveChecks,
  blockSlot, splitBlock, addRefIssue, backspaceAction, backspaceAtStart, addRowSpanned, deleteRowSpanned, replacements, replaceElement, duplicate, unresolvedDmRefs,
} from './commands.js';
import { MenuBar, ContextMenu, FindReplaceDialog, WordCountDialog, ShortcutsDialog, ColumnWidthsDialog, AttributesDialog, printPage } from './PageMenus.jsx';
import { refTarget } from './StructuredEditor.jsx';
import { InsertPalette, ReferenceDialog, FigureDialog, TableDialog, IdentDialog } from './PageDialogs.jsx';

/*
  The page view ("Design", checkpoint 2d, decisions.md PV1-PV9): the data
  module shown the way it reads on the page, and edited there.

    page        numbered paragraphs and steps, warning/caution/note boxes,
                numbered and bulleted lists, figures with their artwork,
                CALS tables with spans, references as labelled pills
    text        edited in place; Enter makes the next paragraph; paste is
                plain text only
    toolbar     formats on the selected text, insert (also "/" and the right
                mouse button) of what the content model allows here,
                references, figures, tables, lists, and table and list tools
    marks       content-model problems and the last validation's findings
                outlined where they are

  The XML text stays the single source: every action parses it, changes the
  DOM (ops.js, xmlDoc.js) and writes it back, and only what changed is
  rewritten, so saving, drafts, conflicts, the lock and validation work as
  before. Anything the view does not draw specially (comments, processing
  instructions, CDATA, unknown elements) is shown locked and kept exactly.
*/

const key = (p) => p.join('.');
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const isWs = (s) => /^\s*$/.test(s);
const PARA_LIKE = new Set(['para', 'simplePara', 'notePara', 'warningAndCautionPara', 'attentionListItemPara', 'attentionSequentialListItemPara', 'attentionRandomListItemPara', 'legend', 'caption']);
const BOX = { warning: ['WARNING', 'border-danger bg-danger-soft/40 text-danger'], caution: ['CAUTION', 'border-warn bg-warn-soft/40 text-warn'], note: ['NOTE', 'border-accent/50 bg-accent-soft/30 text-accent'] };
const SECTION = { preliminaryRqmts: 'Preliminary requirements', mainProcedure: 'Procedure', closeRqmts: 'Requirements after job completion' };
const ITEM_COLS = ['Name/Alternate name', 'Identification/Reference', 'Quantity', 'Remark'];
const REQ = {
  reqCondGroup: { title: 'Required conditions', kind: 'cond', cols: ['Action/Condition', 'Data module/Technical publication'], none: 'noConds' },
  reqPersons: { title: 'Required persons', kind: 'persons', cols: ['Person', 'Category', 'Skill level', 'Trade', 'Est. time'] },
  reqTechInfoGroup: { title: 'Required technical information', kind: 'cond', cols: ['Technical information', 'Data module/Technical publication'] },
  reqSupportEquips: { title: 'Support equipment', kind: 'items', cols: ITEM_COLS, none: 'noSupportEquips', group: 'supportEquipDescrGroup', item: 'supportEquipDescr' },
  reqSupplies: { title: 'Consumables, materials and expendables', kind: 'items', cols: ITEM_COLS, none: 'noSupplies', group: 'supplyDescrGroup', item: 'supplyDescr' },
  reqSpares: { title: 'Spares', kind: 'items', cols: ITEM_COLS, none: 'noSpares', group: 'spareDescrGroup', item: 'spareDescr' },
  reqSafety: { title: 'Safety conditions', kind: 'safety', none: 'noSafety' },
};
const name0 = (el) => el.nodeName;
const EMPHASIS = { em01: 'font-semibold', em02: 'italic', em03: 'underline', em04: 'overline', em05: 'line-through' };
const INLINE_REFS = new Set(['internalRef', 'dmRef', 'pmRef', 'externalPubRef', 'footnoteRef']);

// The text of a dmCode as the page shows it.
function dmcOf(el) {
  const c = el && el.getElementsByTagName('dmCode')[0];
  if (!c) return '';
  const v = (k) => c.getAttribute(k) || '';
  return `${v('modelIdentCode')}-${v('systemDiffCode')}-${v('systemCode')}-${v('subSystemCode')}${v('subSubSystemCode')}-${v('assyCode')}-${v('disassyCode')}${v('disassyCodeVariant')}-${v('infoCode')}${v('infoCodeVariant')}-${v('itemLocationCode')}`;
}
const textAttr = (el, name, attr) => { const x = el && el.getElementsByTagName(name)[0]; return (x && x.getAttribute(attr)) || '–'; };
const textOf = (el, name) => { const x = el && el.getElementsByTagName(name)[0]; return x ? x.textContent.replace(/\s+/g, ' ').trim() : ''; };

/*
  One run of text, edited in place. Uncontrolled while focused (React never
  moves the caret); committed on blur. Reports the caret and any selection
  within it. Paste and drop are plain text.
*/
// The selection inside a run, as offsets in its text (start, end).
function runOffsets(el) {
  const s = window.getSelection();
  const len = (el.textContent || '').length;
  if (!s || !s.rangeCount || !el.contains(s.anchorNode)) return [len, len];
  const r = s.getRangeAt(0);
  const at = (node, off) => { const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(node, off); return pre.toString().length; };
  return [at(r.startContainer, r.startOffset), at(r.endContainer, r.endOffset)];
}

function TextRun({ value, readOnly, path, index, placeholder, onCommit, onCaret, onEnter, onSlash, onBackspaceStart, onDeleteEnd, tail = false }) {
  const ref = useRef(null);
  const atFocus = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== value) el.textContent = value;
  }, [value]);
  const report = () => {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !ref.current || !ref.current.contains(s.anchorNode)) return;
    const r = s.getRangeAt(0);
    const a = r.startContainer === ref.current ? 0 : r.startOffset;
    const b = r.endContainer === ref.current ? (ref.current.textContent || '').length : r.endOffset;
    onCaret({ nodeIndex: index, offset: Math.min(a, b), end: Math.max(a, b) });
  };
  return (
    <span
      ref={ref} role="textbox" aria-multiline="false" aria-label={placeholder || 'Text'} tabIndex={readOnly ? -1 : 0}
      data-run={`${key(path)}:${index}`} data-testid={`run-${key(path)}-${index}`}
      contentEditable={readOnly ? false : 'plaintext-only'} suppressContentEditableWarning spellCheck
      data-placeholder={placeholder || ''}
      // An empty run after a reference still has room to be clicked.
      className={`outline-none rounded-sm ${tail ? 'inline-block min-w-[2ch] align-baseline' : ''} ${readOnly ? '' : 'focus:bg-accent-soft/50 hover:bg-surface-3/50'} empty:before:content-[attr(data-placeholder)] empty:before:text-ink-3 empty:before:italic`}
      onFocus={() => { atFocus.current = value; report(); }}
      onBlur={(e) => {
        const el = e.currentTarget;
        if (el.dataset.skip === '1') { delete el.dataset.skip; el.textContent = value; atFocus.current = null; return; }
        // The document changed under this run while it was focused (an undo, another edit): that change wins.
        if (atFocus.current !== null && atFocus.current !== value) { el.textContent = value; atFocus.current = null; return; }
        atFocus.current = null;
        el.dataset.typed = '';
        if (el.textContent !== value) onCommit(el.textContent);
      }}
      onKeyUp={report} onMouseUp={report}
      // Whether this run holds typing not yet committed (Ctrl+Z then undoes typing, else the last edit).
      onInput={(e) => { e.currentTarget.dataset.typed = e.currentTarget.textContent !== value ? '1' : ''; }}
      // The caret was just reported: the paragraph around must not re-select without it.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Split at the caret; selected text is replaced by the break, as in any editor.
          e.preventDefault();
          const t = e.currentTarget.textContent || '';
          const [a, b] = runOffsets(e.currentTarget);
          onEnter(t.slice(0, a) + t.slice(b), a);
        } else if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && onBackspaceStart) {
          const [a, b] = runOffsets(e.currentTarget);
          if (a === 0 && b === 0 && onBackspaceStart(e.currentTarget.textContent || '')) e.preventDefault();
        } else if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey && onDeleteEnd) {
          const t = e.currentTarget.textContent || '';
          const [a, b] = runOffsets(e.currentTarget);
          if (a === t.length && b === t.length && onDeleteEnd(t)) e.preventDefault();
        }
        else if (e.key === 'Enter') e.preventDefault(); // Shift/Ctrl+Enter: the page's shortcuts (never a line break)
        else if (e.key === '/' && !readOnly && (e.currentTarget.textContent || '') === '') { e.preventDefault(); onSlash(); }
      }}
      onPaste={(e) => {
        e.preventDefault();
        const text = (e.clipboardData.getData('text/plain') || '').replace(/\r?\n/g, ' ');
        document.execCommand('insertText', false, text);
      }}
      onDrop={(e) => e.preventDefault()}
    />
  );
}

// A figure's artwork; a file that does not load says so (React state, never a DOM swap React does not know of).
function Artwork({ src, icn, inline = false }) {
  const [failed, setFailed] = useState(false);
  if (inline) {
    if (failed) return <span className="inline-block rounded border border-dashed border-danger px-1 text-[11px] text-danger align-middle" data-testid="symbol-missing" title={`Symbol ${icn} is not in the project`}>symbol {icn} missing</span>;
    return <img src={src} alt={`Symbol ${icn}`} className="inline-block max-h-10 align-middle" data-testid="symbol-image" onError={() => setFailed(true)} />;
  }
  if (failed) return <span className="block px-6 py-8 text-[12px] text-danger border border-dashed border-danger rounded" data-testid="figure-missing">Artwork {icn} is not in the project</span>;
  return <img src={src} alt={`Graphic ${icn}`} className="mx-auto max-h-72 max-w-full object-contain" data-testid="figure-image" onError={() => setFailed(true)} />;
}

// A colspec's width on the page: proportional (n*) as a share of the proportional total, a length as itself.
const UNIT = { mm: 'mm', cm: 'cm', in: 'in', pt: 'pt', pi: 'pc' };
function colStyle(w, colspecs) {
  if (!w) return undefined;
  const len = /^(\d+(?:\.\d+)?)(mm|cm|in|pt|pi)$/.exec(w);
  if (len) return { width: `${len[1]}${UNIT[len[2]]}` };
  const star = /^(\d+(?:\.\d+)?)\*$/.exec(w);
  if (!star) return undefined;
  const total = colspecs.reduce((t, c) => { const m = /^(\d+(?:\.\d+)?)\*$/.exec(c.getAttribute('colwidth') || ''); return t + (m ? parseFloat(m[1]) : 0); }, 0) || 1;
  return { width: `${(parseFloat(star[1]) / total) * 100}%` };
}

// Put the caret into the run `${path}:${index}` (selection a..b): now, or once the page has rendered.
function focusRun(host, path, index, a, b = a, now = false) {
  const go = () => {
    const el = host && host.querySelector(`[data-run="${path.join('.')}:${index}"]`);
    if (!el) return;
    el.focus();
    const t = el.firstChild;
    const g = document.createRange();
    if (t && t.nodeType === 3) { g.setStart(t, Math.min(a, t.length)); g.setEnd(t, Math.min(b, t.length)); } else { g.selectNodeContents(el); g.collapse(false); }
    const ws = window.getSelection(); ws.removeAllRanges(); ws.addRange(g);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  };
  if (now) go(); else setTimeout(go, 0);
}

// Every text run of the module, so the active one can be committed before an action (and on Ctrl+S).
export function activeRun() {
  const el = document.activeElement;
  if (!el || !el.dataset || !el.dataset.run) return null;
  const [p, i] = el.dataset.run.split(':');
  return { el, path: p ? p.split('.').map(Number) : [], index: Number(i), text: el.textContent };
}

/*
  Ctrl+S from a text run: the run is left, which commits its text, and the
  caret is put back where it was on the next tick, so typing during the save
  goes on in the same place. Returns false when no run had the focus.
*/
export function commitRunKeepingCaret() {
  const run = activeRun();
  if (!run) return false;
  const [a, b] = runOffsets(run.el);
  run.el.blur();
  focusRun(document, run.path, run.index, a, b);
  return true;
}

/*
  Where a block element called `name` can go near the selection: after the
  selected element or one of its ancestors (nearest first), or inside the
  selected element at its end. Returns { parentPath, index } or null.
*/
export function placementFor(doc, model, path, name) {
  if (!path) return null;
  const el = elementAt(doc, path);
  if (el && model.insertableAt(el.nodeName, childNames(el), childNames(el).length).includes(name) && !model.holdsText(el.nodeName)) {
    return { parentPath: path, index: childNames(el).length };
  }
  for (let p = path; p.length; p = p.slice(0, -1)) {
    const parentPath = p.slice(0, -1);
    const parent = elementAt(doc, parentPath);
    const index = p[p.length - 1] + 1;
    if (model.insertableAt(parent.nodeName, childNames(parent), index).includes(name)) return { parentPath, index };
  }
  return null;
}

/*
  graphicUrl(icn): where a figure's artwork is fetched. By default the
  project's graphics route; the review screen passes the frozen snapshot's.
*/
/*
  app: what the editor around the page offers its menus (all optional):
  { undo, redo, canUndo, canRedo, validate, preview, view, setView, title }.
*/
export default function PageView({ xml, onChange, readOnly, model, selected, onSelect, projectId, findings = [], modules = [], graphicUrl = null, app = {} }) {
  const imageUrl = graphicUrl || ((icn) => `/api/projects/${encodeURIComponent(projectId)}/graphics/${encodeURIComponent(icn)}/file`);
  const parsed = useMemo(() => parseXml(xml), [xml]);
  const problems = useMemo(() => (parsed.error ? [] : contentProblems(parsed.doc, model)), [parsed, model]);
  const problemAt = useMemo(() => new Map(problems.map((p) => [key(p.path), p])), [problems]);
  const findingAt = useMemo(() => { const m = new Map(); for (const f of findings) if (f.path) m.set(key(f.path), [...(m.get(key(f.path)) || []), f]); return m; }, [findings]);
  const targets = useMemo(() => (parsed.error ? [] : referenceTargets(parsed.doc)), [parsed]);
  const numberOf = useMemo(() => new Map(targets.map((t) => [key(t.path), t])), [targets]);
  const codes = useMemo(() => new Set(modules.map((m) => m.dmc)), [modules]);
  const checks = useMemo(() => {
    if (parsed.error) return [];
    const own = dmcOf(parsed.doc.getElementsByTagName('identAndStatusSection')[0]);
    return [...liveChecks(parsed), ...unresolvedDmRefs(parsed.doc, codes, own)];
  }, [parsed, codes]);
  const checkAt = useMemo(() => { const m = new Map(); for (const c of checks) m.set(key(c.path), [...(m.get(key(c.path)) || []), c]); return m; }, [checks]);
  const [dialog, setDialog] = useState(null);
  const [menu, setMenu] = useState(null);

  const [notice, setNotice] = useState(null);
  // A range of table cells: the selected cell, and the cell Shift+clicked.
  const [rangeSel, setRangeSel] = useState(null);
  // Cleared when another element is selected (not when the caret merely moves, as on Shift's key-up).
  const selectedKey = selected && selected.path ? key(selected.path) : '';
  useEffect(() => { setNotice(null); }, [selectedKey]);
  // The cell range lives while the same cell stays selected: the cell itself or the paragraph in it
  // (releasing Shift reports the caret in the cell's paragraph after a click on the cell's padding).
  const selectedCell = useMemo(() => {
    if (!selected || !selected.path || parsed.error) return '';
    const p = nearest(parsed.doc, selected.path, 'entry');
    return p ? key(p) : selectedKey;
  }, [selected, parsed, selectedKey]);
  useEffect(() => { setRangeSel(null); }, [selectedCell]);
  const host = useRef(null);
  const xmlRef = useRef(xml);
  const globalKeys = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (globalKeys.current) globalKeys.current(e); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  xmlRef.current = xml;

  /*
    A newly selected element with `focus` gets the caret: true or 'end' at
    the end of its first text run (its last, for 'end'), 'start' at the start
    of the first, { nodeIndex, offset } at that place (after a join).
  */
  useEffect(() => {
    if (!selected || !selected.focus || !host.current) return;
    const f = selected.focus;
    const within = `[data-path="${key(selected.path)}"]`;
    let run;
    if (typeof f === 'object') run = host.current.querySelector(`[data-run="${key(selected.path)}:${f.nodeIndex}"]`);
    if (!run && f === 'end') { const all = host.current.querySelectorAll(`${within} [data-run]`); run = all[all.length - 1]; }
    if (!run) run = host.current.querySelector(`${within} [data-run]`);
    if (!run) return;
    run.focus();
    const r = document.createRange();
    if (typeof f === 'object' && run.firstChild) { r.setStart(run.firstChild, Math.min(f.offset, run.firstChild.length)); r.collapse(true); } else { r.selectNodeContents(run); r.collapse(f === 'start'); }
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }, [selected]);
  // Navigation (the outline, a reference, a finding) scrolls the element into view.
  useEffect(() => {
    if (!selected || !selected.scroll || !host.current) return;
    const el = host.current.querySelector(`[data-path="${key(selected.path)}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selected]);

  /*
    Apply an action to the latest text: the focused run's uncommitted text is
    taken in first (and the run released), then `fn(parsed)` edits, and the
    result is one change (one undo step).
  */
  const act = useCallback((label, fn) => {
    if (readOnly) return;
    const p = parseXml(xmlRef.current);
    const run = activeRun();
    let typed = false;
    const caretWas = run ? runOffsets(run.el) : null;
    if (run) {
      const el = elementAt(p.doc, run.path);
      const node = el && el.childNodes[run.index];
      if (node && node.nodeType === 3 && displayText(node.data) !== run.text) { setText(p, run.path, run.index, run.text); typed = true; }
      else if (!node && run.text) { setText(p, run.path, run.index, run.text); typed = true; }
      run.el.dataset.skip = '1';
      run.el.blur();
    }
    const next = fn(p);
    // `false`: the action could not be done here; what was typed is still kept.
    if (next === false) {
      if (typed) onChange(serializeXml(p), { label: 'Edit text' });
      // Refused: the caret goes back where it was, so the author can keep typing.
      if (run) focusRun(host.current, run.path, run.index, caretWas[0], caretWas[1]);
      return false;
    }
    const out = serializeXml(p);
    // Nothing changed (the caret only moved): no undo step.
    if (out !== xmlRef.current) onChange(out, { label });
    // An action taken while typing leaves the caret in the page (in what it selects), so the keyboard keeps working.
    if (next) onSelect(run && next.focus === undefined ? { ...next, focus: true } : next);
    return true;
  }, [readOnly, onChange, onSelect]);
  /*
    A change made in the background (not by the author's last key): the text
    box being typed in is neither committed nor released, so typing goes on.
    It must not move text nodes the author may be typing in.
  */
  const patch = (label, fn) => {
    const p = parseXml(xmlRef.current);
    if (fn(p) === false) return;
    const out = serializeXml(p);
    if (out !== xmlRef.current) onChange(out, { label });
  };

  // An action that may not apply here: fn returns a path to select, or null with nothing changed.
  const tryAct = (label, fn, why) => {
    let failed = false;
    act(label, (p) => { const r = fn(p); if (r === null || r === undefined) { failed = true; return false; } return Array.isArray(r) ? { path: r, caret: null, focus: true, scroll: true } : r; });
    setNotice(failed ? (why || `${label}: not possible here.`) : null);
  };

  if (parsed.error) {
    return (
      <Alert title="The XML cannot be shown as a page" className="m-4">
        Line {parsed.error.line}: {parsed.error.message} Correct it in the XML view; the page comes back as soon as the XML is well formed.
      </Alert>
    );
  }

  const commitText = (path, index, value) => act('Edit text', (p) => { setText(p, path, index, value); return null; });
  const select = (path, extra = {}) => onSelect({ path, caret: null, ...extra });

  /*
    Enter splits the block at the caret (what follows moves to the new block,
    inline markup included): in a bullet, into the next bullet (an empty last
    bullet ends the list); in a title, into the first paragraph after it; in
    a paragraph, into one more of the same kind when the model allows it.
  */
  const enter = (path, index, text, offset = text.length) => act('New paragraph', (p) => {
    setText(p, path, index, text);
    const el = elementAt(p.doc, path);
    const startOf = (at) => (at ? { path: at, caret: null, focus: 'start' } : null);
    if (el.parentNode && el.parentNode.nodeName === 'listItem' && path.length >= 2) {
      const out = exitList(p, model, path, outdentItem);
      if (out) return { path: out, caret: null, focus: true };
      const itemPath = path.slice(0, -1);
      return startOf(splitBlock(p, model, path, index, offset, { name: el.nodeName, wrap: 'listItem', slot: { parentPath: itemPath.slice(0, -1), index: itemPath[itemPath.length - 1] + 1 } }));
    }
    if (el.nodeName === 'title' && path.length) {
      const atEnd = offset >= text.length && !Array.from(el.childNodes).slice(index + 1).some((n) => n.nodeType !== 3 || !isWs(n.data));
      let next = el.nextSibling;
      while (next && next.nodeType === 3 && isWs(next.data)) next = next.nextSibling;
      if (atEnd && next && next.nodeType === 1 && PARA_LIKE.has(next.nodeName) && isWs(next.textContent) && !elementChildren(next).length) {
        return { path: [...path.slice(0, -1), path[path.length - 1] + 1], caret: null, focus: 'start' };
      }
      const slot = blockSlot(p.doc, model, path, 'after');
      if (slot && PARA_LIKE.has(slot.name)) return startOf(splitBlock(p, model, path, index, offset, { name: slot.name, slot }));
      const at = blockAround(p, model, path, 'after');
      return at ? { path: at, caret: null, focus: true } : null;
    }
    if (!PARA_LIKE.has(el.nodeName) || !path.length) return null;
    return startOf(splitBlock(p, model, path, index, offset));
  });

  // Delete at the very end of a block: the next block of the same kind joins this one (Backspace at its start, seen from here).
  const deleteEnd = (path, index, text) => {
    if (readOnly || !path.length) return false;
    const el = elementAt(parsed.doc, path);
    if (!el || Array.from(el.childNodes).slice(index + 1).some((n) => n.nodeType !== 3 || !isWs(n.data))) return false;
    const next = [...path.slice(0, -1), path[path.length - 1] + 1];
    const nextEl = elementAt(parsed.doc, next);
    if (!nextEl || nextEl.nodeName !== el.nodeName) return false;
    const a = backspaceAction(parsed.doc, model, next, PARA_LIKE);
    if (!a || a.kind === 'removeItem') return false;
    act('Join paragraphs', (p) => {
      setText(p, path, index, text);
      const r = backspaceAtStart(p, model, next, PARA_LIKE);
      return r ? { path: r.path, caret: null, focus: r.focus } : false;
    });
    return true;
  };

  // Backspace at the start of a block: an empty one goes, otherwise it joins the one before (when the model allows).
  const backspaceStart = (path, index) => {
    if (readOnly) return false;
    const el = elementAt(parsed.doc, path);
    if (!el || Array.from(el.childNodes).slice(0, index).some((n) => n.nodeType !== 3 || !isWs(n.data))) return false;
    if (!backspaceAction(parsed.doc, model, path, PARA_LIKE)) return false;
    act('Join paragraphs', (p) => {
      const r = backspaceAtStart(p, model, path, PARA_LIKE);
      return r ? { path: r.path, caret: null, focus: r.focus } : false;
    });
    return true;
  };

  // ---- rendering ----------------------------------------------------------------------

  const wrapMark = (path, node) => {
    const prob = problemAt.get(key(path));
    const finds = findingAt.get(key(path));
    if (!prob && !finds) {
      const live = checkAt.get(key(path));
      if (!live) return node;
      return (
        <div className="relative rounded-sm outline outline-1 outline-dashed outline-offset-2 outline-warn" title={live.map((c) => c.message).join('\n')} data-check={key(path)}>
          {node}
          <p className="mt-0.5 text-[11.5px] text-warn flex items-start gap-1" data-testid="live-check"><Icon name="alert" size={12} className="mt-0.5 shrink-0" />{live[0].message}</p>
        </div>
      );
    }
    const msg = [prob && prob.message, ...(finds || []).map((f) => `${f.kind === 'brex' ? 'BREX' : 'XSD'}: ${f.message}`)].filter(Boolean).join('\n');
    return (
      <div className={`relative rounded-sm outline outline-1 outline-offset-2 ${prob || (finds || []).some((f) => f.kind !== 'brex') ? 'outline-danger' : 'outline-warn'}`} title={msg} data-problem={key(path)}>
        {node}
        <p className="mt-0.5 text-[11.5px] text-danger flex items-start gap-1"><Icon name="alert" size={12} className="mt-0.5 shrink-0" />{msg.split('\n')[0]}</p>
      </div>
    );
  };

  function inline(el, path, i) {
    const name = el.nodeName;
    const sel = same(selected && selected.path, path);
    const ring = sel ? 'ring-1 ring-accent rounded-sm' : '';
    // A symbol is a small picture in the text (S1000D <symbol infoEntityIdent>), drawn as its artwork.
    if (name === 'symbol') {
      const icn = el.getAttribute('infoEntityIdent') || '';
      const live = checkAt.get(key(path));
      return (
        <span key={i} contentEditable={false} data-path={key(path)} data-check={live ? key(path) : undefined} title={live ? live.map((c) => c.message).join('\n') : `<symbol> ${icn}`}
          className={`mx-0.5 inline-block rounded align-middle ${sel ? 'ring-2 ring-accent' : ''} ${live ? 'outline outline-1 outline-dashed outline-warn' : ''}`}
          onClick={(e) => { e.stopPropagation(); select(path); }}>
          {/^[A-Za-z0-9-]+$/.test(icn) && imageUrl(icn) ? <Artwork key={imageUrl(icn)} src={imageUrl(icn)} icn={icn} inline /> : <span className="text-[11px] text-danger">symbol without ICN</span>}
        </span>
      );
    }
    if (INLINE_REFS.has(name)) {
      let label;
      if (name === 'internalRef') label = labelFor(targets, el.getAttribute('internalRefId')) || el.getAttribute('internalRefId') || 'reference';
      else if (name === 'dmRef') label = `DMC-${dmcOf(el)}`;
      else if (name === 'externalPubRef') label = textOf(el, 'externalPubTitle') || textOf(el, 'externalPubCode') || 'external publication';
      else label = refTarget(el) || name;
      const broken = name === 'internalRef' && !labelFor(targets, el.getAttribute('internalRefId'));
      const live = checkAt.get(key(path));
      const warn = !broken && live;
      return (
        <button key={i} type="button" contentEditable={false} data-path={key(path)} data-testid="ref-pill" data-check={live ? key(path) : undefined}
          aria-label={live ? `${label}: ${live[0].message}` : undefined}
          className={`mx-0.5 inline-flex items-center gap-1 rounded-full border px-2 py-px text-[12px] align-baseline ${broken ? 'border-danger text-danger' : warn ? 'border-warn border-dashed text-warn' : 'border-accent/40 bg-accent-soft/40 text-accent'} ${sel ? 'ring-2 ring-accent' : ''}`}
          title={broken ? `Nothing in this module has the id ${el.getAttribute('internalRefId')}` : live ? live.map((c) => c.message).join('\n') : `<${name}>`}
          onClick={(e) => {
            e.stopPropagation();
            const t = name === 'internalRef' && targets.find((x) => x.id === el.getAttribute('internalRefId'));
            if (t && e.detail === 2) select(t.path, { scroll: true }); else select(path);
          }}>
          <Icon name={name === 'internalRef' ? 'link' : 'file'} size={11} />{label}
        </button>
      );
    }
    if (model.holdsText(name) || ['emphasis', 'verbatimText', 'subScript', 'superScript'].includes(name)) {
      const look = name === 'emphasis' ? EMPHASIS[el.getAttribute('emphasisType') || 'em01'] || 'font-semibold'
        : name === 'verbatimText' ? 'font-mono text-[12.5px] bg-surface-3/60 rounded px-0.5'
          : name === 'subScript' ? 'align-sub text-[11px]' : name === 'superScript' ? 'align-super text-[11px]' : 'underline decoration-dotted decoration-ink-3';
      return <span key={i} data-path={key(path)} className={`${look} ${ring}`} title={`<${name}>`} onClick={(e) => { e.stopPropagation(); select(path, { caret: (selected && same(selected.path, path)) ? selected.caret : null }); }}>{mixed(el, path)}</span>;
    }
    if (['sequentialList', 'randomList', 'definitionList', 'attentionSequentialList', 'attentionRandomList'].includes(name)) return <div key={i} className="my-1">{block(el, path)}</div>;
    return <span key={i} data-path={key(path)} className={`rounded bg-surface-3 px-1 font-mono text-[11px] text-ink-3 ${ring}`} title="Shown as a tag in the page view; edit it in the Tags or XML view" onClick={(e) => { e.stopPropagation(); select(path); }}>&lt;{name}&gt;</span>;
  }

  // Text and inline elements of an element that holds text.
  function mixed(el, path) {
    const nodes = Array.from(el.childNodes);
    const items = [];
    nodes.forEach((n, i) => {
      if (n.nodeType === 3) {
        if (isWs(n.data) && nodes.length > 1) { items.push(<span key={i}> </span>); return; }
        items.push(<TextRun key={i} value={displayText(n.data)} readOnly={readOnly} path={path} index={i}
          onCommit={(v) => commitText(path, i, v)} onCaret={(c) => onSelect({ path, caret: c })}
          onEnter={(v, off) => enter(path, i, v, off)} onBackspaceStart={() => backspaceStart(path, i)} onDeleteEnd={(t) => deleteEnd(path, i, t)} onSlash={() => setDialog({ kind: 'insert', path, caret: { nodeIndex: i, offset: 0, end: 0 } })} />);
      } else if (n.nodeType === 1) {
        items.push(inline(n, [...path, elementChildren(el).indexOf(n)], i));
      } else {
        items.push(<Locked key={i} node={n} />);
      }
    });
    // After an inline element (a reference, a format) that ends the text, a place to keep typing.
    let lastReal = nodes.length - 1;
    while (lastReal >= 0 && nodes[lastReal].nodeType === 3 && isWs(nodes[lastReal].data)) lastReal--;
    if (lastReal >= 0 && nodes[lastReal].nodeType === 1 && !readOnly) {
      const at = lastReal + 1;
      items.push(<TextRun key="tail" tail value="" readOnly={readOnly} path={path} index={at}
        onCommit={(v) => commitText(path, at, v)} onCaret={(c) => onSelect({ path, caret: c })}
        onEnter={(v, off) => enter(path, at, v, off)} onBackspaceStart={() => false} onDeleteEnd={() => false} onSlash={() => setDialog({ kind: 'insert', path, caret: { nodeIndex: at, offset: 0, end: 0 } })} />);
    }
    if (!nodes.some((n) => (n.nodeType === 3 && !isWs(n.data)) || n.nodeType === 1)) {
      items.push(<TextRun key="new" value="" readOnly={readOnly} path={path} index={nodes.length} placeholder={readOnly ? '' : 'Type here, or / to insert'}
        onCommit={(v) => commitText(path, nodes.length, v)} onCaret={(c) => onSelect({ path, caret: c })}
        onEnter={(v, off) => enter(path, nodes.length, v, off)} onBackspaceStart={() => backspaceStart(path, nodes.length)} onDeleteEnd={(t) => deleteEnd(path, nodes.length, t)} onSlash={() => setDialog({ kind: 'insert', path, caret: { nodeIndex: nodes.length, offset: 0, end: 0 } })} />);
    }
    return items;
  }

  const kidsOf = (el, path, skip = []) => elementChildren(el).map((c, i) => (skip.includes(c.nodeName) ? null : block(c, [...path, i]))).filter(Boolean);

  // Comments, processing instructions and CDATA: shown, never edited here, always kept.
  function Locked({ node }) {
    const label = node.nodeType === 8 ? 'comment' : node.nodeType === 7 ? `<?${node.target}?>` : node.nodeType === 4 ? 'CDATA' : 'markup';
    return <span contentEditable={false} className="mx-0.5 rounded border border-dashed border-line-strong px-1 font-mono text-[10.5px] text-ink-3" title={`${label} (kept exactly; edit it in the XML view): ${String(node.data || '').slice(0, 200)}`}>{label}</span>;
  }

  function title(el, path, prefix, cls) {
    const kids = elementChildren(el);
    const t = kids.findIndex((c) => c.nodeName === 'title');
    if (t === -1) return prefix ? <div className={cls}>{prefix}</div> : null;
    const tp = [...path, t];
    return wrapMark(tp, <div className={cls} data-path={key(tp)} onClick={(e) => { e.stopPropagation(); select(tp); }}>{prefix ? <span className="mr-2 tabular">{prefix}</span> : null}{mixed(kids[t], tp)}</div>);
  }

  function table(el, path) {
    const t = numberOf.get(key(path));
    const groups = elementChildren(el).map((c, i) => [c, [...path, i]]).filter(([c]) => c.nodeName === 'tgroup');
    return (
      <figure className="my-3">
        {title(el, path, t ? t.label : 'Table', 'mb-1 text-center text-[13px] font-semibold text-ink')}
        {groups.map(([tg, tgp]) => {
          const colspecs = elementChildren(tg).filter((c) => c.nodeName === 'colspec');
          const colIndex = new Map(colspecs.map((c, i) => [c.getAttribute('colname'), i]));
          const rowsOf = (sectionName) => elementChildren(tg).map((c, i) => [c, [...tgp, i]]).filter(([c]) => c.nodeName === sectionName)
            .flatMap(([sec, sp]) => elementChildren(sec).map((r, i) => [r, [...sp, i]]));
          const cells = (row, rp, head) => elementChildren(row).map((e, i) => {
            const ep = [...rp, i];
            const st = colIndex.get(e.getAttribute('namest'));
            const en = colIndex.get(e.getAttribute('nameend'));
            const span = st !== undefined && en !== undefined ? en - st + 1 : 1;
            const rows = Number(e.getAttribute('morerows') || 0) + 1;
            const Tag = head ? 'th' : 'td';
            const sel = same(selected && selected.path, ep);
            const ranged = rangeCells.has(e);
            const ha = e.getAttribute('align');
            const va = e.getAttribute('valign');
            return (
              <Tag key={i} colSpan={span > 1 ? span : undefined} rowSpan={rows > 1 ? rows : undefined} data-path={key(ep)} data-in-range={ranged ? 'true' : undefined}
                style={{ textAlign: ['left', 'center', 'right', 'justify'].includes(ha) ? ha : undefined, verticalAlign: ['top', 'middle', 'bottom'].includes(va) ? va : undefined }}
                className={`border border-line-strong px-2 py-1 ${va ? '' : 'align-top'} ${ha ? '' : 'text-left'} ${head ? 'bg-surface-3 font-semibold' : ''} ${sel ? 'outline outline-2 outline-accent' : ''} ${ranged ? 'bg-accent-soft/60' : ''}`}
                // Shift+click: the cells from the selected one to this one become a range to merge.
                onMouseDownCapture={(ev) => {
                  if (!ev.shiftKey || readOnly) return;
                  const anchor = selected && nearest(parsed.doc, selected.path, 'entry');
                  if (!anchor) return;
                  ev.preventDefault(); ev.stopPropagation();
                  setRangeSel({ a: anchor, b: ep });
                }}
                onClickCapture={(ev) => { if (ev.shiftKey && !readOnly) ev.stopPropagation(); }}
                onClick={(ev) => { ev.stopPropagation(); select(ep); }}>
                {kidsOf(e, ep)}
                {!elementChildren(e).length ? mixed(e, ep) : null}
              </Tag>
            );
          });
          return (
            <table key={key(tgp)} className="w-full border-collapse text-[13px]" data-path={key(tgp)}>
              {colspecs.length ? <colgroup>{colspecs.map((c, i) => <col key={i} style={colStyle(c.getAttribute('colwidth'), colspecs)} />)}</colgroup> : null}
              <thead>{rowsOf('thead').map(([r, rp]) => <tr key={key(rp)} data-path={key(rp)}>{cells(r, rp, true)}</tr>)}</thead>
              <tbody>{rowsOf('tbody').map(([r, rp]) => <tr key={key(rp)} data-path={key(rp)}>{cells(r, rp, false)}</tr>)}</tbody>
            </table>
          );
        })}
      </figure>
    );
  }

  /*
    Preliminary and close-up requirements drawn as the PDF build draws them
    (vendor/pipeline/s1000dtofo/requirements.xsl): a heading, generated
    column headers and "None" for the no-... markers. The headers and "None"
    are not in the XML and cannot be typed into; the cells are the module's
    own elements, edited in place. Anything else in a group is shown below
    the table, never hidden.
  */
  function requirements(el, path) {
    const spec = REQ[name0(el)];
    const kids = elementChildren(el).map((c, i) => [c, [...path, i]]);
    const none = kids.find(([c]) => c.nodeName === spec.none);
    const cellOf = (row, rp, names) => {
      for (const n of names) {
        const i = elementChildren(row).findIndex((c) => c.nodeName === n);
        if (i !== -1) return block(elementChildren(row)[i], [...rp, i]);
      }
      return null;
    };
    const attr = (row, child, a) => { const c = elementChildren(row).find((x) => x.nodeName === child); return c ? c.getAttribute(a) || '' : ''; };
    const refs = (row, rp) => elementChildren(row).map((c, i) => [c, [...rp, i]]).filter(([c]) => INLINE_REFS.has(c.nodeName)).map(([c, cp], i) => inline(c, cp, i));
    const used = new Set();
    let rows = [];
    if (spec.kind === 'cond') {
      rows = kids.filter(([c]) => /^reqCond(?!Group)/.test(c.nodeName) || c.nodeName === 'reqTechInfo').map(([c, cp]) => { used.add(c); return [cp, [cellOf(c, cp, ['reqCond']) || (c.nodeName === 'reqTechInfo' ? <span className="text-ink-2">{c.getAttribute('reqTechInfoCategory') || ''}</span> : null), refs(c, cp)]]; });
    } else if (spec.kind === 'persons') {
      rows = kids.filter(([c]) => c.nodeName === 'person' || c.nodeName === 'personnel').map(([c, cp]) => {
        used.add(c);
        if (c.nodeName === 'personnel') return [cp, [<span key="p" className="text-ink-2">As required</span>, '', '', cellOf(c, cp, ['trade']), cellOf(c, cp, ['estimatedTime'])]];
        return [cp, [<span key="m" className="font-mono">{c.getAttribute('man') || ''}</span>, attr(c, 'personCategory', 'personCategoryCode'), attr(c, 'personSkill', 'skillLevelCode'), cellOf(c, cp, ['trade']), cellOf(c, cp, ['estimatedTime'])]];
      });
    } else if (spec.kind === 'items') {
      for (const [g, gp] of kids.filter(([c]) => c.nodeName === spec.group)) {
        used.add(g);
        elementChildren(g).forEach((d, i) => {
          if (d.nodeName !== spec.item) return;
          const dp = [...gp, i];
          const ident = elementChildren(d).find((x) => x.nodeName === 'identNumber');
          const idText = ident ? ident.textContent.replace(/\s+/g, ' ').trim() : '';
          rows.push([dp, [cellOf(d, dp, ['name', 'shortName']), <span key="i" className="font-mono text-[12px]">{idText}</span>, cellOf(d, dp, ['reqQuantity']), cellOf(d, dp, ['remarks'])]]);
        });
      }
    }
    if (none) used.add(none[0]);
    const rest = kids.filter(([c]) => !used.has(c));
    return (
      <div className="my-3" data-testid={`req-${name0(el)}`}>
        <h4 className="mb-1 text-[14px] font-semibold text-ink">{spec.title}</h4>
        {spec.cols ? (
          <table className="w-full border-collapse text-[12.5px]">
            <thead><tr>{spec.cols.map((c) => <th key={c} className="border border-line-strong bg-surface-3 px-2 py-1 text-left font-semibold">{c}</th>)}</tr></thead>
            <tbody>
              {none || !rows.length ? (
                <tr><td colSpan={spec.cols.length} className="border border-line-strong px-2 py-1 text-ink-2" data-path={none ? key(none[1]) : undefined}
                  onClick={(e) => { e.stopPropagation(); if (none) select(none[1]); }}>None</td></tr>
              ) : rows.map(([rp, cells]) => (
                <tr key={key(rp)} data-path={key(rp)} className={same(selected && selected.path, rp) ? 'bg-accent-soft/30' : ''} onClick={(e) => { e.stopPropagation(); select(rp); }}>
                  {cells.map((c, i) => <td key={i} className="border border-line-strong px-2 py-1 align-top">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : none ? <p className="text-ink-2" data-path={key(none[1])}>None</p> : null}
        {rest.map(([c, cp]) => block(c, cp))}
      </div>
    );
  }

  function figure(el, path) {
    const t = numberOf.get(key(path));
    return (
      <figure className="my-3 text-center">
        {elementChildren(el).map((g, i) => [g, [...path, i]]).filter(([g]) => g.nodeName === 'graphic').map(([g, gp]) => {
          const icn = g.getAttribute('infoEntityIdent') || '';
          return (
            <div key={key(gp)} data-path={key(gp)} className={`inline-block rounded border p-1 ${same(selected && selected.path, gp) ? 'border-accent' : 'border-transparent'}`} onClick={(e) => { e.stopPropagation(); select(gp); }}>
              {/^[A-Za-z0-9-]+$/.test(icn) && imageUrl(icn)
                ? <Artwork key={imageUrl(icn)} src={imageUrl(icn)} icn={icn} />
                : <span className="block px-6 py-8 text-[12px] text-danger border border-dashed border-danger rounded">No ICN on this graphic</span>}
              <span className="block font-mono text-[10.5px] text-ink-3">{icn}</span>
              {(checkAt.get(key(gp)) || []).map((c, ci) => <span key={ci} className="block text-[11.5px] text-warn" data-testid="live-check" data-check={key(gp)}>{c.message}</span>)}
            </div>
          );
        })}
        {title(el, path, t ? t.label : 'Fig', 'mt-1 text-[13px] font-semibold text-ink')}
        {kidsOf(el, path, ['title', 'graphic'])}
      </figure>
    );
  }

  function block(el, path) {
    const name = el.nodeName;
    const k = key(path);
    const sel = same(selected && selected.path, path);
    const pick = (e) => { e.stopPropagation(); select(path); };
    let node;
    if (name === 'identAndStatusSection') {
      node = (
        <header className="mb-4 rounded-md border border-line bg-surface-2 px-4 py-3 text-[12.5px]" data-testid="page-ident">
          <p className="font-mono text-ink-2">DMC-{dmcOf(el)}</p>
          <p className="text-[17px] font-semibold text-ink">{textOf(el, 'techName')}{textOf(el, 'infoName') ? <span className="font-normal text-ink-2"> – {textOf(el, 'infoName')}</span> : null}</p>
          <p className="text-ink-3">
            Issue {textAttr(el, 'issueInfo', 'issueNumber')}-{textAttr(el, 'issueInfo', 'inWork')} · {textAttr(el, 'issueDate', 'year')}-{textAttr(el, 'issueDate', 'month')}-{textAttr(el, 'issueDate', 'day')} · security {textAttr(el, 'security', 'securityClassification')}
          </p>
          {!readOnly ? <Button size="sm" variant="ghost" icon="edit" className="mt-1" data-testid="edit-ident" onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); setDialog({ kind: 'ident' }); }}>Edit identification</Button> : null}
        </header>
      );
    } else if (PARA_LIKE.has(name) || (model.holdsText(name) && name !== 'title')) {
      // A <div>: a paragraph may hold lists, which are blocks.
      node = (
        <div className={`my-1.5 leading-6 text-ink ${sel ? 'bg-accent-soft/30 rounded-sm' : ''}`}
          onClick={(e) => {
            // A click beside the text (not on it) puts the caret at the end of the paragraph, as in any editor.
            const runs = e.target === e.currentTarget && !readOnly ? e.currentTarget.querySelectorAll(':scope > [data-run]') : [];
            if (runs.length) { e.stopPropagation(); const r = runs[runs.length - 1]; r.focus(); const g = document.createRange(); g.selectNodeContents(r); g.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(g); r.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return; }
            pick(e);
          }}>{mixed(el, path)}</div>
      );
    } else if (name === 'title') {
      node = <div className="my-1 font-semibold text-ink" onClick={pick}>{mixed(el, path)}</div>;
    } else if (name === 'levelledPara') {
      const t = numberOf.get(k);
      const depth = t ? t.label.split(' ')[1].split('.').length : 1;
      node = (
        <section className="mt-3" onClick={pick}>
          {title(el, path, t ? t.label.replace('Para ', '') : '', `${depth === 1 ? 'text-[16px]' : depth === 2 ? 'text-[14.5px]' : 'text-[13.5px]'} font-semibold text-ink mb-1`)}
          {kidsOf(el, path, ['title'])}
        </section>
      );
    } else if (name === 'proceduralStep') {
      const t = numberOf.get(k);
      node = (
        <div className="my-2 grid grid-cols-[auto_1fr] gap-x-2" onClick={pick}>
          <span className="font-semibold tabular text-ink">{t ? t.label.replace('Step ', '') : ''}</span>
          <div>{title(el, path, '', 'font-semibold text-ink')}{kidsOf(el, path, ['title'])}</div>
        </div>
      );
    } else if (BOX[name]) {
      node = (
        <aside className={`my-2 rounded border-l-4 px-3 py-2 ${BOX[name][1]}`} onClick={pick}>
          <p className="text-center text-[12px] font-bold tracking-wide">{BOX[name][0]}</p>
          <div className="text-ink">{kidsOf(el, path)}</div>
        </aside>
      );
    } else if (name === 'sequentialList' || name === 'randomList' || name === 'attentionSequentialList' || name === 'attentionRandomList') {
      const Tag = /sequential/i.test(name) ? 'ol' : 'ul';
      node = (
        <Tag className={`my-1 pl-6 ${Tag === 'ol' ? 'list-decimal' : 'list-disc'}`} onClick={pick}>
          {elementChildren(el).map((c, i) => (c.nodeName === 'title' ? null : <li key={i} data-path={key([...path, i])} className={same(selected && selected.path, [...path, i]) ? 'bg-accent-soft/30 rounded-sm' : ''} onClick={(e) => { e.stopPropagation(); select([...path, i]); }}>{kidsOf(c, [...path, i])}</li>))}
        </Tag>
      );
    } else if (name === 'figure') {
      node = <div onClick={pick}>{figure(el, path)}</div>;
    } else if (name === 'table') {
      node = <div onClick={pick}>{table(el, path)}</div>;
    } else if (SECTION[name]) {
      node = <section className="mt-4" onClick={pick}><h3 className="mb-1 border-b border-line pb-1 text-[15px] font-semibold text-ink">{SECTION[name]}</h3>{kidsOf(el, path)}</section>;
    } else if (REQ[name]) {
      node = <div onClick={pick}>{requirements(el, path)}</div>;
    } else if (['dmodule', 'content', 'description', 'procedure', 'listItem'].includes(name)) {
      node = <div onClick={name === 'dmodule' ? undefined : pick}>{kidsOf(el, path)}</div>;
    } else {
      // Not drawn specially: a labelled box, its content still shown (and kept exactly).
      node = (
        <div className="my-1 rounded border border-dashed border-line px-2 py-1" onClick={pick}>
          <span className="font-mono text-[10.5px] text-ink-3">&lt;{name}&gt;</span>
          {model.holdsText(name) ? <div>{mixed(el, path)}</div> : <div>{kidsOf(el, path)}</div>}
          {Array.from(el.childNodes).filter((n) => n.nodeType === 4 || n.nodeType === 7 || n.nodeType === 8).map((n, i) => <Locked key={i} node={n} />)}
        </div>
      );
    }
    return (
      <div key={k || 'root'} data-path={k} data-element={name} className={`relative ${sel && !PARA_LIKE.has(name) ? 'outline outline-2 outline-offset-2 outline-accent rounded-sm' : ''}`}>
        {wrapMark(path, node)}
      </div>
    );
  }

  // ---- toolbar, menus and shortcuts ------------------------------------------------------

  const doc = parsed.doc;
  const sp = selected ? selected.path : null;
  const selEl = selected ? elementAt(doc, selected.path) : null;
  const caret = selected && selected.caret && selEl && model.holdsText(selEl.nodeName) ? selected.caret : null;
  const range = caret && caret.end > caret.offset ? caret : null;
  const inlineAllowed = (name) => !!caret && model.insertableAt(selEl.nodeName, childNames(selEl), elementIndexAt(selEl, caret.nodeIndex)).includes(name);
  const formatOk = (f) => !!range && inlineAllowed(FORMATS[f].name);
  const formatting = selEl && ['emphasis', 'verbatimText', 'subScript', 'superScript'].includes(selEl.nodeName);
  const tctx = selected ? tableContext(doc, selected.path) : null;
  const cell = tctx ? cellActions(doc, selected.path) : null;
  const notModelled = 'This table uses named spans or column names the page view cannot follow; change it in the XML view';
  const inList = selected ? (() => { for (let e = selEl; e && e.nodeType === 1; e = e.parentNode) if (e.nodeName === 'listItem') return true; return false; })() : false;
  const blockPlace = (name) => (selected ? placementFor(doc, model, selected.path, name) : null);
  const slot = (name) => !!sp && !!nearestSlot(doc, model, sp, name);
  // What Tab and Shift+Tab move: the bullet, else the step, else the section the selection is in.
  const outlineKind = sp && nearest(doc, sp, 'proceduralStep') ? 'proceduralStep' : 'levelledPara';
  const refsAllowed = { internalRef: inlineAllowed('internalRef'), dmRef: inlineAllowed('dmRef'), pmRef: inlineAllowed('pmRef'), externalPubRef: inlineAllowed('externalPubRef') };
  const anyRef = Object.values(refsAllowed).some(Boolean);
  const cellRangeInfo = rangeSel ? cellRange(doc, rangeSel.a, rangeSel.b) : null;
  const rangeCells = new Set(cellRangeInfo && !cellRangeInfo.reason ? cellRangeInfo.cells.map((c) => c.entry) : []);
  const align = cellAlignOptions(model);
  const cellEntry = tctx && tctx.entry ? tctx.entry : null;

  // The caret just after the inline element at `path` (a reference, a format): typing goes on after it.
  const after = (p, path) => {
    const el = elementAt(p.doc, path);
    const idx = Array.from(el.parentNode.childNodes).indexOf(el);
    return { path: path.slice(0, -1), caret: null, focus: { nodeIndex: idx + 1, offset: 0 } };
  };
  const applyFormat = (f) => act(`Format ${f}`, (p) => {
    const at = wrapText(p, selected.path, caret.nodeIndex, caret.offset, caret.end, FORMATS[f]);
    return at ? after(p, at) : null;
  });
  const go = (path) => onSelect({ path, caret: null, scroll: true });

  const cmd = {
    blockAfter: () => tryAct('New block', (p) => blockAround(p, model, sp, 'after'), 'No paragraph, step or section can follow here.'),
    blockBefore: () => tryAct('New block', (p) => blockAround(p, model, sp, 'before'), 'No paragraph, step or section can go before this.'),
    named: (name, label) => tryAct(`Insert ${label || name}`, (p) => insertNamed(p, model, sp, name), `A <${name}> cannot go near the selection.`),
    section: () => tryAct('New section', (p) => newSection(p, model, sp), 'A section cannot go here.'),
    subSection: () => tryAct('New sub-section', (p) => newSubSection(p, model, sp), 'Select something inside a section first.'),
    demote: () => (inList
      ? tryAct('Indent', (p) => indentItem(p, sp), 'The first bullet of a list cannot be indented.')
      : tryAct(outlineKind === 'proceduralStep' ? 'Demote step' : 'Demote section', (p) => demote(p, model, sp, outlineKind), `Only a ${outlineKind === 'proceduralStep' ? 'step' : 'section'} that follows another can be demoted.`)),
    promote: () => (inList
      ? tryAct('Outdent', (p) => outdentItem(p, sp), 'This bullet is not in a nested list.')
      : tryAct(outlineKind === 'proceduralStep' ? 'Promote step' : 'Promote section', (p) => promote(p, model, sp, outlineKind), 'Only a nested section or step can be promoted (and only when what follows it is sections or steps too).')),
    mergeRange: () => tryAct('Merge cells', (p) => mergeRange(p, rangeSel.a, rangeSel.b), cellRangeInfo && cellRangeInfo.reason),
    addRow: (where) => tryAct('Add row', (p) => (tctx.spans && cell.modelled ? addRowSpanned(p, sp, where) : addRow(p, sp, where)), 'A row cannot be added here.'),
    delRow: () => tryAct('Delete row', (p) => (tctx.spans && cell.modelled ? deleteRowSpanned(p, sp) : deleteRow(p, sp)), 'A header or body keeps at least one row; delete the table instead.'),
    addCol: (where) => tryAct('Add column', (p) => (tctx.spans ? addColumnSpanned(p, sp, where) : addColumn(p, sp, where)), 'A column cannot be added here.'),
    delCol: () => tryAct('Delete column', (p) => (tctx.spans ? deleteColumnSpanned(p, sp) : deleteColumn(p, sp)), 'Deleting this column would leave a row with no cell.'),
    cellAttr: (attr, value) => tryAct(value ? `Cell ${attr} ${value}` : `Cell ${attr} from the column`, (p) => setCellAttr(p, model, sp, attr, value)),
    reseq: (kind) => {
      let res = null;
      const ok = act(`Re-sequence ${kind} ids`, (p) => { res = resequenceIds(p, kind); return res && res.changed ? null : false; });
      setNotice(!res ? `The new ${kind} ids are already used by other elements; nothing was changed.` : ok ? `${res.changed} ${kind} id${res.changed === 1 ? '' : 's'} re-numbered; references in this module follow (other modules that point at an id with referredFragment are not changed).` : `The ${kind} ids are already in sequence.`);
    },
    assignIds: () => { let n = 0; act('Give ids', (p) => { n = assignIds(p, model); return n ? null : false; }); setNotice(n ? `${n} id${n === 1 ? '' : 's'} given.` : 'Every figure, table, section and step already has an id.'); },
    reindent: () => { let n = 0; act('Re-indent', (p) => { n = reindent(p, model); return n ? null : false; }); setNotice(n ? `Re-indented ${n} element${n === 1 ? '' : 's'}; text was not touched.` : 'The XML is already indented.'); },
    print: () => printPage(host.current, app.title),
    figure: () => (blockPlace('figure') ? setDialog({ kind: 'figure' }) : setNotice('A figure cannot go near the selection.')),
    table: () => (blockPlace('table') ? setDialog({ kind: 'table' }) : setNotice('A table cannot go near the selection.')),
    reference: () => (anyRef ? setDialog({ kind: 'reference' }) : setNotice('Put the cursor in text that can hold a reference first.')),
    insert: () => (sp ? setDialog({ kind: 'insert', path: sp, caret }) : setNotice('Select where to insert first.')),
  };

  // What may happen to the element at `path` (the context menu and the Edit menu).
  const elementActions = (path) => {
    if (!path || !path.length) return [];
    const el = elementAt(doc, path);
    if (!el) return [];
    const name = el.nodeName;
    const parent = el.parentNode;
    const i = path[path.length - 1];
    const okAfter = (names) => model.isValidSequence(parent.nodeName, names) || !model.isValidSequence(parent.nodeName, childNames(parent));
    const fixed = ['identAndStatusSection', 'content', 'dmodule'].includes(name);
    const up1 = namesAfterMove(parent, i, -1);
    const down1 = namesAfterMove(parent, i, 1);
    const kind = name === 'proceduralStep' || name === 'levelledPara' ? name : null;
    return [
      { label: `Attributes of <${name}>…`, onSelect: () => setDialog({ kind: 'attributes', path }), disabled: readOnly, testId: 'cm-attributes' },
      { label: 'Insert…', shortcut: 'Ctrl+/', onSelect: () => setDialog({ kind: 'insert', path, caret: null }), disabled: readOnly, testId: 'cm-insert' },
      { label: 'Block after this one', shortcut: 'Ctrl+Enter', onSelect: () => tryAct('New block', (p) => blockAround(p, model, path, 'after'), 'No paragraph, step or section can follow here.'), disabled: readOnly, testId: 'cm-block-after' },
      { label: 'Block before this one', shortcut: 'Ctrl+Shift+Enter', onSelect: () => tryAct('New block', (p) => blockAround(p, model, path, 'before'), 'No paragraph, step or section can go before this.'), disabled: readOnly, testId: 'cm-block-before' },
      { label: `Add another <${name}> after`, onSelect: () => tryAct(`Add ${name}`, (p) => addSibling(p, model, path)), disabled: readOnly || !canAddSibling(doc, model, path), testId: 'cm-add-sibling' },
      { label: `Duplicate <${name}>`, onSelect: () => tryAct(`Duplicate ${name}`, (p) => ({ path: duplicate(p, model, path), caret: null, scroll: true })), disabled: readOnly || fixed || !canAddSibling(doc, model, path), testId: 'cm-duplicate' },
      ...replacements(doc, model, path).map((o) => ({
        label: o.kind === 'change' ? `Change to <${o.name}>` : `Replace with <${o.name}>`,
        onSelect: () => tryAct(`${o.kind === 'change' ? 'Change' : 'Replace'} ${name}`, (p) => replaceElement(p, model, path, o.name)),
        disabled: readOnly, testId: `cm-${o.kind}-${o.name}`,
      })),
      { divider: true },
      { label: 'Move up', onSelect: () => tryAct(`Move ${name}`, (p) => ({ path: moveElement(p, path, -1), caret: null })), disabled: readOnly || fixed || !up1 || !okAfter(up1), testId: 'cm-move-up' },
      { label: 'Move down', onSelect: () => tryAct(`Move ${name}`, (p) => ({ path: moveElement(p, path, 1), caret: null })), disabled: readOnly || fixed || !down1 || !okAfter(down1), testId: 'cm-move-down' },
      { label: 'Move into previous sibling', onSelect: () => tryAct(`Move ${name}`, (p) => moveIntoPrevious(p, model, path)), disabled: readOnly || !canMoveIntoPrevious(doc, model, path), testId: 'cm-move-into' },
      ...(kind ? [
        { label: `Demote ${kind === 'levelledPara' ? 'section' : 'step'}`, shortcut: 'Tab', onSelect: () => tryAct('Demote', (p) => demote(p, model, path, kind)), disabled: readOnly || !canDemote(doc, model, path, kind), testId: 'cm-demote' },
        { label: `Promote ${kind === 'levelledPara' ? 'section' : 'step'}`, shortcut: 'Shift+Tab', onSelect: () => tryAct('Promote', (p) => promote(p, model, path, kind)), disabled: readOnly || !canPromote(doc, model, path, kind), testId: 'cm-promote' },
      ] : []),
      { divider: true },
      { label: `Delete <${name}>`, onSelect: () => tryAct(`Delete ${name}`, (p) => { removeElement(p, path); return { path: path.slice(0, -1), caret: null }; }), disabled: readOnly || fixed || !okAfter(namesAfterRemove(parent, i)), testId: 'cm-delete' },
    ];
  };

  const insertMenu = [
    { label: 'Paragraph', shortcut: 'Ctrl+Alt+P', onSelect: () => cmd.named('para', 'paragraph'), disabled: !slot('para'), testId: 'mi-para' },
    { label: 'Section', shortcut: 'Ctrl+Alt+1', onSelect: cmd.section, disabled: !slot('levelledPara'), testId: 'mi-section' },
    { label: 'Sub-section', shortcut: 'Ctrl+Alt+2', onSelect: cmd.subSection, disabled: !(sp && nearest(doc, sp, 'levelledPara')), testId: 'mi-subsection' },
    { label: 'Procedural step', shortcut: 'Ctrl+Alt+S', onSelect: () => cmd.named('proceduralStep', 'step'), disabled: !slot('proceduralStep'), testId: 'mi-step' },
    { label: 'Warning', shortcut: 'Ctrl+Alt+W', onSelect: () => cmd.named('warning'), disabled: !slot('warning'), testId: 'mi-warning' },
    { label: 'Caution', shortcut: 'Ctrl+Alt+C', onSelect: () => cmd.named('caution'), disabled: !slot('caution'), testId: 'mi-caution' },
    { label: 'Note', shortcut: 'Ctrl+Alt+N', onSelect: () => cmd.named('note'), disabled: !slot('note'), testId: 'mi-note' },
    { divider: true },
    { label: 'Block after this one', shortcut: 'Ctrl+Enter', onSelect: cmd.blockAfter, disabled: !sp, testId: 'mi-block-after' },
    { label: 'Block before this one', shortcut: 'Ctrl+Shift+Enter', onSelect: cmd.blockBefore, disabled: !sp, testId: 'mi-block-before' },
    { divider: true },
    { label: 'Figure…', shortcut: 'Ctrl+Alt+G', onSelect: cmd.figure, disabled: !blockPlace('figure'), testId: 'mi-figure' },
    { label: 'Table…', shortcut: 'Ctrl+Alt+T', onSelect: cmd.table, disabled: !blockPlace('table'), testId: 'mi-table' },
    { label: 'Reference…', shortcut: 'Ctrl+K', onSelect: cmd.reference, disabled: !anyRef, testId: 'mi-reference' },
    { label: 'Numbered list', onSelect: () => act('Insert list', (p) => ({ path: insertInlineSpec(p, sp, caret.nodeIndex, caret.end, listSpec('sequentialList')).concat(0, 0), caret: null, focus: true })), disabled: !inlineAllowed('sequentialList'), testId: 'mi-olist' },
    { label: 'Bulleted list', onSelect: () => act('Insert list', (p) => ({ path: insertInlineSpec(p, sp, caret.nodeIndex, caret.end, listSpec('randomList')).concat(0, 0), caret: null, focus: true })), disabled: !inlineAllowed('randomList'), testId: 'mi-ulist' },
    { divider: true },
    { label: 'Any element…', shortcut: 'Ctrl+/', onSelect: cmd.insert, disabled: !sp, testId: 'mi-any' },
  ];
  const tableMenu = [
    { label: 'Insert table…', onSelect: cmd.table, disabled: !blockPlace('table'), testId: 'mt-insert' },
    { divider: true },
    { label: 'Row above', onSelect: () => cmd.addRow(-1), disabled: !tctx || (tctx.spans && !cell.modelled), testId: 'mt-row-above' },
    { label: 'Row below', onSelect: () => cmd.addRow(1), disabled: !tctx || (tctx.spans && !cell.modelled), testId: 'mt-row-below' },
    { label: 'Column left', onSelect: () => cmd.addCol(-1), disabled: !tctx || (tctx.spans ? !cell.modelled : tctx.column < 0), testId: 'mt-col-left' },
    { label: 'Column right', onSelect: () => cmd.addCol(1), disabled: !tctx || (tctx.spans ? !cell.modelled : tctx.column < 0), testId: 'mt-col-right' },
    { label: 'Delete row', onSelect: cmd.delRow, disabled: !tctx || (tctx.spans && !cell.modelled), testId: 'mt-row-delete' },
    { label: 'Delete column', onSelect: cmd.delCol, disabled: !tctx || (tctx.spans ? !canDeleteColumnSpanned(doc, sp) : tctx.column < 0 || tctx.cols <= 1), testId: 'mt-col-delete' },
    { divider: true },
    { label: 'Merge selected cells', title: 'Shift+click a second cell to select a range', onSelect: cmd.mergeRange, disabled: !cellRangeInfo || !!cellRangeInfo.reason, testId: 'mt-merge-range' },
    { label: 'Merge right', onSelect: () => act('Merge cells', (p) => { const r = mergeRight(p, sp); return r ? { path: r } : null; }), disabled: !cell || !cell.mergeRight, testId: 'mt-merge-right' },
    { label: 'Merge down', onSelect: () => act('Merge cells', (p) => { const r = mergeDown(p, sp); return r ? { path: r } : null; }), disabled: !cell || !cell.mergeDown, testId: 'mt-merge-down' },
    { label: 'Split cell', onSelect: () => act('Split cell', (p) => { const r = splitCell(p, sp); return r ? { path: r } : null; }), disabled: !cell || !cell.split, testId: 'mt-split' },
    { divider: true },
    ...(align.align ? [['left', 'Align left'], ['center', 'Align centre'], ['right', 'Align right'], ['justify', 'Justify']].filter(([v]) => align.align.includes(v)).map(([v, l]) => ({ label: l, checked: !!cellEntry && cellEntry.getAttribute('align') === v, onSelect: () => cmd.cellAttr('align', v), disabled: !cellEntry, testId: `mt-align-${v}` })) : []),
    { label: 'Align: from the column', onSelect: () => cmd.cellAttr('align', null), disabled: !cellEntry || !cellEntry.getAttribute('align'), testId: 'mt-align-inherit' },
    ...(align.valign ? [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']].filter(([v]) => align.valign.includes(v)).map(([v, l]) => ({ label: l, checked: !!cellEntry && cellEntry.getAttribute('valign') === v, onSelect: () => cmd.cellAttr('valign', v), disabled: !cellEntry, testId: `mt-valign-${v}` })) : []),
    { divider: true },
    { label: 'Column widths…', onSelect: () => setDialog({ kind: 'widths', widths: columnWidths(doc, sp) }), disabled: !tctx || !columnWidths(doc, sp), testId: 'mt-widths' },
  ];
  const menus = [
    { label: 'Edit', items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', onSelect: app.undo, disabled: !app.undo || !app.canUndo, testId: 'me-undo' },
      { label: 'Redo', shortcut: 'Ctrl+Y', onSelect: app.redo, disabled: !app.redo || !app.canRedo, testId: 'me-redo' },
      { divider: true },
      { label: 'Find and replace…', shortcut: 'Ctrl+H', onSelect: () => setDialog({ kind: 'find' }), testId: 'me-find' },
      ...(sp && sp.length ? [{ divider: true }, ...elementActions(sp).filter((x) => x.divider || ['cm-attributes', 'cm-add-sibling', 'cm-duplicate', 'cm-move-up', 'cm-move-down', 'cm-move-into', 'cm-delete'].includes(x.testId))] : []),
    ] },
    { label: 'Insert', items: insertMenu },
    { label: 'Format', items: [
      { label: 'Bold', shortcut: 'Ctrl+B', onSelect: () => applyFormat('bold'), disabled: !formatOk('bold'), testId: 'mf-bold' },
      { label: 'Italic', shortcut: 'Ctrl+I', onSelect: () => applyFormat('italic'), disabled: !formatOk('italic'), testId: 'mf-italic' },
      { label: 'Underline', shortcut: 'Ctrl+U', onSelect: () => applyFormat('underline'), disabled: !formatOk('underline'), testId: 'mf-underline' },
      { label: 'Verbatim text', onSelect: () => applyFormat('verbatim'), disabled: !formatOk('verbatim') },
      { label: 'Subscript', onSelect: () => applyFormat('subscript'), disabled: !formatOk('subscript') },
      { label: 'Superscript', onSelect: () => applyFormat('superscript'), disabled: !formatOk('superscript') },
      { label: 'Clear formatting', onSelect: () => act('Clear formatting', (p) => ({ path: unwrap(p, sp), caret: null })), disabled: !formatting },
      { divider: true },
      { label: inList ? 'Indent bullet' : `Demote ${outlineKind === 'proceduralStep' ? 'step' : 'section'}`, shortcut: 'Tab', onSelect: cmd.demote, disabled: !sp || (!inList && !canDemote(doc, model, sp, outlineKind)), testId: 'mf-demote' },
      { label: inList ? 'Outdent bullet' : `Promote ${outlineKind === 'proceduralStep' ? 'step' : 'section'}`, shortcut: 'Shift+Tab', onSelect: cmd.promote, disabled: !sp || (!inList && !canPromote(doc, model, sp, outlineKind)), testId: 'mf-promote' },
    ] },
    { label: 'Table', items: tableMenu },
    { label: 'View', items: [
      ...(app.setView ? [['design', 'Design'], ['tags', 'Tags'], ['split', 'Split with the XML'], ['xml', 'XML']].map(([v, l]) => ({ label: l, checked: app.view === v, onSelect: () => app.setView(v), testId: `mv-${v}` })) : []),
      { divider: true },
      { label: 'Preview PDF', onSelect: app.preview, disabled: !app.preview, testId: 'mv-preview' },
    ] },
    { label: 'Review', items: [
      { label: 'Validate (schema and BREX)', shortcut: 'Ctrl+Shift+V', onSelect: app.validate, disabled: !app.validate, testId: 'mr-validate' },
      { label: `Live checks (${checks.length})…`, onSelect: () => setDialog({ kind: 'checks' }), testId: 'mr-checks' },
    ] },
    { label: 'Tools', items: [
      { label: 'Give ids to figures, tables, sections and steps', onSelect: cmd.assignIds, testId: 'mx-assign-ids' },
      ...RESEQUENCE_KINDS.map((k) => ({ label: `Re-sequence ${k} ids`, onSelect: () => cmd.reseq(k), disabled: !doc.getElementsByTagName(k).length, testId: `mx-reseq-${k}` })),
      { divider: true },
      { label: 'Re-indent the XML', onSelect: cmd.reindent, testId: 'mx-reindent' },
      { label: 'Word count…', onSelect: () => setDialog({ kind: 'words' }), testId: 'mx-words' },
      { label: 'Print…', shortcut: 'Ctrl+P', onSelect: cmd.print, testId: 'mx-print' },
    ].map((x) => (x.divider || ['mx-words', 'mx-print'].includes(x.testId) ? x : { ...x, disabled: readOnly || x.disabled })) },
    { label: 'Help', items: [{ label: 'Keyboard shortcuts', onSelect: () => setDialog({ kind: 'shortcuts' }), testId: 'mh-shortcuts' }] },
  ];

  // Keyboard shortcuts of the page (typing keys stay with the text run).
  const onKeyDown = (e) => {
    if (e.target.closest && (e.target.closest('dialog') || e.target.closest('[role="menu"]') || e.target.closest('[role="menubar"]'))) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const take = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
    if (mod && !e.altKey && k === 'h') return take(() => setDialog({ kind: 'find' }));
    if (mod && !e.altKey && !e.shiftKey && k === 'p') return take(cmd.print);
    if (mod && e.shiftKey && k === 'v' && app.validate) return take(app.validate);
    if (readOnly) return undefined;
    if (mod && !e.altKey && !e.shiftKey && ['b', 'i', 'u'].includes(k)) return take(() => { const f = { b: 'bold', i: 'italic', u: 'underline' }[k]; if (formatOk(f)) applyFormat(f); });
    // Structure keys only while the caret is in the page's text: elsewhere Tab still moves the focus.
    const inText = !!(e.target.dataset && e.target.dataset.run);
    if (inText && e.key === 'Enter' && mod) return take(e.shiftKey ? cmd.blockBefore : cmd.blockAfter);
    if (inText && e.key === 'Enter' && e.shiftKey && !e.altKey) return take(cmd.section);
    // In a table cell, Tab and Shift+Tab move to the next and previous cell (the section is not touched).
    const cellEl = inText && e.key === 'Tab' && e.target.closest('td, th');
    if (cellEl && !mod && !e.altKey) {
      return take(() => {
        const cells = Array.from(cellEl.closest('table').querySelectorAll('td, th')).filter((c) => c.querySelector('[data-run]'));
        const next = cells[cells.indexOf(cellEl) + (e.shiftKey ? -1 : 1)];
        if (!next) { setNotice(e.shiftKey ? 'This is the first cell.' : 'This is the last cell; add a row with Row ↓.'); return; }
        const r = next.querySelector('[data-run]');
        r.focus();
        const range = document.createRange(); range.selectNodeContents(r); range.collapse(false);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        r.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
    }
    if (inText && e.key === 'Tab' && sp && !mod && !e.altKey) return take(e.shiftKey ? cmd.promote : cmd.demote);
    if (mod && !e.altKey && k === 'k') return take(cmd.reference);
    if (mod && !e.altKey && e.key === '/') return take(cmd.insert);
    if (mod && e.altKey) {
      const map = { KeyP: () => cmd.named('para', 'paragraph'), Digit1: cmd.section, Digit2: cmd.subSection, KeyW: () => cmd.named('warning'), KeyC: () => cmd.named('caution'), KeyN: () => cmd.named('note'), KeyS: () => cmd.named('proceduralStep', 'step'), KeyG: cmd.figure, KeyT: cmd.table };
      if (map[e.code]) return take(map[e.code]);
    }
    return undefined;
  };

  // Find, print and validate also work when nothing has the focus (after a dialog closes, a button was used).
  globalKeys.current = (e) => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const t = e.target;
    if (t !== document.body && t !== document.documentElement) return;
    const k = e.key.toLowerCase();
    if (k === 'h' && !e.shiftKey) { e.preventDefault(); setDialog({ kind: 'find' }); }
    else if (k === 'p' && !e.shiftKey) { e.preventDefault(); cmd.print(); }
    else if (k === 'v' && e.shiftKey && app.validate) { e.preventDefault(); app.validate(); }
  };

  const onContextMenu = (e) => {
    if (readOnly) return;
    const t = e.target.closest && e.target.closest('[data-path]');
    if (!t || !host.current || !host.current.contains(t)) return;
    e.preventDefault();
    const path = t.dataset.path ? t.dataset.path.split('.').map(Number) : [];
    if (!path.length) return;
    if (!same(sp, path)) select(path);
    setMenu({ x: e.clientX, y: e.clientY, path });
  };

  const Tool = ({ label, icon, onClick, disabled, testId, children }) => (
    <Button size="sm" variant="ghost" icon={icon} disabled={readOnly || disabled} title={label} aria-label={label} data-testid={testId}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{children}</Button>
  );

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <div className="sticky top-0 z-10 border-b border-line bg-surface px-2 py-1">
        <MenuBar menus={readOnly ? menus.filter((m) => ['Edit', 'View', 'Review', 'Tools', 'Help'].includes(m.label)).map((m) => (m.label === 'Edit' ? { ...m, items: m.items.filter((x) => x.testId === 'me-find') } : m)) : menus} />
      {!readOnly ? (
        <div role="toolbar" aria-label="Page editing" data-testid="page-toolbar">
          <div className="flex flex-wrap items-center gap-0.5">
          <Tool label="Bold" testId="fmt-bold" disabled={!formatOk('bold')} onClick={() => applyFormat('bold')}><span className="font-bold">B</span></Tool>
          <Tool label="Italic" testId="fmt-italic" disabled={!formatOk('italic')} onClick={() => applyFormat('italic')}><span className="italic">I</span></Tool>
          <Tool label="Underline" testId="fmt-underline" disabled={!formatOk('underline')} onClick={() => applyFormat('underline')}><span className="underline">U</span></Tool>
          <Tool label="Verbatim text" testId="fmt-verbatim" disabled={!formatOk('verbatim')} onClick={() => applyFormat('verbatim')}><span className="font-mono">{'{}'}</span></Tool>
          <Tool label="Subscript" testId="fmt-subscript" disabled={!formatOk('subscript')} onClick={() => applyFormat('subscript')}>x<sub>2</sub></Tool>
          <Tool label="Superscript" testId="fmt-superscript" disabled={!formatOk('superscript')} onClick={() => applyFormat('superscript')}>x<sup>2</sup></Tool>
          <Tool label="Clear formatting" testId="fmt-clear" disabled={!formatting} onClick={() => act('Clear formatting', (p) => ({ path: unwrap(p, selected.path), caret: null }))}>Tx</Tool>
          <span className="mx-1 h-5 w-px bg-line" />
          <Tool label="Insert an element (or type / in an empty line)" icon="plus" testId="tool-insert" disabled={!selected} onClick={() => setDialog({ kind: 'insert', path: selected.path, caret })}>Insert</Tool>
          <Tool label="Reference" icon="link" testId="tool-reference" disabled={!anyRef} onClick={() => setDialog({ kind: 'reference' })}>Reference</Tool>
          <Tool label="Figure" icon="layers" testId="tool-figure" disabled={!blockPlace('figure')} onClick={() => setDialog({ kind: 'figure' })}>Figure</Tool>
          <Tool label="Table" icon="table" testId="tool-table" disabled={!blockPlace('table')} onClick={() => setDialog({ kind: 'table' })}>Table</Tool>
          <Tool label="Numbered list" icon="list" testId="tool-olist" disabled={!inlineAllowed('sequentialList')} onClick={() => act('Insert list', (p) => ({ path: insertInlineSpec(p, selected.path, caret.nodeIndex, caret.end, listSpec('sequentialList')).concat(0, 0), caret: null, focus: true }))}>1.</Tool>
          <Tool label="Bulleted list" icon="list" testId="tool-ulist" disabled={!inlineAllowed('randomList')} onClick={() => act('Insert list', (p) => ({ path: insertInlineSpec(p, selected.path, caret.nodeIndex, caret.end, listSpec('randomList')).concat(0, 0), caret: null, focus: true }))}>•</Tool>
          <span className="mx-1 h-5 w-px bg-line" />
          <Tool label="Insert a warning (Ctrl+Alt+W)" testId="tool-warning" disabled={!slot('warning')} onClick={() => cmd.named('warning')}>Warning</Tool>
          <Tool label="Insert a caution (Ctrl+Alt+C)" testId="tool-caution" disabled={!slot('caution')} onClick={() => cmd.named('caution')}>Caution</Tool>
          <Tool label="Insert a note (Ctrl+Alt+N)" testId="tool-note" disabled={!slot('note')} onClick={() => cmd.named('note')}>Note</Tool>
          <Tool label={inList ? 'Outdent (Shift+Tab)' : 'Promote (Shift+Tab)'} testId="tool-promote" disabled={!sp || (!inList && !canPromote(doc, model, sp, outlineKind))} onClick={cmd.promote}>⇤</Tool>
          <Tool label={inList ? 'Indent (Tab)' : 'Demote (Tab)'} testId="tool-demote" disabled={!sp || (!inList && !canDemote(doc, model, sp, outlineKind))} onClick={cmd.demote}>⇥</Tool>
          </div>
          {/*
            Table and list tools have a row of their own, always there: the page
            must not move under the pointer when a cell is clicked.
          */}
          <div className="flex h-8 items-center gap-0.5 overflow-x-auto overflow-y-hidden whitespace-nowrap" data-testid="context-tools">
          {notice ? <span className="px-1 text-[12px] text-warn" role="status" data-testid="page-notice">{notice}</span> : null}
          {!notice && !tctx && !inList ? <span className="px-1 text-[12px] text-ink-3">Select a table cell or a list item for its tools.</span> : null}
          {!notice && tctx ? (
            <>
              <Tool label={tctx.spans && !cell.modelled ? notModelled : 'Row above'} testId="tbl-row-above" disabled={tctx.spans && !cell.modelled} onClick={() => cmd.addRow(-1)}>Row ↑</Tool>
              <Tool label={tctx.spans && !cell.modelled ? notModelled : 'Row below'} testId="tbl-row-below" disabled={tctx.spans && !cell.modelled} onClick={() => cmd.addRow(1)}>Row ↓</Tool>
              <Tool label={tctx.spans && !cell.modelled ? notModelled : 'Delete row'} testId="tbl-row-delete" disabled={tctx.spans && !cell.modelled} onClick={cmd.delRow}>Row ✕</Tool>
              <Tool label={tctx.spans && !cell.modelled ? notModelled : 'Column left'} testId="tbl-col-left" disabled={tctx.spans ? !cell.modelled : tctx.column < 0} onClick={() => cmd.addCol(-1)}>Col ←</Tool>
              <Tool label={tctx.spans && !cell.modelled ? notModelled : 'Column right'} testId="tbl-col-right" disabled={tctx.spans ? !cell.modelled : tctx.column < 0} onClick={() => cmd.addCol(1)}>Col →</Tool>
              <Tool label="Delete column" testId="tbl-col-delete" disabled={tctx.spans ? !canDeleteColumnSpanned(doc, sp) : tctx.column < 0 || tctx.cols <= 1} onClick={cmd.delCol}>Col ✕</Tool>
              <Tool label={cell.modelled ? 'Merge with the cell to the right (same rows)' : notModelled} testId="tbl-merge-right" disabled={!cell.mergeRight} onClick={() => act('Merge cells', (p) => { const r = mergeRight(p, selected.path); return r ? { path: r } : null; })}>Merge →</Tool>
              <Tool label={cell.modelled ? 'Merge with the cell below (same columns)' : notModelled} testId="tbl-merge-down" disabled={!cell.mergeDown} onClick={() => act('Merge cells', (p) => { const r = mergeDown(p, selected.path); return r ? { path: r } : null; })}>Merge ↓</Tool>
              <Tool label={cellRangeInfo ? (cellRangeInfo.reason || 'Merge the selected cells') : 'Shift+click another cell to select a range'} testId="tbl-merge-range" disabled={!cellRangeInfo || !!cellRangeInfo.reason} onClick={cmd.mergeRange}>Merge range</Tool>
              <Tool label={cell.modelled ? 'Split a merged cell into single cells' : notModelled} testId="tbl-split" disabled={!cell.split} onClick={() => act('Split cell', (p) => { const r = splitCell(p, selected.path); return r ? { path: r } : null; })}>Split</Tool>
              {cellRangeInfo && cellRangeInfo.reason ? <span className="px-1 text-[12px] text-warn" data-testid="range-reason">{cellRangeInfo.reason}</span> : null}
            </>
          ) : null}
          {!notice && inList ? (
            <>
              {tctx ? <span className="mx-1 h-5 w-px bg-line" /> : null}
              <Tool label="Add list item" testId="list-add" onClick={() => act('Add list item', (p) => ({ path: addListItem(p, selected.path, 1).concat(0), caret: null, focus: true }))}>Item +</Tool>
              <Tool label="Indent list item" testId="list-indent" onClick={() => act('Indent', (p) => { const r = indentItem(p, selected.path); return r ? { path: r } : null; })}>Indent</Tool>
              <Tool label="Outdent list item" testId="list-outdent" onClick={() => act('Outdent', (p) => { const r = outdentItem(p, selected.path); return r ? { path: r } : null; })}>Outdent</Tool>
            </>
          ) : null}
          </div>
        </div>
      ) : null}
      </div>
      <div ref={host} className="flex-1 px-8 py-6 text-[13.5px] max-w-[880px]" data-testid="page-view" onClick={() => onSelect(null)} onContextMenu={onContextMenu}>
        {block(doc.documentElement, [])}
      </div>

      {menu ? <ContextMenu x={menu.x} y={menu.y} title={`<${(elementAt(doc, menu.path) || { nodeName: '?' }).nodeName}>`} items={elementActions(menu.path)} onClose={() => setMenu(null)} /> : null}
      {dialog && dialog.kind === 'insert' ? (
        <InsertPalette doc={doc} model={model} path={dialog.path} caret={dialog.caret} onClose={() => setDialog(null)}
          onPick={(choice) => { setDialog(null); act(`Insert ${choice.name}`, (p) => (choice.inline
            ? { path: insertInline(p, dialog.path, dialog.caret.nodeIndex, dialog.caret.end, choice.name, model), caret: null, focus: true }
            : { path: insertElement(p, choice.parentPath, choice.index, choice.name, model), caret: null, focus: true })); }} />
      ) : null}
      {dialog && dialog.kind === 'reference' ? (
        <ReferenceDialog targets={targets} modules={modules} allowed={refsAllowed} projectId={projectId}
          onClose={() => setDialog(null)}
          onInsert={(make, extra = {}) => {
            setDialog(null);
            let at = null;
            act('Insert reference', (p) => { at = insertInlineSpec(p, selected.path, caret.nodeIndex, caret.end, make(p)); return after(p, at); });
            // The target's issue arrives later: added to that reference without touching the text being typed.
            // A save asked for meanwhile waits for it (app.track), so the issue is saved with the reference.
            if (extra.issue && at) {
              const refAt = at;
              const done = extra.issue.then((issue) => patch('Reference issue', (p) => addRefIssue(p, refAt, issue)),
                () => setNotice('The reference was inserted without its issue: the data module could not be read.'));
              if (app.track) app.track(done);
            }
          }} />
      ) : null}
      {dialog && dialog.kind === 'figure' ? (
        <FigureDialog projectId={projectId} doc={doc} onClose={() => setDialog(null)}
          onInsert={(spec) => { setDialog(null); act('Insert figure', (p) => { const at = placementFor(p.doc, model, selected.path, 'figure'); return at ? { path: insertBlock(p, at.parentPath, at.index, spec(p)), caret: null, scroll: true } : null; }); }} />
      ) : null}
      {dialog && dialog.kind === 'ident' ? (
        <IdentDialog doc={doc} model={model} dmc={dmcOf(doc.getElementsByTagName('identAndStatusSection')[0])} onClose={() => setDialog(null)}
          onSave={(values) => { setDialog(null); act('Edit identification', (p) => { setIdent(p, values, model); return null; }); }} />
      ) : null}
      {dialog && dialog.kind === 'table' ? (
        <TableDialog doc={doc} onClose={() => setDialog(null)}
          onInsert={(spec) => { setDialog(null); act('Insert table', (p) => { const at = placementFor(p.doc, model, selected.path, 'table'); return at ? { path: insertBlock(p, at.parentPath, at.index, spec(p)), caret: null, scroll: true } : null; }); }} />
      ) : null}
      {dialog && dialog.kind === 'find' ? (
        <FindReplaceDialog doc={doc} readOnly={readOnly} onClose={() => setDialog(null)} onGo={(m) => go(m.path)}
          onReplace={(ms, text) => { let n = 0; act(ms.length > 1 ? 'Replace all' : 'Replace', (p) => { n = replaceMatches(p, ms, text); return n ? null : false; }); setNotice(`${n} replaced.`); }} />
      ) : null}
      {dialog && dialog.kind === 'words' ? <WordCountDialog doc={doc} onClose={() => setDialog(null)} /> : null}
      {dialog && dialog.kind === 'shortcuts' ? <ShortcutsDialog onClose={() => setDialog(null)} /> : null}
      {dialog && dialog.kind === 'widths' ? (
        <ColumnWidthsDialog widths={dialog.widths} onClose={() => setDialog(null)}
          onSave={(w) => { setDialog(null); tryAct('Column widths', (p) => setColumnWidths(p, sp, w)); }} />
      ) : null}
      {dialog && dialog.kind === 'attributes' ? (
        <AttributesDialog doc={doc} model={model} path={dialog.path} onClose={() => setDialog(null)}
          onSave={(changes) => { setDialog(null); if (Object.keys(changes).length) act('Attributes', (p) => { for (const [a, v] of Object.entries(changes)) setAttribute(p, dialog.path, a, v); return { path: dialog.path, caret: null }; }); }} />
      ) : null}
      {dialog && dialog.kind === 'checks' ? (
        <Dialog open onClose={() => setDialog(null)} title="Live checks" size="md" description="Found while you edit, before any validation. Validate for the full schema and BREX check.">
          {checks.length ? (
            <ul className="divide-y divide-line rounded-md border border-line text-[13px]" data-testid="checks-list">
              {checks.map((c, i) => (
                <li key={i} className="flex items-start gap-2 px-3 py-2">
                  <span className={c.sev === 'error' ? 'text-danger' : 'text-warn'}>{c.sev === 'error' ? 'Error' : 'Warning'}</span>
                  <span className="flex-1 text-ink">{c.message}</span>
                  <Button size="sm" variant="ghost" onClick={() => { setDialog(null); go(c.path); }}>Go to</Button>
                </li>
              ))}
            </ul>
          ) : <p className="text-[13px] text-ink-3">Nothing found.</p>}
        </Dialog>
      ) : null}
    </div>
  );
}

/*
  The outline: numbered paragraphs, steps, figures and tables, for moving
  around a long module. Clicking a line selects that element and scrolls to it.
*/
export function Outline({ xml, onSelect }) {
  const parsed = useMemo(() => parseXml(xml), [xml]);
  if (parsed.error) return <p className="px-5 pb-5 text-[13px] text-ink-3">Correct the XML to see the outline.</p>;
  const targets = referenceTargets(parsed.doc);
  if (!targets.length) return <p className="px-5 pb-5 text-[13px] text-ink-3">No numbered paragraphs, steps, figures or tables yet.</p>;
  return (
    <nav aria-label="Document outline" className="px-3 pb-4 max-h-80 overflow-y-auto" data-testid="outline">
      <ul className="space-y-0.5">
        {targets.map((t) => (
          <li key={key(t.path)}>
            <button type="button" onClick={() => onSelect({ path: t.path, caret: null, scroll: true })}
              className={`w-full text-left rounded px-2 py-1 text-[12.5px] hover:bg-surface-3 ${t.kind === 'figure' || t.kind === 'table' ? 'text-ink-2' : 'text-ink'}`}
              style={{ paddingLeft: `${8 + (t.kind === 'levelledPara' || t.kind === 'proceduralStep' ? (t.label.split(' ')[1].split('.').length - 1) * 12 : 12)}px` }}>
              <span className="mr-1.5 font-mono text-[11.5px] text-ink-3">{t.label}</span>{t.title || <span className="italic text-ink-3">untitled</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
