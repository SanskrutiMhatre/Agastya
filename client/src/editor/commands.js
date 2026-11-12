// Editing commands of the page view added for parity with the Agastya
// original's editor (decisions.md PV15-PV24): sections and steps promoted and
// demoted, blocks before and after, warnings, cautions and notes, moving an
// element into its previous sibling, list exits, table cell alignment, merging
// a range of cells, columns in tables with merged cells, column widths,
// publication-module and fuller data-module references, find and replace,
// word count, id assignment and re-sequencing, re-indenting, and live checks.
// Our own implementation: nothing of the original was copied (PV3).
//
// Like ops.js these are pure functions over the parsed document of xmlDoc.js:
// each records what it changes (so only that is rewritten) and returns the
// path to select afterwards, or null when it cannot be done here. Nothing is
// built that the S1000D content model does not allow at that place.

import {
  elementAt, elementChildren, childNames, pathOf, markChanged, markTextChanged, protectText, displayText, insertElement, createElementFilled,
} from './xmlDoc.js';
import { build, placeElement, up, tableGrid, ensureColNames, absorb, cellAt, allIds, TARGET_TYPE } from './ops.js';

const isWs = (s) => /^\s*$/.test(s);

// Take an element out of its parent, with the indentation before it.
function detach(parsed, el) {
  const parent = el.parentNode;
  markChanged(parsed, parent);
  const prev = el.previousSibling;
  parent.removeChild(el);
  if (prev && prev.nodeType === 3 && /^\s+$/.test(prev.data) && prev.previousSibling) parent.removeChild(prev);
}

// The nearest ancestor-or-self of the element at `path` called `name`, as a path.
export function nearest(doc, path, name) {
  if (!path) return null;
  const el = up(elementAt(doc, path), name);
  return el ? pathOf(el) : null;
}

// ---- blocks around the selection ------------------------------------------------------------

/*
  The nearest place for an element called `name`: after the selected element
  or one of its ancestors, else before it, else anywhere in that ancestor
  (nearest index first). Warnings and cautions, for example, may only stand
  at the start of a section, so "insert a warning" from its last paragraph
  finds that place. Returns { parentPath, index } or null.
*/
export function nearestSlot(doc, model, path, name) {
  if (!path) return null;
  for (let p = path; p.length; p = p.slice(0, -1)) {
    const parentPath = p.slice(0, -1);
    const parent = elementAt(doc, parentPath);
    if (model.holdsText(parent.nodeName)) continue;
    const names = childNames(parent);
    const me = p[p.length - 1];
    const order = [me + 1, me, ...Array.from({ length: names.length + 1 }, (_, i) => i).sort((a, b) => Math.abs(a - me) - Math.abs(b - me))];
    for (const index of order) if (model.insertableAt(parent.nodeName, names, index).includes(name)) return { parentPath, index };
  }
  return null;
}

export function insertNamed(parsed, model, path, name) {
  const at = nearestSlot(parsed.doc, model, path, name);
  return at ? insertElement(parsed, at.parentPath, at.index, name, model) : null;
}

// What "a new block here" means, in order of preference: the first the place accepts.
const BLOCK_DEFAULTS = ['para', 'proceduralStep', 'levelledPara', 'notePara', 'warningAndCautionPara', 'listItem'];
// Lists are left rather than added to: Enter and the list tools add items.
const PASS_THROUGH = new Set(['listItem', 'sequentialList', 'randomList', 'attentionSequentialList', 'attentionRandomList', 'definitionList']);

/*
  A new block just after (or before) the element at `path`, at the nearest
  level that accepts one: a paragraph after a title, a step after a step,
  a paragraph after the list a bullet is in (Ctrl+Enter, Ctrl+Shift+Enter).
*/
export function blockSlot(doc, model, path, where = 'after') {
  if (!path) return null;
  for (let p = path; p.length; p = p.slice(0, -1)) {
    const parentPath = p.slice(0, -1);
    const parent = elementAt(doc, parentPath);
    if (PASS_THROUGH.has(parent.nodeName) || model.holdsText(parent.nodeName)) continue;
    const index = p[p.length - 1] + (where === 'after' ? 1 : 0);
    const ok = model.insertableAt(parent.nodeName, childNames(parent), index);
    const name = BLOCK_DEFAULTS.find((n) => ok.includes(n));
    if (name) return { parentPath, index, name };
  }
  return null;
}

export function blockAround(parsed, model, path, where = 'after') {
  const at = blockSlot(parsed.doc, model, path, where);
  if (!at) return null;
  // An empty block of that kind already there (a new section's first paragraph) is used, not doubled.
  const parent = elementAt(parsed.doc, at.parentPath);
  const there = elementChildren(parent)[where === 'after' ? at.index : at.index - 1];
  if (there && there.nodeName === at.name && isWs(there.textContent) && !elementChildren(there).length) return pathOf(there);
  return insertElement(parsed, at.parentPath, at.index, at.name, model);
}

// ---- sections and steps -------------------------------------------------------------------

// A new section after the current one (or wherever the selection allows one).
export function newSection(parsed, model, path) {
  const sec = nearest(parsed.doc, path, 'levelledPara');
  if (sec) {
    const parentPath = sec.slice(0, -1);
    const parent = elementAt(parsed.doc, parentPath);
    const index = sec[sec.length - 1] + 1;
    if (model.insertableAt(parent.nodeName, childNames(parent), index).includes('levelledPara')) return insertElement(parsed, parentPath, index, 'levelledPara', model);
  }
  return insertNamed(parsed, model, path, 'levelledPara');
}

// A section inside the current one, at its end.
export function newSubSection(parsed, model, path) {
  const sec = nearest(parsed.doc, path, 'levelledPara');
  if (!sec) return null;
  const el = elementAt(parsed.doc, sec);
  const names = childNames(el);
  return model.insertableAt('levelledPara', names, names.length).includes('levelledPara') ? insertElement(parsed, sec, names.length, 'levelledPara', model) : null;
}

/*
  Demote (Tab): the section or step becomes the last child of the one before
  it. Promote (Shift+Tab): it moves out to follow its parent, taking the
  sections or steps that followed it along as its own children, so the
  reading order does not change. Each returns the new path, or null.
*/
export function canDemote(doc, model, path, kind) {
  const at = nearest(doc, path, kind);
  if (!at) return false;
  const el = elementAt(doc, at);
  let prev = el.previousSibling;
  while (prev && prev.nodeType !== 1) prev = prev.previousSibling;
  return !!prev && prev.nodeName === kind && model.insertableAt(kind, childNames(prev), childNames(prev).length).includes(kind);
}

export function demote(parsed, model, path, kind) {
  if (!canDemote(parsed.doc, model, path, kind)) return null;
  const el = elementAt(parsed.doc, nearest(parsed.doc, path, kind));
  let prev = el.previousSibling;
  while (prev.nodeType !== 1) prev = prev.previousSibling;
  detach(parsed, el);
  return placeElement(parsed, prev, elementChildren(prev).length, el);
}

function promotion(doc, model, path, kind) {
  const at = nearest(doc, path, kind);
  if (!at || at.length < 2) return null;
  const el = elementAt(doc, at);
  const parent = el.parentNode;
  if (parent.nodeName !== kind || !parent.parentNode || parent.parentNode.nodeType !== 1) return null;
  const following = [];
  for (let n = el.nextSibling; n; n = n.nextSibling) if (n.nodeType === 1) following.push(n);
  if (following.some((f) => f.nodeName !== kind)) return null;
  const grand = parent.parentNode;
  const gNames = childNames(grand);
  const index = elementChildren(grand).indexOf(parent) + 1;
  if (!model.insertableAt(grand.nodeName, gNames, index).includes(kind)) return null;
  const rest = childNames(parent).slice(0, elementChildren(parent).indexOf(el));
  if (!model.isValidSequence(kind, rest) && model.isValidSequence(kind, childNames(parent))) return null;
  return { el, parent, grand, index, following };
}

export const canPromote = (doc, model, path, kind) => !!promotion(doc, model, path, kind);

export function promote(parsed, model, path, kind) {
  const p = promotion(parsed.doc, model, path, kind);
  if (!p) return null;
  for (const f of p.following) detach(parsed, f);
  detach(parsed, p.el);
  for (const f of p.following) placeElement(parsed, p.el, elementChildren(p.el).length, f);
  return placeElement(parsed, p.grand, p.index, p.el);
}

// ---- moving any element -----------------------------------------------------------------------

function prevElement(el) {
  let prev = el.previousSibling;
  while (prev && prev.nodeType !== 1) prev = prev.previousSibling;
  return prev;
}

// "Move into previous sibling": the element becomes the last child of the element before it.
export function canMoveIntoPrevious(doc, model, path) {
  if (!path || !path.length) return false;
  const el = elementAt(doc, path);
  const prev = el && prevElement(el);
  return !!prev && !model.holdsText(prev.nodeName) && model.insertableAt(prev.nodeName, childNames(prev), childNames(prev).length).includes(el.nodeName);
}

export function moveIntoPrevious(parsed, model, path) {
  if (!canMoveIntoPrevious(parsed.doc, model, path)) return null;
  const el = elementAt(parsed.doc, path);
  const prev = prevElement(el);
  detach(parsed, el);
  return placeElement(parsed, prev, elementChildren(prev).length, el);
}

// "Add another <x> after": a new, empty element of the same kind just after it.
export function canAddSibling(doc, model, path) {
  if (!path || !path.length) return false;
  const el = elementAt(doc, path);
  const parent = el.parentNode;
  return !model.holdsText(parent.nodeName) && model.insertableAt(parent.nodeName, childNames(parent), path[path.length - 1] + 1).includes(el.nodeName);
}

export function addSibling(parsed, model, path) {
  if (!canAddSibling(parsed.doc, model, path)) return null;
  const el = elementAt(parsed.doc, path);
  return insertElement(parsed, path.slice(0, -1), path[path.length - 1] + 1, el.nodeName, model);
}

// ---- lists ------------------------------------------------------------------------------------

// No text, and nothing in it but empty paragraphs.
const emptyText = (el) => isWs(el.textContent) && Array.from(el.getElementsByTagName('*')).every((e) => e.nodeName === 'para' && !elementChildren(e).length);

/*
  Enter on an empty last bullet ends the list: the bullet goes, and a new
  paragraph follows the paragraph the list is in. In a nested list the bullet
  moves out a level instead. Returns the path to focus, or null.
*/
export function exitList(parsed, model, path, outdent) {
  const item = up(elementAt(parsed.doc, path), 'listItem');
  if (!item) return null;
  const list = item.parentNode;
  const items = elementChildren(list).filter((c) => c.nodeName === 'listItem');
  if (items[items.length - 1] !== item || !emptyText(item)) return null;
  const holder = list.parentNode;
  if (up(holder, 'listItem')) return outdent(parsed, pathOf(item));
  const holderPath = pathOf(holder);
  // Where the paragraph goes is decided first: nothing is removed unless it can follow.
  if (!blockSlot(parsed.doc, model, holderPath, 'after')) return null;
  if (items.length === 1) detach(parsed, list); else detach(parsed, item);
  return blockAround(parsed, model, holderPath, 'after');
}

// ---- tables -----------------------------------------------------------------------------------

// Horizontal and vertical alignment of a cell; null removes it (the colspec's then applies).
export function cellAlignOptions(model) {
  const a = model.attributesOf('entry');
  return { align: a.align || null, valign: a.valign || null };
}

export function setCellAttr(parsed, model, path, attr, value) {
  const entry = up(elementAt(parsed.doc, path), 'entry');
  const allowed = model.attributesOf('entry')[attr];
  if (!entry || !allowed || (value !== null && allowed.length && !allowed.includes(value))) return null;
  if ((entry.getAttribute(attr) || null) === value) return pathOf(entry);
  markChanged(parsed, entry, { attributes: true });
  if (value === null) entry.removeAttribute(attr); else entry.setAttribute(attr, value);
  return pathOf(entry);
}

/*
  The cells from the cell at `a` to the cell at `b` (opposite corners, in the
  same header or body), as a rectangle: { cells, top } or a reason it cannot
  be merged (a cell lying partly outside, a row left with no cell of its own).
*/
export function cellRange(doc, a, b) {
  const A = cellAt(doc, a);
  const B = cellAt(doc, b);
  if (!A || !B || A.tg !== B.tg || A.cell.section !== B.cell.section) return { reason: 'Choose cells of the same table part.' };
  const grid = A.grid;
  const r0 = Math.min(A.cell.r, B.cell.r);
  const r1 = Math.max(A.cell.r + A.cell.rows - 1, B.cell.r + B.cell.rows - 1);
  const c0 = Math.min(A.cell.start, B.cell.start);
  const c1 = Math.max(A.cell.end, B.cell.end);
  const inSection = grid.cells.filter((x) => x.section === A.cell.section);
  const overlaps = (x) => x.r <= r1 && x.r + x.rows - 1 >= r0 && x.start <= c1 && x.end >= c0;
  const inside = (x) => x.r >= r0 && x.r + x.rows - 1 <= r1 && x.start >= c0 && x.end <= c1;
  const cells = inSection.filter(overlaps);
  if (cells.some((x) => !inside(x))) return { reason: 'A merged cell lies partly outside the selection.' };
  if (cells.length < 2) return { reason: 'Select at least two cells.' };
  const top = cells.find((x) => x.r === r0 && x.start === c0);
  for (let r = r0 + 1; r <= r1; r++) {
    const rowEl = A.cell.sectionRows[r];
    const own = elementChildren(rowEl).filter((c) => c.nodeName === 'entry');
    if (own.every((e) => cells.some((x) => x.entry === e))) return { reason: 'A row would be left with no cell of its own; delete the row instead.' };
  }
  return { grid, tg: A.tg, cells, top, r0, r1, c0, c1 };
}

// Merge a rectangle of cells into its top-left cell; the others' content follows in reading order.
export function mergeRange(parsed, a, b) {
  const R = cellRange(parsed.doc, a, b);
  if (R.reason) return null;
  const names = ensureColNames(parsed, R.tg, R.grid);
  const e = R.top.entry;
  markChanged(parsed, e, { attributes: true });
  if (R.c1 > R.c0) { e.removeAttribute('colname'); e.setAttribute('namest', names[R.c0]); e.setAttribute('nameend', names[R.c1]); }
  if (R.r1 > R.r0) e.setAttribute('morerows', String(R.r1 - R.r0)); else e.removeAttribute('morerows');
  const order = R.cells.filter((x) => x !== R.top).sort((x, y) => x.r - y.r || x.start - y.start);
  for (const x of order) absorb(parsed, e, x.entry);
  return pathOf(e);
}

// The colspec elements by column index, when every column has one (after ensureColNames).
function specsByColumn(tg, names) {
  const specs = elementChildren(tg).filter((c) => c.nodeName === 'colspec');
  return names.map((n) => specs.find((s) => s.getAttribute('colname') === n) || null);
}

function freshColName(names) {
  const used = new Set(names);
  let k = names.length + 1;
  while (used.has(`col${k}`)) k++;
  return `col${k}`;
}

/*
  A column left (-1) or right (+1) of the cell at `path`, in a table that may
  have merged cells: a merged cell that crosses the new column's place widens
  over it; every other row gets a new cell there.
*/
export function addColumnSpanned(parsed, path, where) {
  const at = cellAt(parsed.doc, path);
  if (!at) return null;
  const { cell, tg } = at;
  const boundary = where < 0 ? cell.start : cell.end + 1;
  const names = ensureColNames(parsed, tg, at.grid);
  const grid = tableGrid(tg);
  if (!grid) return null;
  const name = freshColName(names);
  const specs = specsByColumn(tg, names);
  const numbered = specs.some((s) => s && s.getAttribute('colnum'));
  const allSpecs = elementChildren(tg).filter((c) => c.nodeName === 'colspec');
  const spec = build(parsed.doc, { name: 'colspec', attrs: { ...(numbered ? { colnum: String(boundary + 1) } : {}), colname: name } });
  if (numbered) {
    for (const s of allSpecs) {
      const n = Number(s.getAttribute('colnum'));
      if (n >= boundary + 1) { markChanged(parsed, s, { attributes: true }); s.setAttribute('colnum', String(n + 1)); }
    }
  }
  const ref = specs[boundary] || null;
  placeElement(parsed, tg, ref ? allSpecs.indexOf(ref) : allSpecs.length, spec);
  for (const { rowEl, section, r } of grid.rows) {
    const crossing = grid.cells.some((x) => x.section === section && x.r <= r && x.r + x.rows - 1 >= r && x.start < boundary && x.end >= boundary);
    if (crossing) continue;
    const entries = elementChildren(rowEl).filter((c) => c.nodeName === 'entry');
    const after = grid.cells.filter((x) => x.rowEl === rowEl && x.start >= boundary).map((x) => x.entry);
    const before = entries.findIndex((x) => after.includes(x));
    const pos = elementChildren(rowEl).indexOf(before === -1 ? null : entries[before]);
    placeElement(parsed, rowEl, pos === -1 ? elementChildren(rowEl).length : pos, build(parsed.doc, { name: 'entry', attrs: { colname: name }, children: [{ name: 'para', children: [] }] }));
  }
  markChanged(parsed, tg, { attributes: true });
  tg.setAttribute('cols', String(grid.cols + 1));
  return pathOf(cell.entry);
}

/*
  Delete the column of the cell at `path` (its first column, for a merged
  cell): merged cells over it narrow, single cells in it go. Refused when a
  row would be left with no cell.
*/
export function canDeleteColumnSpanned(doc, path) {
  const at = cellAt(doc, path);
  if (!at || at.grid.cols <= 1) return false;
  const c = at.cell.start;
  const going = at.grid.cells.filter((x) => x.start === c && x.end === c);
  return !at.grid.rows.some(({ rowEl }) => {
    const own = elementChildren(rowEl).filter((e) => e.nodeName === 'entry');
    return own.length && own.every((e) => going.some((x) => x.entry === e));
  });
}

export function deleteColumnSpanned(parsed, path) {
  if (!canDeleteColumnSpanned(parsed.doc, path)) return null;
  const at = cellAt(parsed.doc, path);
  const { tg, cell } = at;
  const c = cell.start;
  const names = ensureColNames(parsed, tg, at.grid);
  const grid = tableGrid(tg);
  const specs = specsByColumn(tg, names);
  let keep = null;
  for (const x of grid.cells) {
    if (x.start > c || x.end < c) continue;
    const e = x.entry;
    if (x.start === x.end) { detach(parsed, e); continue; }
    markChanged(parsed, e, { attributes: true });
    const s = x.start === c ? x.start + 1 : x.start;
    const en = x.end === c ? x.end - 1 : x.end;
    if (s === en) { e.removeAttribute('namest'); e.removeAttribute('nameend'); e.setAttribute('colname', names[s]); } else { e.setAttribute('namest', names[s]); e.setAttribute('nameend', names[en]); }
    if (x === cell || keep === null) keep = e;
  }
  const spec = specs[c];
  if (spec) {
    const num = Number(spec.getAttribute('colnum'));
    detach(parsed, spec);
    if (num) {
      for (const s of elementChildren(tg).filter((x) => x.nodeName === 'colspec')) {
        const n = Number(s.getAttribute('colnum'));
        if (n > num) { markChanged(parsed, s, { attributes: true }); s.setAttribute('colnum', String(n - 1)); }
      }
    }
  }
  markChanged(parsed, tg, { attributes: true });
  tg.setAttribute('cols', String(grid.cols - 1));
  return keep ? pathOf(keep) : pathOf(cell.rowEl);
}

// Column widths as the colspecs hold them ('' where none), and setting them ('2*', '30mm', ...).
export const COLWIDTH = /^(\d+(\.\d+)?\*|\d+(\.\d+)?(mm|cm|pt|pi|in))$/;

export function columnWidths(doc, path) {
  const tg = up(elementAt(doc, path), 'tgroup');
  const grid = tg && tableGrid(tg);
  if (!grid) return null;
  const specs = elementChildren(tg).filter((c) => c.nodeName === 'colspec');
  return grid.names.map((n, i) => {
    const s = (n && specs.find((x) => x.getAttribute('colname') === n)) || (!n ? specs[i] : null);
    return (s && s.getAttribute('colwidth')) || '';
  });
}

export function setColumnWidths(parsed, path, widths) {
  const tg = up(elementAt(parsed.doc, path), 'tgroup');
  const grid = tg && tableGrid(tg);
  if (!grid || widths.length !== grid.cols || widths.some((w) => w && !COLWIDTH.test(w))) return null;
  const names = ensureColNames(parsed, tg, grid);
  const specs = specsByColumn(tg, names);
  widths.forEach((w, i) => {
    const s = specs[i];
    if (!s || (s.getAttribute('colwidth') || '') === w) return;
    markChanged(parsed, s, { attributes: true });
    if (w) s.setAttribute('colwidth', w); else s.removeAttribute('colwidth');
  });
  return pathOf(up(tg, 'table') || tg);
}

// ---- references -----------------------------------------------------------------------------

/*
  A data module reference with, optionally, the target's issue
  (dmRefIdent/issueInfo) and title (dmRefAddressItems/dmTitle), from the
  target module's own identification.
*/
export function fullDmRefSpec(base, ident, { withTitle, withIssue }) {
  if (!base) return null;
  const refIdent = base.children[0];
  if (withIssue && ident && ident.issueNumber && ident.inWork) refIdent.children.push({ name: 'issueInfo', attrs: { issueNumber: ident.issueNumber, inWork: ident.inWork } });
  if (withTitle && ident && ident.techName) {
    base.children.push({ name: 'dmRefAddressItems', children: [{ name: 'dmTitle', children: [
      { name: 'techName', children: [ident.techName] },
      ...(ident.infoName ? [{ name: 'infoName', children: [ident.infoName] }] : []),
    ] }] });
  }
  return base;
}

// A publication module reference (pmRef/pmRefIdent/pmCode), optionally with its title.
const PMC = ['modelIdentCode', 'pmIssuer', 'pmNumber', 'pmVolume'];
export function pmCodeOf(xml) {
  const m = /<pmCode\b([^>]*)\/?>/.exec(String(xml || ''));
  if (!m) return null;
  const attrs = {};
  for (const k of PMC) {
    const a = new RegExp(`\\b${k}\\s*=\\s*["']([^"']*)["']`).exec(m[1]);
    if (!a || !a[1]) return null;
    attrs[k] = a[1];
  }
  const t = /<pmTitle>([^<]*)<\/pmTitle>/.exec(String(xml));
  return { attrs, title: t ? t[1].trim() : '', label: `PMC-${PMC.map((k) => attrs[k]).join('-')}` };
}

export const pmRefSpec = (pm, { withTitle }) => ({
  name: 'pmRef',
  children: [
    { name: 'pmRefIdent', children: [{ name: 'pmCode', attrs: pm.attrs }] },
    ...(withTitle && pm.title ? [{ name: 'pmRefAddressItems', children: [{ name: 'pmTitle', children: [pm.title] }] }] : []),
  ],
});

// ---- find and replace -----------------------------------------------------------------------

/*
  Every occurrence of `query` in the module's content text (not the
  identification section, which has its own dialog), in document order:
  [{ path, nodeIndex, start, end, context }]. Matching is on the text as the
  page shows it; an ISO entity reads as &name;.
*/
export function findText(doc, query, { matchCase = false } = {}) {
  if (!query) return [];
  const content = doc.getElementsByTagName('content')[0];
  if (!content) return [];
  const q = matchCase ? query : query.toLowerCase();
  const out = [];
  const walk = (el) => {
    Array.from(el.childNodes).forEach((n, i) => {
      if (n.nodeType === 1) { walk(n); return; }
      if (n.nodeType !== 3 || isWs(n.data)) return;
      const text = displayText(n.data);
      const hay = matchCase ? text : text.toLowerCase();
      for (let at = hay.indexOf(q); at !== -1; at = hay.indexOf(q, at + q.length)) {
        out.push({ path: pathOf(el), nodeIndex: i, start: at, end: at + q.length, context: text.slice(Math.max(0, at - 30), at + q.length + 30) });
      }
    });
  };
  walk(content);
  return out;
}

// Replace matches (from findText on the same text); returns how many were replaced.
export function replaceMatches(parsed, matches, replacement) {
  const byNode = new Map();
  for (const m of matches) {
    const el = elementAt(parsed.doc, m.path);
    const node = el && el.childNodes[m.nodeIndex];
    if (!node || node.nodeType !== 3) continue;
    if (!byNode.has(node)) byNode.set(node, []);
    byNode.get(node).push(m);
  }
  let n = 0;
  for (const [node, ms] of byNode) {
    let text = displayText(node.data);
    for (const m of ms.sort((a, b) => b.start - a.start)) { text = text.slice(0, m.start) + replacement + text.slice(m.end); n++; }
    const v = protectText(text);
    if (v !== node.data) { node.data = v; markTextChanged(parsed, node); }
  }
  return n;
}

// ---- counts, ids, indentation -----------------------------------------------------------------

export function wordCount(doc) {
  const content = doc.getElementsByTagName('content')[0];
  const text = content ? content.textContent.replace(/\s+/g, ' ').trim() : '';
  const count = (name) => (content ? content.getElementsByTagName(name).length : 0);
  return {
    words: text ? text.split(' ').length : 0,
    characters: text.replace(/ /g, '').length,
    paragraphs: count('para') + count('notePara') + count('warningAndCautionPara'),
    sections: count('levelledPara'), steps: count('proceduralStep'), figures: count('figure'), tables: count('table'),
  };
}

const ID_PREFIX = { figure: 'fig', table: 'tab', graphic: 'gra', multimedia: 'mma', hotspot: 'hot', levelledPara: 'par', proceduralStep: 'stp' };
export const RESEQUENCE_KINDS = ['figure', 'table', 'graphic', 'multimedia', 'hotspot'];

/*
  Re-number the ids of every <kind> in document order (fig-0001, fig-0002 ...)
  and every internalRefId that pointed at an old id, so references keep
  their targets. Refused (null) when a new id is already used by another
  element. Returns { changed } (how many ids changed).
*/
export function resequenceIds(parsed, kind) {
  const prefix = ID_PREFIX[kind];
  if (!prefix) return null;
  const els = Array.from(parsed.doc.getElementsByTagName(kind));
  const map = new Map();
  const next = els.map((el, i) => `${prefix}-${String(i + 1).padStart(4, '0')}`);
  const mine = new Set(els);
  const taken = new Map();
  const walk = (el) => { if (el.getAttribute('id') && !mine.has(el)) taken.set(el.getAttribute('id'), el); elementChildren(el).forEach(walk); };
  walk(parsed.doc.documentElement);
  if (next.some((id) => taken.has(id))) return null;
  let changed = 0;
  els.forEach((el, i) => {
    const old = el.getAttribute('id');
    if (old === next[i]) return;
    if (old) map.set(old, next[i]);
    markChanged(parsed, el, { attributes: true });
    el.setAttribute('id', next[i]);
    changed++;
  });
  if (map.size) {
    for (const ref of Array.from(parsed.doc.getElementsByTagName('*'))) {
      for (const a of ['internalRefId']) {
        const v = ref.getAttribute(a);
        if (v && map.has(v)) { markChanged(parsed, ref, { attributes: true }); ref.setAttribute(a, map.get(v)); }
      }
    }
  }
  return { changed };
}

// Give an id to every figure, table, section and step that has none. Returns how many were given.
export function assignIds(parsed, model) {
  const ids = allIds(parsed.doc);
  let given = 0;
  for (const kind of Object.keys(TARGET_TYPE).filter((k) => ID_PREFIX[k])) {
    if (!('id' in model.attributesOf(kind))) continue;
    for (const el of Array.from(parsed.doc.getElementsByTagName(kind))) {
      if (el.getAttribute('id')) continue;
      let n = 1;
      while (ids.has(`${ID_PREFIX[kind]}-${String(n).padStart(4, '0')}`)) n++;
      const id = `${ID_PREFIX[kind]}-${String(n).padStart(4, '0')}`;
      ids.add(id);
      markChanged(parsed, el, { attributes: true });
      el.setAttribute('id', id);
      given++;
    }
  }
  return given;
}

/*
  Re-indent: the white space between the children of elements that hold no
  text of their own becomes one child per line, indented by depth. Text, and
  everything inside an element that holds text (or xml:space="preserve"), is
  left exactly as it is. Returns how many elements changed.
*/
export function reindent(parsed, model, unit = '  ') {
  const doc = parsed.doc;
  let changed = 0;
  const walk = (el, depth) => {
    if (model.holdsText(el.nodeName) || el.getAttribute('xml:space') === 'preserve') return;
    const nodes = Array.from(el.childNodes);
    if (nodes.some((n) => (n.nodeType === 3 && !isWs(n.data)) || n.nodeType === 4)) return;
    const kids = nodes.filter((n) => n.nodeType !== 3);
    if (!kids.length) return;
    const inner = `\n${unit.repeat(depth + 1)}`;
    const outer = `\n${unit.repeat(depth)}`;
    // The white space before each child, and after the last.
    const runs = [];
    let ws = '';
    for (const n of nodes) { if (n.nodeType === 3) ws += n.data; else { runs.push(ws); ws = ''; } }
    runs.push(ws);
    const same = runs.every((r, i) => r === (i === kids.length ? outer : inner));
    if (!same) {
      markChanged(parsed, el);
      for (const n of nodes) if (n.nodeType === 3) el.removeChild(n);
      for (const k of kids) el.insertBefore(doc.createTextNode(inner), k);
      el.appendChild(doc.createTextNode(outer));
      changed++;
    }
    for (const k of kids) if (k.nodeType === 1) walk(k, depth + 1);
  };
  walk(doc.documentElement, 0);
  return changed;
}

// ---- live checks ------------------------------------------------------------------------------

/*
  Faults the page can show while the author types, before any validation:
  a graphic with no ICN, or one whose ICN is not declared in the DOCTYPE
  (the schema check fails on it), a reference to an id that is not in the
  module, an id used twice, and an empty title. Each { path, sev, message }.
*/
export function liveChecks(parsed) {
  const doc = parsed.doc;
  const out = [];
  const ids = new Map();
  const declared = new Set();
  for (const m of String(parsed.prolog || '').matchAll(/<!ENTITY\s+(\S+)\s+SYSTEM/gi)) declared.add(m[1]);
  const walk = (el, path) => {
    const id = el.getAttribute('id');
    if (id) { if (ids.has(id)) out.push({ path, sev: 'error', message: `The id ${id} is used twice.` }); else ids.set(id, path); }
    elementChildren(el).forEach((c, i) => walk(c, [...path, i]));
  };
  walk(doc.documentElement, []);
  const at = (el) => pathOf(el);
  for (const g of [...Array.from(doc.getElementsByTagName('graphic')), ...Array.from(doc.getElementsByTagName('symbol'))]) {
    const icn = g.getAttribute('infoEntityIdent');
    if (!icn) out.push({ path: at(g), sev: 'error', message: `This ${g.nodeName} has no ICN.` });
    else if (!declared.has(icn)) out.push({ path: at(g), sev: 'error', message: `${icn} is not declared in the DOCTYPE; insert the figure again from the Figure dialog, or declare it in the XML view.` });
  }
  for (const r of Array.from(doc.getElementsByTagName('internalRef'))) {
    const id = r.getAttribute('internalRefId');
    if (!id || !ids.has(id)) out.push({ path: at(r), sev: 'error', message: `This reference points to ${id || 'nothing'}, which is not in this module.` });
  }
  const content = doc.getElementsByTagName('content')[0];
  for (const t of content ? Array.from(content.getElementsByTagName('title')) : []) {
    if (isWs(t.textContent) && !elementChildren(t).length) out.push({ path: at(t), sev: 'warning', message: 'This title is empty; it prints as a blank line.' });
  }
  return out;
}

// ---- splitting and joining text blocks ----------------------------------------------------------

/*
  Enter in the middle of a paragraph: what follows the caret (the rest of
  text node `nodeIndex` from `offset`, in the text as the page shows it, and
  every node after it) moves to the end of `into`. Nothing is dropped.
*/
export function moveTail(parsed, el, nodeIndex, offset, into) {
  const doc = parsed.doc;
  const nodes = Array.from(el.childNodes);
  const node = nodes[nodeIndex];
  markChanged(parsed, el);
  markChanged(parsed, into);
  let from = nodeIndex;
  if (node && node.nodeType === 3) {
    const text = displayText(node.data);
    const after = text.slice(offset);
    const before = protectText(text.slice(0, offset));
    if (before !== node.data) { node.data = before; markTextChanged(parsed, node); }
    if (after) into.appendChild(doc.createTextNode(protectText(after)));
    from = nodeIndex + 1;
  }
  for (const n of nodes.slice(from)) {
    // The indentation before the closing tag stays with the element it belongs to.
    if (n === el.lastChild && n.nodeType === 3 && /^\s*\n\s*$/.test(n.data)) continue;
    into.appendChild(n);
  }
  if (node && node.nodeType === 3 && !node.data && el.childNodes.length > 1) el.removeChild(node);
}

/*
  Split the text block at `path` at the caret: the second half becomes a new
  element after it (`name`, at the place `slot` names, by default one more of
  the same kind right after it). Returns the new element's path, or null when
  that element cannot go there (then nothing changed).
*/
export function splitBlock(parsed, model, path, nodeIndex, offset, { name, slot, wrap } = {}) {
  const el = elementAt(parsed.doc, path);
  const kind = name || el.nodeName;
  const at = slot || { parentPath: path.slice(0, -1), index: path[path.length - 1] + 1 };
  const parent = elementAt(parsed.doc, at.parentPath);
  const outer = wrap || kind;
  if (!model.insertableAt(parent.nodeName, childNames(parent), at.index).includes(outer)) return null;
  const fresh = parsed.doc.createElement(kind);
  moveTail(parsed, el, nodeIndex, offset, fresh);
  let top = fresh;
  if (wrap) { top = parsed.doc.createElement(wrap); top.appendChild(fresh); }
  const placed = placeElement(parsed, parent, at.index, top);
  return wrap ? [...placed, 0] : placed;
}

// What Backspace at the very start of a text block can do: 'remove' an empty block, 'join' it to the one before, or nothing.
export function backspaceAction(doc, model, path, PARA_LIKE) {
  if (!path || !path.length) return null;
  const el = elementAt(doc, path);
  if (!el || !PARA_LIKE.has(el.nodeName)) return null;
  const parent = el.parentNode;
  const empty = isWs(el.textContent) && !elementChildren(el).length;
  const i = path[path.length - 1];
  const okWithout = () => { const n = childNames(parent); n.splice(i, 1); return model.isValidSequence(parent.nodeName, n) || !model.isValidSequence(parent.nodeName, childNames(parent)); };
  const prev = prevElement(el);
  const between = (() => { for (let n = el.previousSibling; n && n !== prev; n = n.previousSibling) if (n.nodeType !== 3 || !isWs(n.data)) return true; return false; })();
  if (prev && prev.nodeName === el.nodeName && !between && okWithout()) return { kind: empty ? 'remove' : 'join', prev };
  if (empty && okWithout()) return { kind: 'remove', prev: null };
  // An empty bullet: the bullet goes (when the list keeps one).
  if (empty && parent.nodeName === 'listItem' && elementChildren(parent).length === 1) {
    const list = parent.parentNode;
    if (elementChildren(list).filter((c) => c.nodeName === 'listItem').length > 1) return { kind: 'removeItem', prev: prevElement(parent) };
  }
  return null;
}

/*
  Backspace at the start of a block. Returns where the caret goes:
  { path, focus: { nodeIndex, offset } | 'end' }, or null.
*/
export function backspaceAtStart(parsed, model, path, PARA_LIKE) {
  const a = backspaceAction(parsed.doc, model, path, PARA_LIKE);
  if (!a) return null;
  const el = elementAt(parsed.doc, path);
  if (a.kind === 'removeItem') {
    const item = el.parentNode;
    detach(parsed, item);
    return a.prev ? { path: pathOf(a.prev), focus: 'end' } : { path: pathOf(item.parentNode || parsed.doc.documentElement), focus: 'end' };
  }
  if (a.kind === 'remove') {
    detach(parsed, el);
    return a.prev ? { path: pathOf(a.prev), focus: 'end' } : null;
  }
  // Join: the block's content follows the previous block's; the caret stands at the join.
  const prev = a.prev;
  const kids = Array.from(prev.childNodes);
  let last = kids.length - 1;
  while (last >= 0 && kids[last].nodeType === 3 && /^\s*\n\s*$/.test(kids[last].data)) last--;
  const lastNode = kids[last];
  const caret = lastNode && lastNode.nodeType === 3 ? { nodeIndex: last, offset: displayText(lastNode.data).length } : { nodeIndex: last + 1, offset: 0 };
  markChanged(parsed, prev);
  const ref = kids[last + 1] || null;
  for (const n of Array.from(el.childNodes)) prev.insertBefore(n, ref);
  detach(parsed, el);
  return { path: pathOf(prev), focus: caret };
}

// ---- rows in tables with merged cells ----------------------------------------------------------

/*
  A row above (-1) or below (+1) the cell at `path`. A cell spanning down
  across the new row's place spans it too; every other column gets a new
  cell (named by colname when some columns are covered, so it lands right).
*/
export function addRowSpanned(parsed, path, where) {
  const at = cellAt(parsed.doc, path);
  if (!at) return null;
  const { cell, tg } = at;
  const k = where < 0 ? cell.r : cell.r + cell.rows;
  const crossing = at.grid.cells.filter((x) => x.section === cell.section && x.r < k && x.r + x.rows - 1 >= k);
  const covered = new Set();
  for (const x of crossing) for (let c = x.start; c <= x.end; c++) covered.add(c);
  const names = covered.size ? ensureColNames(parsed, tg, at.grid) : at.grid.names;
  for (const x of crossing) { markChanged(parsed, x.entry, { attributes: true }); x.entry.setAttribute('morerows', String(x.rows)); }
  const entries = [];
  for (let c = 0; c < at.grid.cols; c++) if (!covered.has(c)) entries.push({ name: 'entry', attrs: covered.size ? { colname: names[c] } : {}, children: [{ name: 'para', children: [] }] });
  const row = build(parsed.doc, { name: 'row', children: entries });
  const section = cell.section;
  const next = cell.sectionRows[k];
  const index = next ? elementChildren(section).indexOf(next) : elementChildren(section).length;
  const placed = placeElement(parsed, section, index, row);
  return elementChildren(row).length ? [...placed, 0] : placed;
}

/*
  Delete the row of the cell at `path` (its first row, for a cell spanning
  down). Cells spanning into it from above lose a row; a cell that starts in
  it and spans down moves, with its content, to the next row. Nothing else
  in the table is touched; a header or body is never left without a row.
*/
export function deleteRowSpanned(parsed, path) {
  const at = cellAt(parsed.doc, path);
  if (!at) return null;
  const { cell, tg } = at;
  const r = cell.r;
  const rows = cell.sectionRows;
  if (rows.length <= 1) return null;
  const rowEl = rows[r];
  const inSection = at.grid.cells.filter((x) => x.section === cell.section);
  const moving = inSection.filter((x) => x.r === r && x.rows > 1);
  const names = moving.length ? ensureColNames(parsed, tg, at.grid) : at.grid.names;
  for (const x of inSection.filter((y) => y.r < r && y.r + y.rows - 1 >= r)) {
    markChanged(parsed, x.entry, { attributes: true });
    if (x.rows - 2 > 0) x.entry.setAttribute('morerows', String(x.rows - 2)); else x.entry.removeAttribute('morerows');
  }
  const nextRow = rows[r + 1];
  for (const x of moving.sort((a, b) => b.start - a.start)) {
    const e = x.entry;
    detach(parsed, e);
    markChanged(parsed, e, { attributes: true });
    if (x.rows - 2 > 0) e.setAttribute('morerows', String(x.rows - 2)); else e.removeAttribute('morerows');
    if (x.start === x.end) { e.removeAttribute('namest'); e.removeAttribute('nameend'); e.setAttribute('colname', names[x.start]); }
    const after = inSection.filter((y) => y.rowEl === nextRow && y.start > x.start).map((y) => y.entry);
    const own = elementChildren(nextRow);
    const before = own.findIndex((y) => after.includes(y));
    placeElement(parsed, nextRow, before === -1 ? own.length : before, e);
  }
  detach(parsed, rowEl);
  const target = nextRow || rows[r - 1];
  return target && elementChildren(target).length ? pathOf(elementChildren(target)[0]) : pathOf(cell.section);
}

// ---- changing an element into another; duplicating ----------------------------------------------

/*
  What the element at `path` can become, keeping the parent valid:
  'change' keeps its content and attributes the new element allows (a
  bulleted list becomes a numbered one); 'replace' puts a new element in its
  place, and is offered only for an element with no content of its own
  (the "None" markers of requirements), so nothing is ever discarded.
*/
export function replacements(doc, model, path) {
  if (!path || !path.length) return [];
  const el = elementAt(doc, path);
  const parent = el && el.parentNode;
  if (!el || !parent || parent.nodeType !== 1 || model.holdsText(el.nodeName) && model.holdsText(parent.nodeName)) return [];
  const names = childNames(parent);
  const i = path[path.length - 1];
  const wasValid = model.isValidSequence(parent.nodeName, names);
  const kids = childNames(el);
  const hasText = Array.from(el.childNodes).some((n) => (n.nodeType === 3 && !isWs(n.data)) || n.nodeType === 4);
  const empty = !kids.length && !hasText;
  const out = [];
  for (const c of model.allowedChildren(parent.nodeName).sort()) {
    if (c === el.nodeName || !model.isKnown(c)) continue;
    const next = names.slice(); next[i] = c;
    if (!(model.isValidSequence(parent.nodeName, next) || (!wasValid && model.canExtend(parent.nodeName, next)))) continue;
    if (!hasText && kids.length && model.isValidSequence(c, kids)) out.push({ name: c, kind: 'change' });
    else if (hasText && model.holdsText(c) && model.holdsText(el.nodeName)) out.push({ name: c, kind: 'change' });
    else if (empty) out.push({ name: c, kind: 'replace' });
  }
  return out.slice(0, 12);
}

export function replaceElement(parsed, model, path, name) {
  const choice = replacements(parsed.doc, model, path).find((x) => x.name === name);
  if (!choice) return null;
  const el = elementAt(parsed.doc, path);
  const parent = el.parentNode;
  let next;
  if (choice.kind === 'change') {
    next = parsed.doc.createElement(name);
    const allowed = model.attributesOf(name);
    for (const a of Array.from(el.attributes)) if (a.name in allowed || /^xmlns|^xsi:/.test(a.name)) next.setAttribute(a.name, a.value);
    for (const n of Array.from(el.childNodes)) next.appendChild(n);
  } else {
    next = createElementFilled(parsed.doc, name, model);
  }
  markChanged(parsed, parent);
  parent.replaceChild(next, el);
  return pathOf(next);
}

// A copy of the element, with its content, just after it; ids in the copy are made unique.
export function duplicate(parsed, model, path) {
  if (!canAddSibling(parsed.doc, model, path)) return null;
  const el = elementAt(parsed.doc, path);
  const copy = el.cloneNode(true);
  const ids = allIds(parsed.doc);
  const fix = (e) => {
    const id = e.getAttribute('id');
    if (id) { let n = 2; while (ids.has(`${id}-${n}`)) n++; e.setAttribute('id', `${id}-${n}`); ids.add(`${id}-${n}`); }
    elementChildren(e).forEach(fix);
  };
  fix(copy);
  return placeElement(parsed, el.parentNode, path[path.length - 1] + 1, copy);
}

// Data module references whose target is not a module of the project (when the project's codes are known).
export function unresolvedDmRefs(doc, codes, own) {
  if (!codes || !codes.size) return [];
  const out = [];
  // References in the content (the identification's BREX reference points outside the project by design).
  const content = doc.getElementsByTagName('content')[0];
  for (const r of content ? Array.from(content.getElementsByTagName('dmRef')) : []) {
    const c = r.getElementsByTagName('dmCode')[0];
    if (!c) continue;
    const v = (k) => c.getAttribute(k) || '';
    const code = `${v('modelIdentCode')}-${v('systemDiffCode')}-${v('systemCode')}-${v('subSystemCode')}${v('subSubSystemCode')}-${v('assyCode')}-${v('disassyCode')}${v('disassyCodeVariant')}-${v('infoCode')}${v('infoCodeVariant')}-${v('itemLocationCode')}`;
    if (code !== own && !codes.has(code)) out.push({ path: pathOf(r), sev: 'warning', message: `DMC-${code} is not a data module of this project.` });
  }
  return out;
}

// The target's issue added to a data module reference already in the text (dmRefIdent/issueInfo, after dmCode).
export function addRefIssue(parsed, path, issue) {
  const ref = elementAt(parsed.doc, path);
  if (!ref || ref.nodeName !== 'dmRef' || !issue || !/^\d{3}$/.test(issue.issueNumber || '') || !/^\d{2}$/.test(issue.inWork || '')) return false;
  const ident = elementChildren(ref).find((c) => c.nodeName === 'dmRefIdent');
  if (!ident || elementChildren(ident).some((c) => c.nodeName === 'issueInfo')) return false;
  const code = elementChildren(ident).findIndex((c) => c.nodeName === 'dmCode');
  if (code === -1) return false;
  placeElement(parsed, ident, code + 1, build(parsed.doc, { name: 'issueInfo', attrs: { issueNumber: issue.issueNumber, inWork: issue.inWork } }), { block: false });
  return pathOf(ref);
}
