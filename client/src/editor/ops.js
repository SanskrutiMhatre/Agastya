// Editing operations of the page view (checkpoint 2d, decisions.md PV4-PV7):
// formatting, references, figures, tables, lists and ids. Pure functions over
// the parsed document of xmlDoc.js, so they run in the browser and in Node
// tests. Each records what it changed (markChanged), so the serialiser
// rewrites only that; each returns the path to select afterwards, or null.
// The page view offers an operation only where the S1000D content model
// allows its result; the operations themselves build only valid shapes.

import { elementAt, elementChildren, childNames, pathOf, markChanged, markTextChanged, protectText } from './xmlDoc.js';

// ---- building elements ---------------------------------------------------------

/*
  Build an element tree from a spec:
    { name, attrs?: { a: v }, children?: [spec | string] }
  Strings become text (ISO entity names typed as &name; are kept as references).
*/
export function build(doc, spec) {
  if (typeof spec === 'string') return doc.createTextNode(protectText(spec));
  const el = doc.createElement(spec.name);
  for (const [k, v] of Object.entries(spec.attrs || {})) if (v !== undefined && v !== null && v !== '') el.setAttribute(k, String(v));
  for (const c of spec.children || []) el.appendChild(build(doc, c));
  return el;
}

// The indentation used before an element's existing element children.
function indentOf(parent) {
  for (const n of Array.from(parent.childNodes)) if (n.nodeType === 3 && /^\s*\n[ \t]*$/.test(n.data)) return n.data;
  return null;
}

// Put `el` as element child `index` of `parent`, with the parent's indentation when it is a block container.
function placeElement(parsed, parent, index, el, { block = true } = {}) {
  const kids = elementChildren(parent);
  const ref = kids[index] || null;
  const ws = block ? indentOf(parent) : null;
  markChanged(parsed, parent);
  if (ref) {
    parent.insertBefore(el, ref);
    if (ws) parent.insertBefore(parsed.doc.createTextNode(ws), ref);
  } else {
    const last = parent.lastChild;
    if (ws && last && last.nodeType === 3 && /^\s+$/.test(last.data)) {
      parent.insertBefore(parsed.doc.createTextNode(ws), last);
      parent.insertBefore(el, last);
    } else parent.appendChild(el);
  }
  return pathOf(el);
}

// Insert a built block element as element child `index` of the element at `parentPath`.
export function insertBlock(parsed, parentPath, index, spec) {
  return placeElement(parsed, elementAt(parsed.doc, parentPath), index, build(parsed.doc, spec));
}

// Insert a built inline element into text: at `offset` of child node `nodeIndex` of the element at `path`.
export function insertInlineSpec(parsed, path, nodeIndex, offset, spec) {
  const parent = elementAt(parsed.doc, path);
  const node = parent.childNodes[nodeIndex];
  const el = build(parsed.doc, spec);
  markChanged(parsed, parent);
  if (node && node.nodeType === 3) {
    const after = node.data.slice(offset);
    node.data = node.data.slice(0, offset);
    markTextChanged(parsed, node);
    const next = node.nextSibling;
    parent.insertBefore(el, next);
    if (after) parent.insertBefore(parsed.doc.createTextNode(after), next);
  } else parent.insertBefore(el, node || null);
  return pathOf(el);
}

// How many element children come before child node `nodeIndex` (the content-model position of a caret).
export const elementIndexAt = (el, nodeIndex) => Array.from(el.childNodes).slice(0, nodeIndex).filter((n) => n.nodeType === 1).length;

// ---- formatting ----------------------------------------------------------------------

// Emphasis kinds offered by the toolbar (S1000D 4.2: em01 bold, em02 italic, em03 underline, em05 strike).
export const FORMATS = {
  bold: { name: 'emphasis', attrs: {} },
  italic: { name: 'emphasis', attrs: { emphasisType: 'em02' } },
  underline: { name: 'emphasis', attrs: { emphasisType: 'em03' } },
  strike: { name: 'emphasis', attrs: { emphasisType: 'em05' } },
  verbatim: { name: 'verbatimText', attrs: {} },
  subscript: { name: 'subScript', attrs: {} },
  superscript: { name: 'superScript', attrs: {} },
};

/*
  Wrap characters [start, end) of text node `nodeIndex` of the element at
  `path` in a new inline element (a format). Returns the new element's path.
*/
export function wrapText(parsed, path, nodeIndex, start, end, spec) {
  const parent = elementAt(parsed.doc, path);
  const node = parent.childNodes[nodeIndex];
  if (!node || node.nodeType !== 3 || start >= end) return null;
  const text = node.data;
  const el = build(parsed.doc, { ...spec, children: [] });
  el.appendChild(parsed.doc.createTextNode(text.slice(start, end)));
  const next = node.nextSibling;
  node.data = text.slice(0, start);
  markTextChanged(parsed, node);
  parent.insertBefore(el, next);
  if (end < text.length) parent.insertBefore(parsed.doc.createTextNode(text.slice(end)), next);
  if (!node.data) parent.removeChild(node);
  markChanged(parsed, parent);
  return pathOf(el);
}

// Remove an inline element but keep what it holds (clearing a format). Returns the parent's path.
export function unwrap(parsed, path) {
  const el = elementAt(parsed.doc, path);
  const parent = el.parentNode;
  markChanged(parsed, parent);
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
  parent.normalize();
  // normalize() merged text nodes: they are new text now.
  for (const n of Array.from(parent.childNodes)) if (n.nodeType === 3) markTextChanged(parsed, n);
  return pathOf(parent);
}

// ---- ids and reference targets --------------------------------------------------------

const PREFIX = { figure: 'fig', table: 'tab', levelledPara: 'par', proceduralStep: 'stp', para: 'par', multimedia: 'mma' };

export function allIds(doc) {
  const ids = new Set();
  const walk = (el) => { if (el.getAttribute('id')) ids.add(el.getAttribute('id')); elementChildren(el).forEach(walk); };
  walk(doc.documentElement);
  return ids;
}

// Give the element at `path` an id if it has none (fig-0001, tab-0002 ...); returns the id.
export function ensureId(parsed, path) {
  const el = elementAt(parsed.doc, path);
  if (el.getAttribute('id')) return el.getAttribute('id');
  const ids = allIds(parsed.doc);
  const prefix = PREFIX[el.nodeName] || 'id';
  let n = 1;
  while (ids.has(`${prefix}-${String(n).padStart(4, '0')}`)) n++;
  const id = `${prefix}-${String(n).padStart(4, '0')}`;
  markChanged(parsed, el, { attributes: true });
  el.setAttribute('id', id);
  return id;
}

// S1000D internalRefTargetType for what is referred to.
export const TARGET_TYPE = { figure: 'irtt01', table: 'irtt02', levelledPara: 'irtt07', para: 'irtt07', proceduralStep: 'irtt08', graphic: 'irtt09', multimedia: 'irtt03' };

const firstTitle = (el) => {
  const t = elementChildren(el).find((c) => c.nodeName === 'title');
  return t ? t.textContent.replace(/\s+/g, ' ').trim() : '';
};

/*
  What can be referred to in this module, numbered as the page shows them:
  figures (Fig 1 ...), tables (Table 1 ...), levelled paragraphs (1, 1.2 ...)
  and procedural steps (Step 1, 1.2 ...). Each { path, id, kind, label, title }.
*/
export function referenceTargets(doc) {
  const out = [];
  let fig = 0;
  let tab = 0;
  const walk = (el, path, para, step) => {
    let p = 0;
    let s = 0;
    elementChildren(el).forEach((c, i) => {
      const cp = [...path, i];
      if (c.nodeName === 'figure') { fig++; out.push({ path: cp, id: c.getAttribute('id') || null, kind: 'figure', label: `Fig ${fig}`, title: firstTitle(c) }); }
      if (c.nodeName === 'table') { tab++; out.push({ path: cp, id: c.getAttribute('id') || null, kind: 'table', label: `Table ${tab}`, title: firstTitle(c) }); }
      if (c.nodeName === 'levelledPara') {
        p++;
        const num = [...para, p];
        out.push({ path: cp, id: c.getAttribute('id') || null, kind: 'levelledPara', label: `Para ${num.join('.')}`, title: firstTitle(c) });
        walk(c, cp, num, step);
        return;
      }
      if (c.nodeName === 'proceduralStep') {
        s++;
        const num = [...step, s];
        const text = (elementChildren(c).find((x) => x.nodeName === 'para') || c).textContent.replace(/\s+/g, ' ').trim();
        out.push({ path: cp, id: c.getAttribute('id') || null, kind: 'proceduralStep', label: `Step ${num.join('.')}`, title: firstTitle(c) || text.slice(0, 80) });
        walk(c, cp, para, num);
        return;
      }
      walk(c, cp, para, step);
    });
    void p; void s;
  };
  walk(doc.documentElement, [], [], []);
  return out;
}

// The label a reference shows for an id (Fig 2, Table 1, Para 1.2), or null.
export function labelFor(targets, id) {
  const t = targets.find((x) => x.id === id);
  return t ? t.label : null;
}

// ---- reference specs ------------------------------------------------------------------

export const internalRefSpec = (target) => ({ name: 'internalRef', attrs: { internalRefId: target.id, internalRefTargetType: TARGET_TYPE[target.kind] } });

const DMC_ATTRS = ['modelIdentCode', 'systemDiffCode', 'systemCode', 'subSystemCode', 'subSubSystemCode', 'assyCode', 'disassyCode', 'disassyCodeVariant', 'infoCode', 'infoCodeVariant', 'itemLocationCode'];

// A dmRef from a data module code string (MIC-SDC-SYS-SUB SUBSUB-ASSY-DC DCV-IC ICV-ILC, as the project lists them).
export function dmRefSpec(code) {
  const m = /^([A-Z0-9]{2,14})-([A-Z0-9]{1,4})-([A-Z0-9]{2,3})-([A-Z0-9])([A-Z0-9])-([A-Z0-9]{2,4})-([A-Z0-9]{2})([A-Z0-9]{1,3})-([A-Z0-9]{3})([A-Z0-9])-([A-Z])$/.exec(String(code).replace(/^DMC-/, '').toUpperCase());
  if (!m) return null;
  const attrs = Object.fromEntries(DMC_ATTRS.map((k, i) => [k, m[i + 1]]));
  return { name: 'dmRef', children: [{ name: 'dmRefIdent', children: [{ name: 'dmCode', attrs }] }] };
}

export const externalPubRefSpec = ({ code, title }) => ({
  name: 'externalPubRef',
  children: [{ name: 'externalPubRefIdent', children: [
    ...(code ? [{ name: 'externalPubCode', children: [code] }] : []),
    ...(title ? [{ name: 'externalPubTitle', children: [title] }] : []),
  ] }],
});

// ---- figures ----------------------------------------------------------------------------

/*
  A graphic's infoEntityIdent must name an ENTITY declared in the module's
  DOCTYPE (an XSD ENTITY value). Declare one for `icn` if it is not declared
  yet: added to the internal subset (with its NOTATION if missing), a subset
  given to a DOCTYPE that has none, or a DOCTYPE written after the XML
  declaration. Only the prolog changes; the file's line ends are kept.
  `ext` is the artwork's format (png, jpg, gif). Returns true if it changed.
*/
const ICN_NAME = /^ICN-[A-Za-z0-9-]+$/;
export function declareEntity(parsed, icn, ext = 'png') {
  if (!ICN_NAME.test(icn) || !/^(png|jpg|jpeg|gif)$/.test(ext)) return false;
  const notation = ext === 'jpeg' ? 'jpg' : ext;
  const prolog = parsed.prolog;
  const nl = /\r\n/.test(prolog) ? '\r\n' : '\n';
  const declared = new RegExp(`<!ENTITY\\s+${icn.replace(/-/g, '\\-')}\\s`, 'i');
  if (declared.test(prolog)) return false;
  const root = parsed.doc.documentElement.nodeName;
  const entity = `<!ENTITY ${icn} SYSTEM "${icn}.${notation}" NDATA ${notation}>`;
  const withNotation = (subset) => (new RegExp(`<!NOTATION\\s+${notation}\\s`).test(subset) ? '' : `<!NOTATION ${notation} SYSTEM "${notation}">${nl}`);
  const dt = /<!DOCTYPE\s+[^\s[>]+(?:\s+(?:SYSTEM|PUBLIC)\s+(?:"[^"]*"|'[^']*')(?:\s+(?:"[^"]*"|'[^']*'))?)?\s*(\[([\s\S]*?)\])?\s*>/.exec(prolog);
  if (dt && dt[1] !== undefined) {
    const close = dt.index + dt[0].lastIndexOf(']');
    const subset = dt[2];
    const lead = subset.endsWith('\n') ? '' : nl;
    parsed.prolog = `${prolog.slice(0, close)}${lead}${withNotation(subset)}${entity}${nl}${prolog.slice(close)}`;
  } else if (dt) {
    const end = dt.index + dt[0].length - 1; // the closing '>'
    parsed.prolog = `${prolog.slice(0, end).replace(/\s*$/, '')} [${nl}${withNotation('')}${entity}${nl}]${prolog.slice(end)}`;
  } else {
    const decl = /^(\uFEFF?<\?xml[\s\S]*?\?>)(\r?\n)?/.exec(prolog);
    const at = decl ? decl[0].length : (prolog.startsWith('\uFEFF') ? 1 : 0);
    const before = prolog.slice(0, at);
    parsed.prolog = `${before}${decl && !decl[2] ? nl : ''}<!DOCTYPE ${root} [${nl}${withNotation('')}${entity}${nl}]>${nl}${prolog.slice(at)}`;
  }
  return true;
}

export const figureSpec = ({ id, title, icn }) => ({ name: 'figure', attrs: { id }, children: [{ name: 'title', children: [title || 'Figure'] }, { name: 'graphic', attrs: { infoEntityIdent: icn } }] });

// ---- tables (CALS) ----------------------------------------------------------------------

const cell = (text = '') => ({ name: 'entry', children: [{ name: 'para', children: text ? [text] : [] }] });

// A new table: an optional title, `cols` columns with colspecs, an optional header row, `rows` body rows.
export function tableSpec({ id, title, rows, cols, header }) {
  const colspecs = Array.from({ length: cols }, (_, i) => ({ name: 'colspec', attrs: { colname: `col${i + 1}` } }));
  const row = () => ({ name: 'row', children: Array.from({ length: cols }, () => cell()) });
  return {
    name: 'table', attrs: { id },
    children: [
      ...(title ? [{ name: 'title', children: [title] }] : []),
      { name: 'tgroup', attrs: { cols: String(cols) }, children: [
        ...colspecs,
        ...(header ? [{ name: 'thead', children: [row()] }] : []),
        { name: 'tbody', children: Array.from({ length: rows }, row) },
      ] },
    ],
  };
}

const up = (el, name) => { let e = el; while (e && e.nodeType === 1 && e.nodeName !== name) e = e.parentNode; return e && e.nodeType === 1 ? e : null; };

// The table cell, row and tgroup around an element (a selected entry, or anything inside one).
export function tableContext(doc, path) {
  const el = elementAt(doc, path);
  const entry = up(el, 'entry');
  const row = up(el, 'row');
  const tgroup = up(el, 'tgroup');
  if (!row || !tgroup) return null;
  const spans = Array.from(tgroup.getElementsByTagName('entry')).some((e) => e.getAttribute('namest') || e.getAttribute('nameend') || e.getAttribute('morerows') || e.getAttribute('spanname'));
  const column = entry ? elementChildren(row).filter((c) => c.nodeName === 'entry').indexOf(entry) : -1;
  return { entry, row, tgroup, column, spans, cols: Number(tgroup.getAttribute('cols')) || elementChildren(row).length };
}

// Add a row above (-1) or below (+1) the row around `path`, with as many cells as the table has columns.
export function addRow(parsed, path, where) {
  const ctx = tableContext(parsed.doc, path);
  if (!ctx) return null;
  const n = elementChildren(ctx.row).filter((c) => c.nodeName === 'entry').length || ctx.cols;
  const row = build(parsed.doc, { name: 'row', children: Array.from({ length: n }, () => cell()) });
  const body = ctx.row.parentNode;
  const index = elementChildren(body).indexOf(ctx.row) + (where > 0 ? 1 : 0);
  return placeElement(parsed, body, index, row);
}

export function deleteRow(parsed, path) {
  const ctx = tableContext(parsed.doc, path);
  if (!ctx) return null;
  const body = ctx.row.parentNode;
  if (elementChildren(body).length <= 1) return null; // a tbody needs a row
  markChanged(parsed, body);
  const prev = ctx.row.previousSibling;
  body.removeChild(ctx.row);
  if (prev && prev.nodeType === 3 && /^\s+$/.test(prev.data) && prev.previousSibling) body.removeChild(prev);
  return pathOf(body);
}

/*
  Add a column left (-1) or right (+1) of the cell at `path`: a colspec and a
  cell in every row; `cols` is updated. Refused for tables with merged cells
  (their column positions are not simple indexes).
*/
export function addColumn(parsed, path, where) {
  const ctx = tableContext(parsed.doc, path);
  if (!ctx || ctx.spans || ctx.column < 0) return null;
  const at = ctx.column + (where > 0 ? 1 : 0);
  const tg = ctx.tgroup;
  const specs = elementChildren(tg).filter((c) => c.nodeName === 'colspec');
  const names = new Set(specs.map((c) => c.getAttribute('colname')));
  let k = specs.length + 1;
  while (names.has(`col${k}`)) k++;
  if (specs.length) {
    const spec = build(parsed.doc, { name: 'colspec', attrs: { colname: `col${k}` } });
    placeElement(parsed, tg, Math.min(at, specs.length), spec);
  }
  for (const row of Array.from(tg.getElementsByTagName('row'))) {
    const entries = elementChildren(row).filter((c) => c.nodeName === 'entry');
    placeElement(parsed, row, Math.min(at, entries.length), build(parsed.doc, cell()), { block: true });
  }
  markChanged(parsed, tg, { attributes: true });
  tg.setAttribute('cols', String(ctx.cols + 1));
  return pathOf(elementChildren(ctx.row).filter((c) => c.nodeName === 'entry')[at]);
}

export function deleteColumn(parsed, path) {
  const ctx = tableContext(parsed.doc, path);
  if (!ctx || ctx.spans || ctx.column < 0 || ctx.cols <= 1) return null;
  const tg = ctx.tgroup;
  const specs = elementChildren(tg).filter((c) => c.nodeName === 'colspec');
  const drop = (parent, el) => {
    markChanged(parsed, parent);
    const prev = el.previousSibling;
    parent.removeChild(el);
    if (prev && prev.nodeType === 3 && /^\s+$/.test(prev.data) && prev.previousSibling) parent.removeChild(prev);
  };
  if (specs[ctx.column]) drop(tg, specs[ctx.column]);
  for (const row of Array.from(tg.getElementsByTagName('row'))) {
    const e = elementChildren(row).filter((c) => c.nodeName === 'entry')[ctx.column];
    if (e) drop(row, e);
  }
  markChanged(parsed, tg, { attributes: true });
  tg.setAttribute('cols', String(ctx.cols - 1));
  return pathOf(ctx.row);
}

// ---- merged cells (CALS spans) ------------------------------------------------------------

/*
  The occupancy grid of a tgroup (decisions.md PV11). A CALS entry's column is
  its colname or namest, or else the next column not yet taken in its row
  (taken by an earlier entry, or by a cell from a row above that spans down
  with morerows); nameend widens it to the right, morerows down. Spans do not
  cross thead, tbody and tfoot. Returns { cols, names, cells, rows } or null
  when the table cannot be modelled safely (a spanname, an unknown column
  name, overlapping or out-of-range cells), in which case the page view
  offers no merge or split and the XML view is the way to change it.
*/
export function tableGrid(tg) {
  const specs = elementChildren(tg).filter((c) => c.nodeName === 'colspec');
  const declared = Number(tg.getAttribute('cols'));
  const cols = Number.isInteger(declared) && declared > 0 ? declared : specs.length;
  if (!cols) return null;
  const names = Array.from({ length: cols }, () => null);
  specs.forEach((c, i) => {
    const num = Number(c.getAttribute('colnum'));
    const at = Number.isInteger(num) && num >= 1 ? num - 1 : i;
    if (at < cols) names[at] = c.getAttribute('colname') || null;
  });
  const indexOf = (name) => { const i = names.indexOf(name); return i === -1 ? null : i; };
  const cells = [];
  const rows = [];
  for (const section of elementChildren(tg).filter((c) => ['thead', 'tbody', 'tfoot'].includes(c.nodeName))) {
    const sectionRows = elementChildren(section).filter((c) => c.nodeName === 'row');
    const taken = sectionRows.map(() => new Array(cols).fill(false));
    for (let r = 0; r < sectionRows.length; r++) {
      const rowEl = sectionRows[r];
      rows.push({ rowEl, section, r });
      let cursor = 0;
      for (const e of elementChildren(rowEl).filter((c) => c.nodeName === 'entry')) {
        if (e.getAttribute('spanname')) return null;
        let start;
        if (e.getAttribute('namest')) start = indexOf(e.getAttribute('namest'));
        else if (e.getAttribute('colname')) start = indexOf(e.getAttribute('colname'));
        else { start = cursor; while (start < cols && taken[r][start]) start++; }
        const end = e.getAttribute('nameend') ? indexOf(e.getAttribute('nameend')) : start;
        const more = Number(e.getAttribute('morerows') || 0);
        if (start === null || end === null || start >= cols || end < start || end >= cols || !Number.isInteger(more) || more < 0 || r + more >= sectionRows.length) return null;
        for (let y = r; y <= r + more; y++) for (let x = start; x <= end; x++) { if (taken[y][x]) return null; taken[y][x] = true; }
        cells.push({ entry: e, rowEl, section, r, start, end, rows: more + 1, sectionRows });
        cursor = end + 1;
      }
    }
  }
  return { cols, names, cells, rows };
}

// Give every column a colname, adding colspecs where there are none (only when a span needs to name them).
function ensureColNames(parsed, tg, grid) {
  if (grid.names.every(Boolean)) return grid.names;
  const specs = elementChildren(tg).filter((c) => c.nodeName === 'colspec');
  const used = new Set(grid.names.filter(Boolean));
  const fresh = () => { let k = 1; while (used.has(`col${k}`)) k++; used.add(`col${k}`); return `col${k}`; };
  const names = grid.names.slice();
  for (let i = 0; i < grid.cols; i++) {
    if (names[i]) continue;
    names[i] = fresh();
    if (specs[i] && !specs[i].getAttribute('colname') && !specs[i].getAttribute('colnum')) {
      markChanged(parsed, specs[i], { attributes: true });
      specs[i].setAttribute('colname', names[i]);
    } else {
      const spec = build(parsed.doc, { name: 'colspec', attrs: { colnum: String(i + 1), colname: names[i] } });
      const lastSpec = elementChildren(tg).filter((c) => c.nodeName === 'colspec').length;
      placeElement(parsed, tg, lastSpec, spec);
    }
  }
  return names;
}

function cellAt(doc, path) {
  const el = elementAt(doc, path);
  const entry = up(el, 'entry');
  const tg = up(el, 'tgroup');
  if (!entry || !tg) return null;
  const grid = tableGrid(tg);
  if (!grid) return null;
  const cell = grid.cells.find((c) => c.entry === entry);
  return cell ? { grid, cell, tg } : null;
}

const rightOf = (grid, c) => grid.cells.find((x) => x.section === c.section && x.r === c.r && x.start === c.end + 1 && x.rows === c.rows) || null;
const below = (grid, c) => grid.cells.find((x) => x.section === c.section && x.r === c.r + c.rows && x.start === c.start && x.end === c.end) || null;

// What the page view can offer for the cell at `path`.
export function cellActions(doc, path) {
  const at = cellAt(doc, path);
  if (!at) return { mergeRight: false, mergeDown: false, split: false, modelled: false };
  const down = below(at.grid, at.cell);
  return {
    mergeRight: !!rightOf(at.grid, at.cell),
    // The row below must keep an entry of its own (a row needs at least one).
    mergeDown: !!down && elementChildren(down.rowEl).filter((c) => c.nodeName === 'entry').length > 1,
    split: at.cell.end > at.cell.start || at.cell.rows > 1,
    modelled: true,
  };
}

function absorb(parsed, into, from) {
  markChanged(parsed, into);
  for (const c of elementChildren(from)) into.appendChild(c);
  const row = from.parentNode;
  markChanged(parsed, row);
  const prev = from.previousSibling;
  row.removeChild(from);
  if (prev && prev.nodeType === 3 && /^\s+$/.test(prev.data) && prev.previousSibling) row.removeChild(prev);
}

// Merge the cell at `path` with the one to its right (same rows): its content follows. Returns the cell's path.
export function mergeRight(parsed, path) {
  const at = cellAt(parsed.doc, path);
  const other = at && rightOf(at.grid, at.cell);
  if (!other) return null;
  const names = ensureColNames(parsed, at.tg, at.grid);
  const e = at.cell.entry;
  markChanged(parsed, e, { attributes: true });
  e.removeAttribute('colname');
  e.setAttribute('namest', names[at.cell.start]);
  e.setAttribute('nameend', names[other.end]);
  absorb(parsed, e, other.entry);
  return pathOf(e);
}

// Merge the cell at `path` with the one below it (same columns): it spans down over that row too.
export function mergeDown(parsed, path) {
  const at = cellAt(parsed.doc, path);
  const other = at && below(at.grid, at.cell);
  if (!other || elementChildren(other.rowEl).filter((c) => c.nodeName === 'entry').length < 2) return null;
  const e = at.cell.entry;
  markChanged(parsed, e, { attributes: true });
  e.setAttribute('morerows', String(at.cell.rows - 1 + other.rows));
  absorb(parsed, e, other.entry);
  return pathOf(e);
}

/*
  Split a merged cell back into single cells: the cell keeps its content in
  its first column and row; every other position it covered gets an empty
  cell (with a paragraph), named by colname so its column is unambiguous.
*/
export function splitCell(parsed, path) {
  const at = cellAt(parsed.doc, path);
  if (!at || (at.cell.end === at.cell.start && at.cell.rows === 1)) return null;
  const { grid, cell } = at;
  const names = ensureColNames(parsed, at.tg, grid);
  const e = cell.entry;
  markChanged(parsed, e, { attributes: true });
  for (const a of ['namest', 'nameend', 'morerows']) e.removeAttribute(a);
  e.setAttribute('colname', names[cell.start]);
  const newCell = (c) => build(parsed.doc, { name: 'entry', attrs: { colname: names[c] }, children: [{ name: 'para', children: [] }] });
  // The same row: after the cell, in column order.
  const rowEntries = () => elementChildren(cell.rowEl).filter((c) => c.nodeName === 'entry');
  for (let c = cell.end; c > cell.start; c--) placeElement(parsed, cell.rowEl, rowEntries().indexOf(e) + 1, newCell(c));
  // The rows below it covered: before the first cell of that row that lies to the right.
  for (let k = 1; k < cell.rows; k++) {
    const rowEl = cell.sectionRows[cell.r + k];
    const after = grid.cells.filter((x) => x.rowEl === rowEl && x.start > cell.end).map((x) => x.entry);
    for (let c = cell.start; c <= cell.end; c++) {
      const entries = elementChildren(rowEl).filter((x) => x.nodeName === 'entry');
      const before = entries.findIndex((x) => after.includes(x));
      placeElement(parsed, rowEl, before === -1 ? entries.length : before, newCell(c));
    }
  }
  return pathOf(e);
}

// ---- identification and status ------------------------------------------------------------

/*
  The fields of the identification and status section the page view edits
  (decisions.md PV12): titles, issue, date, language and security. The data
  module code is not among them: it is the module's identity and file name.
  Each field is one attribute or one element's text, changed in place, so
  everything else in the section is kept exactly; a field whose element
  holds markup (an element, comment or PI) is not edited here.
*/
const first = (root, name) => (root ? root.getElementsByTagName(name)[0] || null : null);
export const IDENT_FIELDS = ['techName', 'infoName', 'issueNumber', 'inWork', 'issueDate', 'languageIsoCode', 'countryIsoCode', 'securityClassification'];

function plainText(el) {
  if (!el) return { value: '', editable: true };
  const kids = Array.from(el.childNodes);
  if (kids.some((n) => n.nodeType !== 3)) return { value: el.textContent, editable: false };
  return { value: kids.map((n) => n.data).join(''), editable: kids.length <= 1 };
}

export function identOf(doc) {
  const ident = first(doc.documentElement, 'identAndStatusSection');
  if (!ident) return null;
  const tech = first(ident, 'techName');
  const info = first(ident, 'infoName');
  const issue = first(ident, 'issueInfo');
  const date = first(ident, 'issueDate');
  const lang = first(ident, 'language');
  const sec = first(ident, 'security');
  const t = plainText(tech);
  const i = plainText(info);
  const pad = (v, n) => (v ? String(v).padStart(n, '0') : '');
  return {
    values: {
      techName: t.value, infoName: info ? i.value : '',
      issueNumber: issue ? issue.getAttribute('issueNumber') || '' : '', inWork: issue ? issue.getAttribute('inWork') || '' : '',
      issueDate: date && date.getAttribute('year') ? `${date.getAttribute('year')}-${pad(date.getAttribute('month'), 2)}-${pad(date.getAttribute('day'), 2)}` : '',
      languageIsoCode: lang ? lang.getAttribute('languageIsoCode') || '' : '', countryIsoCode: lang ? lang.getAttribute('countryIsoCode') || '' : '',
      securityClassification: sec ? sec.getAttribute('securityClassification') || '' : '',
    },
    present: { techName: !!tech, infoName: !!info, issueInfo: !!issue, issueDate: !!date, language: !!lang, security: !!sec, dmTitle: !!first(ident, 'dmTitle') },
    editable: { techName: !!tech && t.editable, infoName: !info || i.editable },
  };
}

// Problems with proposed values, as { field: message }; empty when they can be applied.
export function checkIdent(values, model, current) {
  const bad = {};
  const v = (k) => String(values[k] == null ? '' : values[k]);
  if (!v('techName').trim()) bad.techName = 'The technical name is required.';
  if (v('techName').length > 300) bad.techName = 'At most 300 characters.';
  if (v('infoName').length > 300) bad.infoName = 'At most 300 characters.';
  if (!/^\d{3}$/.test(v('issueNumber'))) bad.issueNumber = 'Three digits, for example 001.';
  if (!/^\d{2}$/.test(v('inWork'))) bad.inWork = 'Two digits, for example 00.';
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v('issueDate'));
  const real = d && new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
  if (!d || real.getUTCFullYear() !== +d[1] || real.getUTCMonth() !== +d[2] - 1 || real.getUTCDate() !== +d[3]) bad.issueDate = 'A real date.';
  if (!/^[a-z]{2,3}$/.test(v('languageIsoCode'))) bad.languageIsoCode = 'An ISO 639 code in lower case, for example en.';
  if (!/^[A-Z]{2}$/.test(v('countryIsoCode'))) bad.countryIsoCode = 'An ISO 3166 code in upper case, for example IN.';
  const allowed = (model && model.attributesOf('security').securityClassification) || [];
  if (allowed.length ? !allowed.includes(v('securityClassification')) : !/^\d{2}$/.test(v('securityClassification'))) bad.securityClassification = 'One of the permitted classifications.';
  if (current) {
    if (!current.editable.techName && v('techName') !== current.values.techName) bad.techName = 'This title contains markup; change it in the XML view.';
    if (!current.editable.infoName && v('infoName') !== current.values.infoName) bad.infoName = 'This title contains markup; change it in the XML view.';
    for (const [field, holder] of [['issueNumber', 'issueInfo'], ['inWork', 'issueInfo'], ['issueDate', 'issueDate'], ['languageIsoCode', 'language'], ['countryIsoCode', 'language'], ['securityClassification', 'security']]) {
      if (!current.present[holder] && v(field) !== current.values[field]) bad[field] = `This module has no <${holder}>; add it in the Tags or XML view.`;
    }
  }
  return bad;
}

// Apply checked values: only what differs is touched. Returns the list of fields changed.
export function setIdent(parsed, values, model) {
  const current = identOf(parsed.doc);
  if (!current) return [];
  if (Object.keys(checkIdent(values, model, current)).length) throw new Error('invalid identification values');
  const ident = first(parsed.doc.documentElement, 'identAndStatusSection');
  const changed = [];
  const attr = (el, name, value) => {
    if (!el || el.getAttribute(name) === value) return;
    markChanged(parsed, el, { attributes: true });
    el.setAttribute(name, value);
  };
  const text = (el, value) => {
    const node = Array.from(el.childNodes).find((n) => n.nodeType === 3);
    const v = protectText(value);
    if (node) { if (node.data !== v) { node.data = v; markTextChanged(parsed, node); } } else if (v) { markChanged(parsed, el); el.appendChild(parsed.doc.createTextNode(v)); }
  };
  const was = current.values;
  if (values.techName !== was.techName) { text(first(ident, 'techName'), values.techName); changed.push('techName'); }
  if (values.infoName !== was.infoName) {
    const info = first(ident, 'infoName');
    const title = first(ident, 'dmTitle');
    if (!values.infoName && info) {
      markChanged(parsed, info.parentNode);
      const prev = info.previousSibling;
      info.parentNode.removeChild(info);
      if (prev && prev.nodeType === 3 && /^\s+$/.test(prev.data) && prev.previousSibling) prev.parentNode.removeChild(prev);
    } else if (values.infoName && info) text(info, values.infoName);
    else if (values.infoName && title) {
      const at = elementChildren(title).findIndex((c) => c.nodeName === 'techName') + 1;
      placeElement(parsed, title, at, build(parsed.doc, { name: 'infoName', children: [values.infoName] }));
    }
    changed.push('infoName');
  }
  const issue = first(ident, 'issueInfo');
  if (values.issueNumber !== was.issueNumber) { attr(issue, 'issueNumber', values.issueNumber); changed.push('issueNumber'); }
  if (values.inWork !== was.inWork) { attr(issue, 'inWork', values.inWork); changed.push('inWork'); }
  if (values.issueDate !== was.issueDate) {
    const [y, mo, d] = values.issueDate.split('-');
    const date = first(ident, 'issueDate');
    attr(date, 'year', y); attr(date, 'month', mo); attr(date, 'day', d);
    changed.push('issueDate');
  }
  const lang = first(ident, 'language');
  if (values.languageIsoCode !== was.languageIsoCode) { attr(lang, 'languageIsoCode', values.languageIsoCode); changed.push('languageIsoCode'); }
  if (values.countryIsoCode !== was.countryIsoCode) { attr(lang, 'countryIsoCode', values.countryIsoCode); changed.push('countryIsoCode'); }
  if (values.securityClassification !== was.securityClassification) { attr(first(ident, 'security'), 'securityClassification', values.securityClassification); changed.push('securityClassification'); }
  return changed;
}

// ---- lists ------------------------------------------------------------------------------

export const listSpec = (kind, items = 2) => ({ name: kind, children: Array.from({ length: items }, () => ({ name: 'listItem', children: [{ name: 'para', children: [] }] })) });

// Add an item after (+1) or before (-1) the list item around `path`.
export function addListItem(parsed, path, where = 1) {
  const item = up(elementAt(parsed.doc, path), 'listItem');
  if (!item) return null;
  const list = item.parentNode;
  const index = elementChildren(list).indexOf(item) + (where > 0 ? 1 : 0);
  return placeElement(parsed, list, index, build(parsed.doc, { name: 'listItem', children: [{ name: 'para', children: [] }] }));
}

/*
  Indent: the item moves into a list inside the previous item (its last
  para), as S1000D nests lists; a list of the same kind is made if there is
  none. Outdent: the item moves out of its nested list, to just after the
  item that held it. Returns the item's new path, or null when not possible.
*/
export function indentItem(parsed, path) {
  const item = up(elementAt(parsed.doc, path), 'listItem');
  if (!item) return null;
  const list = item.parentNode;
  const siblings = elementChildren(list);
  const prev = siblings[siblings.indexOf(item) - 1];
  if (!prev) return null;
  const paras = elementChildren(prev).filter((c) => c.nodeName === 'para');
  const host = paras[paras.length - 1];
  if (!host) return null;
  let nested = elementChildren(host).reverse().find((c) => c.nodeName === list.nodeName);
  markChanged(parsed, list);
  list.removeChild(item);
  if (!nested) {
    nested = parsed.doc.createElement(list.nodeName);
    markChanged(parsed, host);
    host.appendChild(nested);
  } else markChanged(parsed, nested);
  nested.appendChild(item);
  return pathOf(item);
}

export function outdentItem(parsed, path) {
  const item = up(elementAt(parsed.doc, path), 'listItem');
  if (!item) return null;
  const list = item.parentNode;
  const host = list.parentNode; // the para holding the nested list
  const outerItem = host && host.parentNode && host.parentNode.nodeName === 'listItem' ? host.parentNode : null;
  if (!outerItem) return null;
  const outerList = outerItem.parentNode;
  markChanged(parsed, list);
  list.removeChild(item);
  if (!elementChildren(list).length) { markChanged(parsed, host); host.removeChild(list); }
  const index = elementChildren(outerList).indexOf(outerItem) + 1;
  return placeElement(parsed, outerList, index, item);
}

export { childNames };

// Shared with the editor commands (commands.js).
export { placeElement, up, ensureColNames, absorb, cellAt };
