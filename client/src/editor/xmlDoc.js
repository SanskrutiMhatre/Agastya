// The XML document under the structured editor: parse, address, edit,
// serialise. Pure functions over a DOM, so they run in the browser and in
// Node tests (pass xmldom's DOMParser/XMLSerializer there).
//
//   - The prolog (XML declaration, comments, the DOCTYPE with its ICN entity
//     declarations) and anything after the root element are kept verbatim;
//     only the root element is re-serialised, and only after an edit.
//   - Entity references other than the five predefined ones (S1000D uses
//     the ISO sets: &ndash; &deg; ...) are declared in an external set the
//     browser never loads, so a plain parse would reject a valid module.
//     They are protected as marker text before parsing and put back on
//     output, so they survive untouched.
//   - Elements are addressed by their path of element-child indexes from the
//     root ([] is the root, [1, 0] its second element's first element).
//   - Lossless (checkpoint 2d, decisions.md PV2): every element remembers
//     where it was in the source text, and every edit marks what it changed.
//     Serialising copies everything unchanged straight from the source, byte
//     for byte (character references, quote style, attribute layout, white
//     space, CRLF, comments, processing instructions, CDATA, unknown
//     elements), and writes fresh text only for what was edited. Opening and
//     saving changes nothing; an edit changes only what it touched.

const PREDEFINED = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
const OPEN = '', CLOSE = '';

const protect = (s) => s.replace(/&([A-Za-z_][\w.-]*);/g, (m, name) => (PREDEFINED.has(name) ? m : `${OPEN}${name}${CLOSE}`));
const restore = (s) => s.replace(new RegExp(`${OPEN}([A-Za-z_][\\w.-]*)${CLOSE}`, 'g'), '&$1;');
// For display: a protected entity shows as &name;
export const displayText = restore;

// Where the root element starts and ends in the source text.
function rootSpan(text) {
  const re = /<(!--[\s\S]*?-->|\?[\s\S]*?\?>|!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>|([A-Za-z_][\w:.-]*))/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[2]) {
      const start = m.index;
      const name = m[2];
      const close = text.lastIndexOf(`</${name}`);
      const end = close === -1 ? text.length : text.indexOf('>', close) + 1;
      return { start, end: end || text.length };
    }
  }
  return { start: 0, end: text.length };
}

/*
  Parse. Returns { doc, prolog, epilogue } or { error: { message, line } }.
  `impl` = { DOMParser, XMLSerializer } (defaults to the browser's).
*/
export function parseXml(text, impl = globalThis, { mapSource = true } = {}) {
  const span = rootSpan(text);
  const prolog = text.slice(0, span.start);
  const epilogue = text.slice(span.end);
  // Outside the root element only comments, processing instructions and white space may appear.
  const stray = epilogue.replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, '');
  if (/\S/.test(stray)) {
    const at = span.end + epilogue.search(/\S/);
    return { error: { message: 'Extra content after the end of the root element.', line: text.slice(0, at).split('\n').length } };
  }
  let errorMessage = null;
  const parser = new impl.DOMParser(impl.errorHandler ? { errorHandler: impl.errorHandler((m) => { errorMessage = errorMessage || m; }) } : undefined);
  const body = protect(text.slice(span.start, span.end));
  let doc;
  try { doc = parser.parseFromString(body, 'application/xml'); } catch (e) { errorMessage = errorMessage || e.message; }
  const perr = doc && doc.getElementsByTagName('parsererror')[0];
  if (!doc || !doc.documentElement || perr || errorMessage) {
    const msg = String(errorMessage || (perr && perr.textContent) || 'The XML could not be read.');
    const lm = /line(?: number)?[^\d]*(\d+)/i.exec(msg);
    const prologLines = prolog.split('\n').length - 1;
    return { error: { message: msg.replace(/\s+/g, ' ').replace(/^.*?error[^:]*:\s*/i, '').slice(0, 300), line: lm ? Number(lm[1]) + prologLines : 1 } };
  }
  const parsed = { doc, prolog, epilogue, body, impl };
  parsed.map = mapSource ? mapSourceOf(doc, body) : null;
  return parsed;
}

/*
  Serialise. With a source map, unchanged elements and the text between them
  are copied from the source; without one (a document the scanner could not
  align, which the tests never meet), the root is serialised by the DOM.
*/
export function serializeXml(parsed, impl = globalThis) {
  if (!parsed.map) {
    const s = new (parsed.impl || impl).XMLSerializer().serializeToString(parsed.doc.documentElement);
    return parsed.prolog + restore(s) + parsed.epilogue;
  }
  return parsed.prolog + restore(emit(parsed, parsed.doc.documentElement)) + parsed.epilogue;
}

// ---- the source map -------------------------------------------------------------

/*
  The elements of the (protected) root text in document order, each with
  { start, startTagEnd, endTagStart, end }. Start tags inside comments, CDATA
  and processing instructions are not elements and are skipped. Returns null
  if the text cannot be scanned (the parser accepted it, so this is not
  expected).
*/
function scanElements(body) {
  const out = [];
  const stack = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) {
      const rec = stack.pop();
      if (!rec || rec.name !== m[1]) return null;
      rec.endTagStart = m.index;
      rec.end = m.index + m[0].length;
    } else if (m[2] !== undefined) {
      const rec = { name: m[2], start: m.index, startTagEnd: m.index + m[0].length, endTagStart: null, end: null, selfClosing: m[4] === '/' };
      out.push(rec);
      if (rec.selfClosing) rec.end = rec.startTagEnd; else stack.push(rec);
    }
  }
  return stack.length ? null : out;
}

const elementsInOrder = (root) => {
  const out = [];
  const walk = (el) => { out.push(el); for (const c of elementChildren(el)) walk(c); };
  walk(root);
  return out;
};

function mapSourceOf(doc, body) {
  const recs = scanElements(body);
  const els = elementsInOrder(doc.documentElement);
  if (!recs || recs.length !== els.length) return null;
  const map = {
    recs: new Map(), // element -> its source record
    kids: new Map(), // element -> its element children as parsed
    attrs: new Map(), // element -> { name: value } as parsed
    gapOf: new Map(), // non-element node -> { parent, gap }
    gapSize: new Map(), // `${parent rec start}:${gap}` -> number of nodes in it
    data: new Map(), // non-element node -> its text as parsed (any later change, tracked or not, is seen)
    childDirty: new Set(), attrDirty: new Set(), descDirty: new Set(), textDirty: new Set(),
  };
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const rec = recs[i];
    if (rec.name !== el.nodeName) return null;
    map.recs.set(el, rec);
    map.kids.set(el, elementChildren(el));
    const a = {};
    for (const at of Array.from(el.attributes || [])) a[at.name] = at.value;
    map.attrs.set(el, a);
    let gap = 0;
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 1) { gap++; continue; }
      map.gapOf.set(n, { parent: el, gap });
      map.data.set(n, n.data);
      const k = `${rec.start}:${gap}`;
      map.gapSize.set(k, (map.gapSize.get(k) || 0) + 1);
    }
  }
  return map;
}

// Record that an edit changed `el`'s children or text (or its attributes), up to the root.
function touch(parsed, el, { attributes = false } = {}) {
  const map = parsed.map;
  if (!map || !el) return;
  if (attributes) map.attrDirty.add(el); else map.childDirty.add(el);
  for (let e = el; e && e.nodeType === 1; e = e.parentNode) map.descDirty.add(e);
}
function touchText(parsed, node) {
  if (!parsed.map) return;
  parsed.map.textDirty.add(node);
  touch(parsed, node.parentNode);
}

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// A node the source does not know (new, or emitted piece by piece), written fresh.
function fresh(parsed, n) {
  if (n.nodeType === 3) return escText(n.data);
  if (n.nodeType === 4) return `<![CDATA[${n.data}]]>`;
  if (n.nodeType === 8) return `<!--${n.data}-->`;
  if (n.nodeType === 7) return `<?${n.target}${n.data ? ` ${n.data}` : ''}?>`;
  if (n.nodeType !== 1) return '';
  if (parsed.map && parsed.map.recs.has(n)) return emit(parsed, n);
  const attrs = Array.from(n.attributes || []).map((a) => ` ${a.name}="${escAttr(a.value)}"`).join('');
  const inner = Array.from(n.childNodes).map((c) => fresh(parsed, c)).join('');
  return inner ? `<${n.nodeName}${attrs}>${inner}</${n.nodeName}>` : `<${n.nodeName}${attrs}/>`;
}

/*
  The start tag of a known element whose attributes changed: the source tag
  with only the changed values replaced, removed ones cut and new ones added
  at the end, so the rest of its layout and quoting is kept.
*/
function startTag(parsed, el, rec, { open }) {
  const map = parsed.map;
  let tag = parsed.body.slice(rec.start, rec.startTagEnd);
  if (map.attrDirty.has(el)) {
    const before = map.attrs.get(el);
    const seen = new Set();
    tag = tag.replace(/(\s+)([^\s=/>]+)(\s*=\s*)("([^"]*)"|'([^']*)')/g, (all, ws, name, eq, quoted, dq, sq) => {
      seen.add(name);
      if (!el.hasAttribute(name)) return '';
      const value = el.getAttribute(name);
      if (value === before[name]) return all;
      const q = dq !== undefined ? '"' : "'";
      return `${ws}${name}${eq}${q}${q === '"' ? escAttr(value) : escAttr(value).replace(/'/g, '&apos;')}${q}`;
    });
    const added = Array.from(el.attributes).filter((a) => !seen.has(a.name)).map((a) => ` ${a.name}="${escAttr(a.value)}"`).join('');
    tag = tag.replace(/\s*(\/?)>$/, (end, slash) => `${added}${end.slice(0, end.length - (slash ? 2 : 1))}${slash}>`);
  }
  // A self-closing tag that now has content opens instead.
  if (open && rec.selfClosing) tag = tag.replace(/\s*\/>$/, '>');
  return tag;
}

function emit(parsed, el) {
  const map = parsed.map;
  const rec = map.recs.get(el);
  if (!rec) return fresh(parsed, el);
  if (!map.descDirty.has(el)) return parsed.body.slice(rec.start, rec.end);
  const nodes = Array.from(el.childNodes);
  const hasContent = nodes.length > 0;
  let out = startTag(parsed, el, rec, { open: hasContent });
  if (rec.selfClosing && !hasContent) return out;
  const origKids = map.kids.get(el);
  // The text between element children: copied from the source while it is exactly as parsed.
  const gapSpan = (k) => {
    const from = k === 0 ? rec.startTagEnd : map.recs.get(origKids[k - 1]).end;
    const to = k === origKids.length ? rec.endTagStart : map.recs.get(origKids[k]).start;
    return parsed.body.slice(from, to);
  };
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const g = map.gapOf.get(run[0]);
    const intact = g && g.parent === el
      && run.every((n) => { const h = map.gapOf.get(n); return h && h.parent === el && h.gap === g.gap && !map.textDirty.has(n) && n.data === map.data.get(n); })
      && map.gapSize.get(`${rec.start}:${g.gap}`) === run.length;
    out += intact ? gapSpan(g.gap) : run.map((n) => fresh(parsed, n)).join('');
    run = [];
  };
  for (const n of nodes) {
    if (n.nodeType === 1) { flush(); out += emit(parsed, n); } else run.push(n);
  }
  flush();
  out += rec.endTagStart !== null ? parsed.body.slice(rec.endTagStart, rec.end) : `</${el.nodeName}>`;
  return out;
}

// ---- addressing ---------------------------------------------------------------

export const elementChildren = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 1);
export const childNames = (el) => elementChildren(el).map((c) => c.nodeName);

export function elementAt(doc, path) {
  let el = doc.documentElement;
  for (const i of path) {
    el = elementChildren(el)[i];
    if (!el) return null;
  }
  return el;
}

export function pathOf(el) {
  const path = [];
  while (el && el.parentNode && el.parentNode.nodeType === 1) {
    path.unshift(elementChildren(el.parentNode).indexOf(el));
    el = el.parentNode;
  }
  return path;
}

// ---- edits (each mutates the parsed doc; the caller serialises) -------------

function indentOf(parent) {
  // The whitespace used before the parent's existing element children, for tidy insertion.
  for (const n of Array.from(parent.childNodes)) if (n.nodeType === 3 && /^\s*\n[ \t]*$/.test(n.data)) return n.data;
  return null;
}

/*
  Create an element and fill it with what its model requires (recursively,
  a few levels deep). `model` is a content model from contentModelFor().
*/
export function createElementFilled(doc, name, model, depth = 0) {
  const el = doc.createElement(name);
  if (depth < 4 && model) {
    let children = model.requiredChildren(name);
    // The element the author inserts gets a title and a first paragraph when its model allows them
    // (a levelledPara may legally be empty, which is never what is wanted).
    if (depth === 0 && !children.length && !model.holdsText(name)) {
      if (model.insertableAt(name, [], 0).includes('title')) children = ['title'];
      if (model.insertableAt(name, children, children.length).includes('para')) children = [...children, 'para'];
      if (!model.canExtend(name, children)) children = [];
    }
    for (const child of children) el.appendChild(createElementFilled(doc, child, model, depth + 1));
  }
  return el;
}

// Insert a new element as element-child `index` of the element at `parentPath`; returns its path.
export function insertElement(parsed, parentPath, index, name, model) {
  const parent = elementAt(parsed.doc, parentPath);
  const kids = elementChildren(parent);
  const el = createElementFilled(parsed.doc, name, model);
  const ref = kids[index] || null;
  touch(parsed, parent);
  const mixed = model && model.holdsText(parent.nodeName);
  const ws = mixed ? null : indentOf(parent);
  if (ref) {
    parent.insertBefore(el, ref);
    if (ws) parent.insertBefore(parsed.doc.createTextNode(ws), ref);
  } else {
    const last = parent.lastChild;
    // Keep the closing tag's own indentation after the new element.
    if (ws && last && last.nodeType === 3 && /^\s+$/.test(last.data)) {
      parent.insertBefore(parsed.doc.createTextNode(ws), last);
      parent.insertBefore(el, last);
    } else {
      parent.appendChild(el);
    }
  }
  return [...parentPath, Math.min(index, kids.length)];
}

// Split a text node at `offset` and put a new inline element there; returns its path.
export function insertInline(parsed, parentPath, nodeIndex, offset, name, model) {
  const parent = elementAt(parsed.doc, parentPath);
  const node = parent.childNodes[nodeIndex];
  const el = createElementFilled(parsed.doc, name, model);
  touch(parsed, parent);
  if (node && node.nodeType === 3) {
    touchText(parsed, node);
    const after = node.data.slice(offset);
    node.data = node.data.slice(0, offset);
    const next = node.nextSibling;
    parent.insertBefore(el, next);
    if (after) parent.insertBefore(parsed.doc.createTextNode(after), next);
  } else {
    parent.insertBefore(el, node || null);
  }
  return pathOf(el);
}

export function removeElement(parsed, path) {
  const el = elementAt(parsed.doc, path);
  const parent = el.parentNode;
  const prev = el.previousSibling;
  touch(parsed, parent);
  parent.removeChild(el);
  // Drop the indentation that preceded it, so blank lines do not pile up.
  if (prev && prev.nodeType === 3 && /^\s+$/.test(prev.data) && prev.previousSibling) parent.removeChild(prev);
}

// Swap with the previous (-1) or next (+1) element sibling; returns the new path.
export function moveElement(parsed, path, delta) {
  const el = elementAt(parsed.doc, path);
  const parent = el.parentNode;
  const kids = elementChildren(parent);
  const i = kids.indexOf(el);
  const j = i + delta;
  if (j < 0 || j >= kids.length) return path;
  touch(parsed, parent);
  if (delta < 0) parent.insertBefore(el, kids[j]);
  else parent.insertBefore(el, kids[j].nextSibling);
  return [...path.slice(0, -1), j];
}

export function setAttribute(parsed, path, name, value) {
  const el = elementAt(parsed.doc, path);
  touch(parsed, el, { attributes: true });
  if (value === null || value === undefined || value === '') el.removeAttribute(name);
  else el.setAttribute(name, value);
}

// Replace the text of child node `nodeIndex` (a text node) of the element at `path`.
export function setText(parsed, path, nodeIndex, value) {
  const el = elementAt(parsed.doc, path);
  const node = el.childNodes[nodeIndex];
  const v = protect(value);
  if (node && node.nodeType === 3) {
    if (node.data === v) return;
    node.data = v;
    touchText(parsed, node);
  } else if (!node && v) {
    el.appendChild(parsed.doc.createTextNode(v));
    touch(parsed, el);
  }
}

// Child-name sequences that become invalid with an edit, for enabling actions.
export function namesAfterRemove(el, index) { const n = childNames(el); n.splice(index, 1); return n; }
export function namesAfterMove(el, index, delta) {
  const n = childNames(el);
  const j = index + delta;
  if (j < 0 || j >= n.length) return null;
  [n[index], n[j]] = [n[j], n[index]];
  return n;
}

/*
  Content-model problems in the whole document: elements whose element
  children are not a valid sequence for their model. Returns
  [{ path, name, index, message }], index = first offending child (or the
  child count when something required is missing).
*/
export function contentProblems(doc, model, limit = 200) {
  const out = [];
  const walk = (el, path) => {
    if (out.length >= limit) return;
    const names = childNames(el);
    if (model.isKnown(el.nodeName)) {
      const bad = model.firstInvalidIndex(el.nodeName, names);
      if (bad !== -1) {
        out.push({
          path, name: el.nodeName, index: bad,
          message: bad < names.length
            ? `<${names[bad]}> is not allowed here in <${el.nodeName}>.`
            : `<${el.nodeName}> is incomplete: it needs ${(model.insertableAt(el.nodeName, names, names.length) || []).slice(0, 3).map((x) => `<${x}>`).join(' or ') || 'more content'}.`,
        });
      }
    }
    elementChildren(el).forEach((c, i) => walk(c, [...path, i]));
  };
  walk(doc.documentElement, []);
  return out;
}

// ---- for the editing operations (ops.js) ------------------------------------------

export { touch as markChanged, touchText as markTextChanged, protect as protectText };

/*
  The deepest element that contains source line `line` (1-based, counted in
  the whole text, prolog included), as a path; null without a source map or
  outside the root. Lets a validation finding (which has a line) be shown on
  the element it is about.
*/
export function pathAtLine(parsed, line) {
  if (!parsed || !parsed.map || !line) return null;
  // Line starts of the root text, once; the prolog's lines come first.
  const base = parsed.prolog.split('\n').length;
  const starts = [0];
  for (let i = 0; i < parsed.body.length; i++) if (parsed.body.charCodeAt(i) === 10) starts.push(i + 1);
  const lineOf = (offset) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; } return base + lo; };
  let best = null;
  let bestStart = -1;
  for (const [el, rec] of parsed.map.recs) {
    if (!el.parentNode || rec.start < bestStart) continue;
    const a = lineOf(rec.start);
    if (a > line) continue;
    const b = lineOf(rec.end);
    if (b < line) continue;
    best = el;
    bestStart = rec.start;
  }
  return best && best.ownerDocument === parsed.doc ? pathOf(best) : null;
}
