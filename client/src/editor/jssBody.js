// The Design view for a JSS book (decisions.md ST9): a plain block tree
// over <body>, not a validated content model. JSS has no schema in the
// reference (FM3) — its real "rules" are just what jsstofo.xsl knows how to
// render (vocabulary read at build time from the stylesheets themselves).
// This models that same vocabulary: chapter > section* (nestable) >
// para | list | table | figure | warning | caution | note.
//
// Anything this editor does not model — an element outside that vocabulary,
// or structure it does not specifically parse — becomes an "unknown" block
// holding its exact source XML untouched, so nothing is ever silently
// dropped; it just is not editable here (the XML view still reaches it).
//
// Pure functions over a DOM (xmlDoc.js's own convention), so the same code
// runs in the browser and, with xmldom's DOMParser/XMLSerializer passed as
// `impl`, in a Node test.

let uid = 1;
export const nextBlockId = () => `jb${uid++}`;

const INLINE_TAGS = new Set(['b', 'bold', 'i', 'italic', 'u', 'underline', 'sub', 'subscript', 'sup', 'superscript', 'red', 'br', 'xref']);

function defaultImpl() {
  /* eslint-disable no-undef */
  return { DOMParser: typeof DOMParser === 'undefined' ? null : DOMParser, XMLSerializer: typeof XMLSerializer === 'undefined' ? null : XMLSerializer };
  /* eslint-enable no-undef */
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

// An element's children, serialised back to XML text (for inline content and for pass-through blocks).
function innerXml(el, Serializer) {
  const s = new Serializer();
  let out = '';
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 1) out += s.serializeToString(n);
    else if (n.nodeType === 3) out += esc(n.nodeValue);
  }
  return out;
}
// The element itself, serialised (for an opaque pass-through block).
const outerXml = (el, Serializer) => new Serializer().serializeToString(el);

function textContent(el) {
  let out = '';
  for (const n of Array.from(el.childNodes)) out += n.nodeType === 3 ? n.nodeValue : (n.nodeType === 1 ? textContent(n) : '');
  return out;
}

/*
  contentEditable's innerHTML, cleaned to plain JSS inline XML: only the
  tags JSS actually has (b/i/u/sub/sup/br), browser variants folded onto
  them (<strong> -> <b>, <em> -> <i>), everything else's text kept but its
  own markup dropped (exactly how jsstofo treats an element it does not
  know, FM3) - a paste from somewhere else never produces something the
  build cannot render.
*/
const TAG_MAP = { strong: 'b', em: 'i', ins: 'u' };
export function cleanInlineHtml(html, Parser) {
  const doc = new Parser().parseFromString(`<div>${html}</div>`, 'text/html');
  const walk = (node) => {
    let out = '';
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === 3) { out += esc(n.nodeValue); continue; }
      if (n.nodeType !== 1) continue;
      const tag = TAG_MAP[n.tagName.toLowerCase()] || n.tagName.toLowerCase();
      if (tag === 'br') { out += '<br/>'; continue; }
      if (tag === 'div' || tag === 'p') { out += walk(n); continue; } // a browser's own paragraphing inside one block: flatten
      if (['b', 'i', 'u', 'sub', 'sup'].includes(tag)) out += `<${tag}>${walk(n)}</${tag}>`;
      else out += walk(n); // unknown wrapper: keep its text, drop its markup
    }
    return out;
  };
  return walk(doc.body.firstChild).replace(/\s+/g, ' ').trim();
}
// The reverse, for showing a block's stored XML as contentEditable HTML (same tag names, so mostly a pass-through).
export const inlineXmlToHtml = (xml) => String(xml || '');

function parsePara(el, Serializer) { return { id: nextBlockId(), type: 'para', html: innerXml(el, Serializer) }; }
function parseNotice(el, Serializer, type) { return { id: nextBlockId(), type, html: innerXml(el, Serializer) }; }
function parseList(el, Serializer) {
  const items = Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.tagName === 'item').map((n) => innerXml(n, Serializer));
  return { id: nextBlockId(), type: 'list', ordered: el.getAttribute('type') === 'number' || el.getAttribute('type') === 'arabic', items: items.length ? items : [''] };
}
function parseTable(el, Serializer) {
  const title = Array.from(el.childNodes).find((n) => n.nodeType === 1 && n.tagName === 'title');
  const rowsOf = (parent) => Array.from(parent.childNodes).filter((n) => n.nodeType === 1 && n.tagName === 'row')
    .map((r) => Array.from(r.childNodes).filter((c) => c.nodeType === 1 && c.tagName === 'cell').map((c) => textContent(c)));
  const thead = Array.from(el.childNodes).find((n) => n.nodeType === 1 && n.tagName === 'thead');
  const tbody = Array.from(el.childNodes).find((n) => n.nodeType === 1 && n.tagName === 'tbody');
  const header = thead ? rowsOf(thead)[0] : null;
  const rows = tbody ? rowsOf(tbody) : rowsOf(el);
  const cols = Math.max(header ? header.length : 0, ...rows.map((r) => r.length), 1);
  const pad = (r) => [...Array(cols)].map((_, i) => r[i] || '');
  return { id: nextBlockId(), type: 'table', title: title ? textContent(title) : '', header: header ? pad(header) : null, rows: (rows.length ? rows : [Array(cols).fill('')]).map(pad) };
}
function parseFigure(el) {
  const title = Array.from(el.childNodes).find((n) => n.nodeType === 1 && n.tagName === 'title');
  const g = Array.from(el.childNodes).find((n) => n.nodeType === 1 && (n.tagName === 'graphic' || n.tagName === 'image'));
  return { id: nextBlockId(), type: 'figure', title: title ? textContent(title) : '', src: g ? g.getAttribute('src') : '' };
}

const BLOCK_PARSERS = { para: parsePara, warning: (e, S) => parseNotice(e, S, 'warning'), caution: (e, S) => parseNotice(e, S, 'caution'), note: (e, S) => parseNotice(e, S, 'note') };

function parseBlocks(parent, Serializer) {
  const out = [];
  for (const el of Array.from(parent.childNodes)) {
    if (el.nodeType !== 1) continue;
    const tag = el.tagName;
    if (tag === 'section') { out.push(parseSection(el, Serializer)); continue; }
    if (BLOCK_PARSERS[tag]) { out.push(BLOCK_PARSERS[tag](el, Serializer)); continue; }
    if (tag === 'list') { out.push(parseList(el, Serializer)); continue; }
    if (tag === 'table') { out.push(parseTable(el, Serializer)); continue; }
    if (tag === 'figure') { out.push(parseFigure(el)); continue; }
    if (tag === 'title') continue; // the section/chapter's own title, read separately
    out.push({ id: nextBlockId(), type: 'unknown', tag, xml: outerXml(el, Serializer) });
  }
  return out;
}
function parseSection(el, Serializer) {
  const title = Array.from(el.childNodes).find((n) => n.nodeType === 1 && n.tagName === 'title');
  return { id: nextBlockId(), type: 'section', title: title ? textContent(title) : '', blocks: parseBlocks(el, Serializer) };
}
function parseChapter(el, Serializer) {
  const title = Array.from(el.childNodes).find((n) => n.nodeType === 1 && n.tagName === 'title');
  return { id: nextBlockId(), type: 'chapter', number: el.getAttribute('number') || '', title: title ? textContent(title) : '', blocks: parseBlocks(el, Serializer) };
}

// `xml` is the whole book; only its <body> is read. Returns { chapters, ok } — ok false (chapters []) when there is no <body> to show (not a book, or empty).
export function parseBody(xml, impl) {
  const { DOMParser } = { ...defaultImpl(), ...impl };
  if (!DOMParser) return { chapters: [], ok: false };
  const doc = new DOMParser().parseFromString(String(xml), 'text/xml');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'jssbook') return { chapters: [], ok: false };
  const body = Array.from(root.childNodes).find((n) => n.nodeType === 1 && n.tagName === 'body');
  if (!body) return { chapters: [], ok: false };
  const { XMLSerializer } = { ...defaultImpl(), ...impl };
  const chapters = Array.from(body.childNodes).filter((n) => n.nodeType === 1 && n.tagName === 'chapter').map((n) => parseChapter(n, XMLSerializer));
  return { chapters, ok: true };
}

function serializeNotice(b, tag) { return `<${tag}>${b.html}</${tag}>`; }
function serializeList(b) {
  return `<list${b.ordered ? ' type="number"' : ''}>${b.items.map((it) => `<item>${it}</item>`).join('')}</list>`;
}
function serializeTable(b) {
  const row = (cells) => `<row>${cells.map((c) => `<cell><para>${esc(c)}</para></cell>`).join('')}</row>`;
  const title = b.title ? `<title>${esc(b.title)}</title>` : '';
  const thead = b.header ? `<thead>${row(b.header)}</thead>` : '';
  return `<table>${title}${thead}<tbody>${b.rows.map(row).join('')}</tbody></table>`;
}
function serializeFigure(b) {
  return `<figure>${b.title ? `<title>${esc(b.title)}</title>` : ''}${b.src ? `<graphic src="${escAttr(b.src)}"/>` : ''}</figure>`;
}
function serializeBlock(b) {
  if (b.type === 'section') return serializeSection(b);
  if (b.type === 'para') return `<para>${b.html}</para>`;
  if (b.type === 'warning' || b.type === 'caution' || b.type === 'note') return serializeNotice(b, b.type);
  if (b.type === 'list') return serializeList(b);
  if (b.type === 'table') return serializeTable(b);
  if (b.type === 'figure') return serializeFigure(b);
  if (b.type === 'unknown') return b.xml;
  return '';
}
function serializeSection(s) {
  return `<section>${s.title ? `<title>${esc(s.title)}</title>` : '<title></title>'}${s.blocks.map(serializeBlock).join('')}</section>`;
}
function serializeChapter(c) {
  return `<chapter number="${escAttr(c.number || '1')}">${c.title ? `<title>${esc(c.title)}</title>` : '<title></title>'}${c.blocks.map(serializeBlock).join('')}</chapter>`;
}
export function serializeBody(chapters) {
  return `<body>${chapters.map(serializeChapter).join('')}</body>`;
}

// Splices a freshly-serialised <body> back into the full book XML, leaving everything else (bookmeta, prelims, anything after) untouched.
export function spliceBody(xml, bodyXml) {
  const s = String(xml);
  const m = /<body>[\s\S]*?<\/body>/.exec(s);
  if (!m) return s.replace('</jssbook>', `${bodyXml}</jssbook>`);
  return s.slice(0, m.index) + bodyXml + s.slice(m.index + m[0].length);
}

export const BLOCK_LABELS = { para: 'Paragraph', list: 'List', table: 'Table', figure: 'Figure', warning: 'Warning', caution: 'Caution', note: 'Note', unknown: 'Other content' };
