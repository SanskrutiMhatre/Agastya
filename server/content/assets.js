'use strict';
/*
  The graphics module's three kinds of asset (Phase 8, decisions.md GR1-GR6),
  each read from where S1000D and the build actually keep it, not from a
  store of its own:

    ICNs     illustrations: files named by their Information Control Number,
             referenced by <graphic infoEntityIdent>, placed where the build
             looks (graphics.js). The registry (graphics table) adds titles.
    Symbols  the same ICN files, referenced by <symbol infoEntityIdent>
             inside text (the reference's MediaManager and its symbol sizing).
    Parts    the illustrated parts data of IPD data modules:
             catalogSeqNumber (figureNumber, item, indenture) > itemSeqNumber >
             quantityPerNextHigherAssy, partRef (partNumberValue,
             manufacturerCodeValue), partSegment/itemIdentData/descrForPart
             (S1000D 4.2 ipd.xsd), and every other module's partRef to the
             same part (spares and supplies in procedures).

  ICN revisions follow the S1000D ICN layout: the last three segments are
  the variant, the issue number and the security classification, so two
  ICNs that differ only in issue are issues of one illustration.
*/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DOMParser } = require('@xmldom/xmldom');
const graphics = require('./graphics');

const quiet = () => {};
const parse = (text) => new DOMParser({ locator: {}, errorHandler: { warning: quiet, error: quiet, fatalError: quiet } }).parseFromString(String(text), 'text/xml');
const byName = (root, name) => Array.from(root.getElementsByTagName(name));
const textOf = (el) => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');

// The parts of an ICN: everything before the last three segments is the illustration, then variant, issue, security.
function parseIcn(icn) {
  const seg = String(icn).split('-');
  if (seg.length < 5 || seg[0].toUpperCase() !== 'ICN') return { base: icn, variant: null, issue: null, security: null };
  return { base: seg.slice(0, -2).join('-'), variant: seg[seg.length - 3], issue: seg[seg.length - 2], security: seg[seg.length - 1] };
}

// Which ICNs a module uses, and how: Map key -> { icn, as: Set('graphic'|'symbol') }.
function usesOf(text) {
  const out = new Map();
  for (const m of String(text).matchAll(/<(graphic|symbol)\b[^>]*\binfoEntityIdent\s*=\s*["']\s*([^"'\s]+)\s*["']/g)) {
    const k = graphics.icnKey(m[2]);
    if (!out.has(k)) out.set(k, { icn: m[2], as: new Set() });
    out.get(k).as.add(m[1]);
  }
  return out;
}

/*
  The ICN and symbol views of a project. `modules`: [{ dmc, text }];
  `registry`: graphics rows. Problems are listed per asset:
    missing     referenced, no file where the build looks or elsewhere
    misplaced   a file exists but not where the build looks
    duplicate   the same image content under another ICN
    conflict    more than one file for this ICN (different extensions or folders)
*/

/*
  The data modules of a project as { id, dmc, rel, text }, read from disk.
  Pure (dir, modules), so it needs no request: used by the per-project
  assets route and by the cross-project graphics library (routes/graphics.js).
*/
function moduleTextsOf(dir, modules) {
  return modules.map((m) => {
    try { return { id: m.id, dmc: m.dmc, rel: m.rel_path, text: fs.readFileSync(path.join(dir, m.rel_path), 'utf8') }; } catch { return null; }
  }).filter(Boolean);
}

// As moduleTextsOf, plus a JSS book counted as one more "module" for the ICN view (it names images by path, not infoEntityIdent).
function assetTextsOf(dir, project, modules) {
  const list = moduleTextsOf(dir, modules);
  if (project.format === 'jss') {
    try {
      const book = fs.readFileSync(path.join(dir, 'publication.xml'), 'utf8')
        .replace(/<graphic\b([^>]*)\bsrc="(?:csdb|Media)\/(ICN-[^".]+)\.[A-Za-z]+"/g, '<graphic$1 infoEntityIdent="$2"');
      list.push({ id: null, dmc: 'publication.xml', rel: 'publication.xml', text: book });
    } catch { /* no book */ }
  }
  return list;
}

function icnCatalogue(dir, modules, registry) {
  const declared = graphics.declaredEntities(modules.map((m) => m.text));
  const used = new Map();
  for (const m of modules) {
    for (const [k, u] of usesOf(m.text)) {
      if (!used.has(k)) used.set(k, { icn: u.icn, as: new Set(), usedBy: [] });
      const e = used.get(k);
      for (const a of u.as) e.as.add(a);
      e.usedBy.push(m.dmc);
    }
  }
  const reg = new Map(registry.map((g) => [graphics.icnKey(g.icn), g]));
  const files = new Map(); // key -> [rel]
  for (const sub of ['csdb', 'Media']) {
    let list = [];
    try { list = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const f of list) {
      if (!/\.(png|jpe?g|gif)$/i.test(f)) continue;
      const stem = f.replace(/\.[^.]+$/, '');
      if (!graphics.ICN_RE.test(stem)) continue;
      const k = graphics.icnKey(stem);
      if (!files.has(k)) files.set(k, []);
      files.get(k).push(`${sub}/${f}`);
    }
  }
  const keys = new Set([...used.keys(), ...reg.keys(), ...files.keys()]);
  const hashOf = new Map();
  const rows = [...keys].sort().map((k) => {
    const u = used.get(k);
    const g = reg.get(k);
    const icn = u ? u.icn : g ? g.icn : path.basename(files.get(k)[0]).replace(/\.[^.]+$/, '');
    const exp = graphics.expectedLocation(icn, declared);
    const found = graphics.findFile(dir, icn, declared);
    let sha = g ? g.sha256 : null;
    if (found && !sha) { try { sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, found))).digest('hex'); } catch { sha = null; } }
    if (sha) { if (!hashOf.has(sha)) hashOf.set(sha, []); hashOf.get(sha).push(icn); }
    const kind = u && u.as.has('symbol') && !u.as.has('graphic') ? 'symbol' : 'icn';
    const problems = [];
    if (!found) problems.push({ code: 'missing', message: u ? `Referenced by ${u.usedBy.length} module(s), but no file is in the project.` : 'Registered, but its file is gone.' });
    else if (found !== exp.rel) problems.push({ code: 'misplaced', message: `The build looks for ${exp.rel}; the file is ${found}.` });
    if ((files.get(k) || []).length > 1) problems.push({ code: 'conflict', message: `More than one file for this ICN: ${files.get(k).join(', ')}.` });
    return {
      icn, kind, ...parseIcn(icn), title: g ? g.title : '', usedBy: u ? [...new Set(u.usedBy)] : [], usedAs: u ? [...u.as] : [],
      file: found, expected: exp.rel, present: !!found, resolves: found === exp.rel,
      format: g ? g.format : found ? (/\.png$/i.test(found) ? 'png' : /\.gif$/i.test(found) ? 'gif' : 'jpeg') : null,
      size: g ? g.size : null, sha256: sha, uploadedBy: g ? g.uploaded_by_name || null : null, uploadedAt: g ? g.uploaded_at : null,
      registered: !!g, problems,
    };
  });
  for (const r of rows) {
    const same = r.sha256 ? (hashOf.get(r.sha256) || []).filter((x) => graphics.icnKey(x) !== graphics.icnKey(r.icn)) : [];
    if (same.length) r.problems.push({ code: 'duplicate', message: `The same image as ${same.join(', ')}.` });
  }
  // Issues of one illustration, newest first.
  const byBase = new Map();
  for (const r of rows) { if (!byBase.has(r.base)) byBase.set(r.base, []); byBase.get(r.base).push(r.icn); }
  for (const r of rows) r.issues = byBase.get(r.base).slice().sort().reverse();
  return { icns: rows.filter((r) => r.kind === 'icn'), symbols: rows.filter((r) => r.kind === 'symbol') };
}

// Every part in the IPD modules, with where it is used elsewhere.
function partsCatalogue(modules) {
  const parts = new Map(); // `${mfr}|${pn}` -> part
  const keyOf = (mfr, pn) => `${String(mfr).toUpperCase()}|${String(pn).toUpperCase()}`;
  for (const m of modules) {
    if (!/<illustratedPartsCatalog[\s>]/.test(m.text) && !/<partRef\b/.test(m.text)) continue;
    const doc = parse(m.text);
    const root = doc && doc.documentElement;
    if (!root) continue;
    const icns = byName(root, 'graphic').map((g) => g.getAttribute('infoEntityIdent')).filter(Boolean);
    for (const csn of byName(root, 'catalogSeqNumber')) {
      for (const isn of byName(csn, 'itemSeqNumber')) {
        const ref = byName(isn, 'partRef')[0];
        if (!ref) continue;
        const pn = ref.getAttribute('partNumberValue') || '';
        const mfr = ref.getAttribute('manufacturerCodeValue') || '';
        const k = keyOf(mfr, pn);
        if (!parts.has(k)) parts.set(k, { partNumber: pn, manufacturer: mfr, descriptions: new Set(), entries: [], usedBy: new Set() });
        const p = parts.get(k);
        const d = textOf(byName(isn, 'descrForPart')[0]);
        if (d) p.descriptions.add(d);
        p.entries.push({
          dmc: m.dmc, dmId: m.id, figureNumber: csn.getAttribute('figureNumber') || '', item: csn.getAttribute('item') || '',
          indenture: csn.getAttribute('indenture') || '', quantity: textOf(byName(isn, 'quantityPerNextHigherAssy')[0]), icns,
          line: csn.lineNumber || null,
        });
      }
    }
  }
  // References from other modules (spares and supplies in procedures name parts by the same partRef).
  for (const m of modules) {
    for (const r of String(m.text).matchAll(/<partRef\b([^>]*)>/g)) {
      const pn = /partNumberValue\s*=\s*"([^"]*)"/.exec(r[1]);
      const mfr = /manufacturerCodeValue\s*=\s*"([^"]*)"/.exec(r[1]);
      if (!pn || !mfr) continue;
      const p = parts.get(keyOf(mfr[1], pn[1]));
      if (p && !p.entries.some((e) => e.dmc === m.dmc)) p.usedBy.add(m.dmc);
    }
  }
  return [...parts.values()].map((p) => {
    const problems = [];
    if (p.descriptions.size > 1) problems.push({ code: 'conflict', message: `Described differently in different entries: ${[...p.descriptions].join(' / ')}.` });
    const seen = new Map();
    for (const e of p.entries) {
      const at = `${e.dmc} figure ${e.figureNumber} item ${e.item}`;
      if (seen.has(at)) problems.push({ code: 'duplicate', message: `Listed twice at ${at}.` });
      seen.set(at, true);
    }
    return { partNumber: p.partNumber, manufacturer: p.manufacturer, description: [...p.descriptions][0] || '', entries: p.entries, usedBy: [...p.usedBy], problems };
  }).sort((a, b) => a.partNumber.localeCompare(b.partNumber));
}

const PN = /^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,31}$/;
const CAGE = /^[A-Za-z0-9]{5}$/;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class PartError extends Error { constructor(message) { super(message); this.status = 400; this.code = 'VALIDATION'; } }

/*
  Add one part to an IPD module: a catalogSeqNumber in the order ipd.xsd
  (4.2) requires, before </illustratedPartsCatalog>. The rest of the text is
  untouched. Throws PartError.
*/
function addPart(text, { figureNumber, item, indenture = '1', partNumber, manufacturer, description = '', quantity = '1' }) {
  if (!/<illustratedPartsCatalog[\s>]/.test(text) || !/<\/illustratedPartsCatalog>/.test(text)) throw new PartError('Parts are added to an illustrated parts data module (one with an <illustratedPartsCatalog>).');
  if (!/^\d{2,3}[A-Z]?$/.test(String(figureNumber))) throw new PartError('Figure number: two or three digits, for example 01.');
  if (!/^\d{3}[A-Z]?$/.test(String(item))) throw new PartError('Item: three digits, for example 010.');
  if (!/^[1-9]$/.test(String(indenture))) throw new PartError('Indenture: 1 to 9.');
  if (!PN.test(String(partNumber || ''))) throw new PartError('Part number: up to 32 letters, digits, spaces, dots, slashes, hyphens or underscores.');
  if (!CAGE.test(String(manufacturer || ''))) throw new PartError('Manufacturer code (CAGE): five letters or digits.');
  if (!/^\d{1,4}$|^AR$/.test(String(quantity))) throw new PartError('Quantity: a whole number, or AR (as required).');
  if (String(description).length > 200) throw new PartError('Description: at most 200 characters.');
  const taken = new RegExp(`<catalogSeqNumber\\b(?=[^>]*\\bfigureNumber="${figureNumber}")(?=[^>]*\\bitem="${item}")`);
  if (taken.test(text)) throw new PartError(`Figure ${figureNumber} item ${item} is already used in this module.`);
  const indent = (/\n([ \t]*)<\/illustratedPartsCatalog>/.exec(text) || [, '    '])[1];
  const i = `${indent}  `;
  const seg = description ? `\n${i}    <partSegment>\n${i}      <itemIdentData>\n${i}        <descrForPart>${esc(description)}</descrForPart>\n${i}      </itemIdentData>\n${i}    </partSegment>` : '';
  const block = `${i}<catalogSeqNumber figureNumber="${figureNumber}" item="${item}" indenture="${indenture}">\n${i}  <itemSeqNumber itemSeqNumberValue="001">\n${i}    <quantityPerNextHigherAssy>${esc(quantity)}</quantityPerNextHigherAssy>\n${i}    <partRef partNumberValue="${esc(partNumber)}" manufacturerCodeValue="${esc(manufacturer.toUpperCase())}"/>${seg}\n${i}  </itemSeqNumber>\n${i}</catalogSeqNumber>\n`;
  const at = text.lastIndexOf('</illustratedPartsCatalog>');
  const lineStart = text.lastIndexOf('\n', at) + 1;
  return text.slice(0, lineStart) + block + text.slice(lineStart);
}

module.exports = { parseIcn, usesOf, moduleTextsOf, assetTextsOf, icnCatalogue, partsCatalogue, addPart, PartError };
