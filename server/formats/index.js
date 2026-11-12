'use strict';
/*
  Document formats (Phase 7, decisions.md FM1-FM6). Everything that differs
  between formats lives here, one adapter each, so routes and the client ask
  "what can this format do" instead of testing the format by name.

  The formats are the ones the JSS PDF Publisher really has (its project
  `type`, client/src/components/NewProjectModal.jsx):
    s1000d  data modules and a publication module (<pm>), validated against
            the S1000D XSDs and BREX, built through s1000dtojss + jsstofo or
            straight through s1000dtofo;
    jss     one <jssbook>, built by jsstofo alone. There is no JSS schema in
            the reference: its vocabulary is what vendor/pipeline/jsstofo
            matches, so that is what the checks below use.
  JSG is not defined anywhere in the reference material and is refused with
  that reason rather than invented (FM6).

  A publication template (house style, page geometry, pipeline) is a project
  setting and never changes the format.
*/

const fs = require('node:fs');
const path = require('node:path');
const { DOMParser } = require('@xmldom/xmldom');

/*
  The JSS vocabulary, read from the stylesheets themselves rather than kept
  as a list here: every element name in a `match` or `select` of
  vendor/pipeline/jsstofo (what is rendered), and every literal element
  s1000dtojss writes (what a converted book holds).
*/
const PIPELINE = path.join(__dirname, '..', '..', 'vendor', 'pipeline');
let jssElements = null;
function jssVocabulary() {
  if (jssElements) return jssElements;
  const names = new Set();
  const xsl = (dir) => fs.readdirSync(path.join(PIPELINE, dir)).filter((f) => f.endsWith('.xsl')).map((f) => fs.readFileSync(path.join(PIPELINE, dir, f), 'utf8').replace(/<!--[\s\S]*?-->/g, ''));
  const STEP = /(?:^|[\/|(\s\[,])(?:child::|descendant::)?([A-Za-z_][\w-]*)(?=\s*(?:$|[\/|)\[\],=!<>]))/g;
  for (const text of xsl('jsstofo')) {
    for (const m of text.matchAll(/\b(?:match|select|test)="([^"]*)"/g)) {
      for (const st of m[1].replace(/'[^']*'/g, '').matchAll(STEP)) names.add(st[1]);
    }
    for (const m of text.matchAll(/elements="([^"]*)"/g)) for (const n of m[1].split(/\s+/)) if (n) names.add(n);
  }
  for (const text of xsl('s1000dtojss')) for (const m of text.matchAll(/<([A-Za-z][\w-]*)[\s>/]/g)) names.add(m[1]);
  // XPath words and functions are not elements.
  for (const w of ['and', 'or', 'not', 'div', 'mod', 'text', 'node', 'true', 'false', 'position', 'last', 'count', 'string', 'number', 'concat', 'contains', 'normalize-space', 'self', 'parent', 'ancestor', 'following-sibling', 'preceding-sibling']) names.delete(w);
  jssElements = names;
  return names;
}

const quiet = () => {};
const rootOf = (text) => {
  const m = /^(?:\s*<\?[\s\S]*?\?>|\s*<!--[\s\S]*?-->|\s*<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>)*\s*<([A-Za-z_][\w.-]*)/.exec(String(text).replace(/^﻿/, ''));
  return m ? m[1] : null;
};

/*
  The JSS checks: the root, the two parts every book has, and elements the
  stylesheets do not know (warnings: their text prints, their markup does
  not). Returns findings in the shape validation.js uses.
*/
function checkJss(text, rel = 'publication.xml') {
  const findings = [];
  if (rootOf(text) !== 'jssbook') {
    findings.push({ sev: 'error', kind: 'jss', rel, line: 1, message: 'A JSS book must have <jssbook> as its root element.' });
    return findings;
  }
  const doc = new DOMParser({ locator: {}, errorHandler: { warning: quiet, error: quiet, fatalError: quiet } }).parseFromString(String(text), 'text/xml');
  const root = doc && doc.documentElement;
  if (!root) return [{ sev: 'error', kind: 'jss', rel, line: 1, message: 'The book could not be read.' }];
  const kids = [];
  for (let n = root.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) kids.push(n.nodeName);
  if (!kids.includes('bookmeta')) findings.push({ sev: 'error', kind: 'jss', rel, line: root.lineNumber || 1, message: 'The book has no <bookmeta> (title, publication number and the other identity fields).' });
  if (!kids.includes('body')) findings.push({ sev: 'error', kind: 'jss', rel, line: root.lineNumber || 1, message: 'The book has no <body>.' });
  const unknown = new Map();
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const name = el.localName || el.nodeName;
    if (!jssVocabulary().has(name) && !unknown.has(name)) unknown.set(name, el.lineNumber || 1);
  }
  for (const [name, line] of unknown) {
    findings.push({ sev: 'warning', kind: 'jss', rel, line, message: `<${name}> is not a JSS element: its text prints, its markup is ignored.` });
  }
  return findings;
}

function jssSkeleton({ bookName = 'Technical Manual', systemName = '' } = {}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<jssbook>
  <bookmeta>
    <bookName>${esc(bookName)}</bookName>
    <systemName>${esc(systemName)}</systemName>
    <security>UNCLASSIFIED</security>
    <publicationNo/>
  </bookmeta>
  <body>
    <chapter number="1">
      <title>Introduction</title>
      <section>
        <title>General</title>
        <para>Text.</para>
      </section>
    </chapter>
  </body>
</jssbook>
`;
}

/*
  Identity in a JSS book lives in its <bookmeta> (jsstofo reads
  /jssbook/bookmeta; stage 1, which takes it from project.json for an
  S1000D project, does not run for a book). Field names are the ones
  s1000dtojss writes there.
*/
const BOOKMETA = { bookName: 'bookName', systemName: 'systemName', securityClassification: 'security', publicationNo: 'publicationNo',
  inbrNo: 'inbrNo', nsn: 'nsn', contractNo: 'contractNo', projectCode: 'projectCode', ltDocumentNo: 'ltDocumentNo', month: 'month', year: 'year',
  // The JSS0251 document type (decisions.md ST8): documentType is the chosen
  // key (UHB, MM, ...), documentTypeHeader the short phrase content/jssDocTypes.js
  // resolves it to for the running head. Both blank until a type is chosen,
  // so an existing book keeps its own bookName in the header (jsstofo.xsl).
  documentType: 'documentType', documentTypeHeader: 'documentTypeHeader' };
const escText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function readBookmeta(text) {
  const m = /<bookmeta>([\s\S]*?)<\/bookmeta>/.exec(String(text));
  const out = {};
  for (const [k, el] of Object.entries(BOOKMETA)) {
    const v = m && new RegExp(`<${el}>([\\s\\S]*?)</${el}>`).exec(m[1]);
    out[k] = v ? v[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim() : '';
  }
  return out;
}
// Only the named fields change; everything else in the book stays byte for byte.
function writeBookmeta(text, fields) {
  const s = String(text);
  const m = /<bookmeta>([\s\S]*?)<\/bookmeta>/.exec(s);
  if (!m) throw new Error('The book has no <bookmeta>.');
  let meta = m[1];
  for (const [k, v] of Object.entries(fields)) {
    const el = BOOKMETA[k];
    if (!el) continue;
    const re = new RegExp(`<${el}>[\\s\\S]*?</${el}>|<${el}\\s*/>`);
    const node = v === '' ? `<${el}/>` : `<${el}>${escText(v)}</${el}>`;
    meta = re.test(meta) ? meta.replace(re, node) : meta.replace(/(\s*)$/, `\n    ${node}$1`);
  }
  return s.slice(0, m.index) + `<bookmeta>${meta}</bookmeta>` + s.slice(m.index + m[0].length);
}

/*
  The cover's <documentType> (decisions.md ST8), inside whichever of
  <titlePage>/<titlePageJoint> the book has (a converted book inlines both
  at conversion time, FM4; a book made from the skeleton has neither, and
  this is then a no-op - there is no cover to retitle). One line becomes
  plain text; more than one becomes <line> children, the same convention
  engine/frontmatter.js and jsstofo.xsl's document-type-title already use.
*/
function writeTitlePageDocType(text, lines) {
  const body = lines.length > 1
    ? `\n${lines.map((l) => `            <line>${escText(l)}</line>`).join('\n')}\n        `
    : escText(lines[0] || '');
  let s = String(text);
  for (const tag of ['titlePage', 'titlePageJoint']) {
    const block = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`).exec(s);
    if (!block) continue;
    const next = block[0].replace(/<documentType>[\s\S]*?<\/documentType>/, `<documentType>${body}</documentType>`);
    s = s.slice(0, block.index) + next + s.slice(block.index + block[0].length);
  }
  return s;
}

const ADAPTERS = {
  s1000d: {
    id: 's1000d', label: 'S1000D',
    description: 'Data modules and a publication module, checked against the S1000D schemas and BREX.',
    roots: ['dmodule', 'pm'],
    capabilities: { dataModules: true, pageEditor: true, builder: true, dmrl: true, brex: true, graphics: true, pipelines: ['s1000dtojss', 's1000dtofo'] },
    convertTo: ['jss'],
  },
  jss: {
    id: 'jss', label: 'JSS book',
    description: 'One <jssbook>, rendered straight to PDF by the JSS stylesheets.',
    roots: ['jssbook'],
    capabilities: { dataModules: false, pageEditor: false, builder: false, dmrl: false, brex: false, graphics: true, pipelines: ['jsstofo'] },
    convertTo: [],
    check: checkJss,
    skeleton: jssSkeleton,
  },
};

const UNAVAILABLE = {
  jsg: 'JSG is not defined in the JSS PDF Publisher or the Agastya original (no schema, sample or stylesheet), so it cannot be read or produced. Provide its definition to add it.',
};

const FORMATS = Object.keys(ADAPTERS);
const adapter = (id) => ADAPTERS[id] || null;

// Which format a file is, from its root element: { format, kind: 'dm'|'pm'|'book' } or null.
function detect(text) {
  const root = rootOf(text);
  if (root === 'dmodule') return { format: 's1000d', kind: 'dm', root };
  if (root === 'pm') return { format: 's1000d', kind: 'pm', root };
  if (root === 'jssbook') return { format: 'jss', kind: 'book', root };
  return root ? { format: null, kind: null, root } : null;
}

// Why a conversion from -> to cannot be done, or null when it can.
function conversionProblem(from, to) {
  if (UNAVAILABLE[to]) return UNAVAILABLE[to];
  if (!adapter(from) || !adapter(to)) return 'Unknown format.';
  if (from === to) return 'The project is already in that format.';
  if (!adapter(from).convertTo.includes(to)) {
    return from === 'jss' && to === 's1000d'
      ? 'A JSS book cannot be converted to S1000D: the reference has no JSS to S1000D mapping (a JSS book has no data module codes, applicability or S1000D structure to map from).'
      : `${adapter(from).label} cannot be converted to ${adapter(to).label}.`;
  }
  return null;
}

// What the client needs to know about a project's format.
function describe(id) {
  const a = adapter(id) || ADAPTERS.s1000d;
  return { id: a.id, label: a.label, capabilities: a.capabilities, convertTo: a.convertTo };
}

module.exports = { ADAPTERS, UNAVAILABLE, FORMATS, adapter, detect, conversionProblem, describe, checkJss, jssSkeleton, rootOf, jssVocabulary, readBookmeta, writeBookmeta, writeTitlePageDocType, BOOKMETA };
