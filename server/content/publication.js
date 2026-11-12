'use strict';
/*
  The publication module (PMC) builder, after the Agastya original
  (backend/src/services/PmcService.ts, routes/pmc.ts, frontend
  lib/pmcTree.ts), on our write path.

    readModel        publication.xml -> { meta, entries, warnings, counts, pool }
                     where pool = live data modules the publication does not
                     place (matched by code for dmRef entries and by file for
                     xi:include entries, as in the original)
    validateEntries  the tree a client sends back: types, keys and sizes
                     checked, unknown fields refused
    applyEntries     the new tree written into the EXISTING file: only the
                     <content> element is replaced, so the identification and
                     status section (brexDmRef, applic, schema location,
                     comments) survives exactly. The original's serialiser
                     rewrites that section from its model and drops what it
                     does not model; this keeps it.
    roundTrip        the saved text must parse back with the same counts and
                     the same modules in the same order (the original's
                     "reads back identically" guard), else nothing is written
    ietmForm/pdfForm the two export forms: dmRef (includes resolved back to
                     module identities) and xi:include (what the build reads)

  An empty index is refused unless the caller says so (allowEmpty), as in the
  original. Its publication.xml.bak is covered by the revision history.
*/

const fs = require('node:fs');
const path = require('node:path');
const pmc = require('../../vendor/engine/pmc');
const { resolveDmRefs, guardMissingIncludes, dmCodeString } = require('../../vendor/engine/resolveDmRefs');
const { parseOwnDmc, formatDmc, parseAttrs } = require('./dmc');

const MAX_ENTRIES = 5000;
const MAX_DEPTH = 10;

// ---- reading -----------------------------------------------------------------

function readHead(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(16384);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

// Identity fields for a <dmRef>, read from the module's own dmIdent (never its brexDmRef).
function readDmIdent(abs) {
  const head = readHead(abs);
  if (!head) return {};
  const scope = (/<dmIdent\b[^>]*>([\s\S]*?)<\/dmIdent>/.exec(head) || [null, ''])[1];
  const grab = (re) => { const m = re.exec(scope); return m ? parseAttrs(m[1]) : undefined; };
  const txt = (re) => { const m = re.exec(head); return m ? m[1].replace(/<[^>]+>/g, '').trim() : undefined; };
  const date = /<issueDate\b([^>]*)\/>/.exec(head);
  return {
    dmCode: grab(/<dmCode\b([^>]*?)\/?>/),
    identExtension: grab(/<identExtension\b([^>]*?)\/?>/),
    issueInfo: grab(/<issueInfo\b([^>]*?)\/?>/),
    language: grab(/<language\b([^>]*?)\/?>/),
    techName: txt(/<techName>([\s\S]*?)<\/techName>/),
    infoName: txt(/<infoName>([\s\S]*?)<\/infoName>/),
    issueDate: date ? parseAttrs(date[1]) : undefined,
  };
}

function walk(entries, fn) {
  for (const e of entries || []) { fn(e); if (e.type === 'folder') walk(e.children, fn); }
}

// Normalised own-code key for matching dmRef entries to modules.
const codeKey = (attrs) => {
  try { return dmCodeString(attrs || {}, null).toUpperCase(); } catch { return ''; }
};

/*
  `modules`: live data module records ({ id, dmc, rel_path, tech_name, info_name, status }).
  Returns the pool entries for those the publication does not place.
*/
function unplaced(dir, entries, modules) {
  const placedCodes = new Set();
  const placedFiles = new Set();
  walk(entries, (e) => {
    if (e.type === 'include' && e.href) placedFiles.add(e.href.replace(/^.*\//, '').toLowerCase());
    if (e.type === 'dm' && e.dmCode) placedCodes.add(codeKey(e.dmCode));
  });
  const out = [];
  for (const m of modules) {
    const file = path.posix.basename(m.rel_path);
    if (placedFiles.has(file.toLowerCase())) continue;
    const ident = readDmIdent(path.join(dir, m.rel_path));
    if (ident.dmCode && placedCodes.has(codeKey(ident.dmCode))) continue;
    out.push({ id: m.id, dmc: m.dmc, file, status: m.status, ...ident, techName: ident.techName || m.tech_name, infoName: ident.infoName || m.info_name });
  }
  return out.sort((a, b) => a.dmc.localeCompare(b.dmc));
}

// Where each placed entry resolves, for the tree's "missing" badges.
function resolution(entries, modules) {
  const byCode = new Map(modules.map((m) => [m.dmc.toUpperCase(), m]));
  const byFile = new Map(modules.map((m) => [path.posix.basename(m.rel_path).toLowerCase(), m]));
  const missing = [];
  walk(entries, (e) => {
    if (e.type === 'dm') {
      const own = parseOwnDmc(`<dmIdent><dmCode ${Object.entries(e.dmCode || {}).map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`).join(' ')}/></dmIdent>`);
      const code = own ? formatDmc(own) : null;
      if (!code || !byCode.has(code.toUpperCase())) missing.push(code || codeKey(e.dmCode));
    } else if (e.type === 'include') {
      if (!byFile.has(e.href.replace(/^.*\//, '').toLowerCase())) missing.push(e.href);
    }
  });
  return missing;
}

function readModel(dir, text, modules) {
  const model = pmc.parsePm(text);
  return {
    meta: model.meta,
    entries: model.entries,
    warnings: model.warnings,
    counts: pmc.countEntries(model.entries),
    pool: unplaced(dir, model.entries, modules),
    missing: resolution(model.entries, modules),
    // Display only: the project's module titles by code, for entries whose dmRef carries none.
    titles: Object.fromEntries(modules.map((m) => [m.dmc, `${m.tech_name}${m.info_name ? ` – ${m.info_name}` : ''}`])),
  };
}

// ---- validating what a client sends ------------------------------------------

class EntryError extends Error {}

const ATTR_VALUE = /^[A-Za-z0-9 ._:-]{0,40}$/;
const ATTR_KEYS = {
  dmCode: new Set(pmc.DM_CODE_KEYS),
  identExtension: new Set(['extensionProducer', 'extensionCode']),
  issueInfo: new Set(['issueNumber', 'inWork']),
  language: new Set(['languageIsoCode', 'countryIsoCode']),
  issueDate: new Set(['year', 'month', 'day']),
  pmCode: new Set(['modelIdentCode', 'pmIssuer', 'pmNumber', 'pmVolume']),
};
const FIELDS = {
  folder: new Set(['type', 'title', 'children', 'extra', 'page']),
  dm: new Set(['type', 'title', 'dmCode', 'identExtension', 'issueInfo', 'language', 'techName', 'infoName', 'issueDate', 'extra', 'page']),
  include: new Set(['type', 'title', 'href', 'hasFallback', 'extra', 'page']),
  pmRef: new Set(['type', 'title', 'pmCode', 'issueInfo', 'pmTitle', 'shortPmTitle', 'extra', 'page']),
};
// The page an entry is set on (decisions.md ST6): portrait (none), or one of the landscape ids s1000dtojss reads.
const PAGES = ['a4-landscape', 'a3-landscape'];

function str(v, where, max) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new EntryError(`${where} must be text.`);
  if (v.length > max) throw new EntryError(`${where} is longer than ${max} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new EntryError(`${where} contains control characters.`);
  return v;
}

function attrs(v, kind, where) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new EntryError(`${where} must be an object.`);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (!ATTR_KEYS[kind].has(k)) throw new EntryError(`${where} has an unknown field "${String(k).slice(0, 30)}".`);
    if (typeof val !== 'string' || !ATTR_VALUE.test(val)) throw new EntryError(`${where}.${k} is not a valid value.`);
    out[k] = val;
  }
  return out;
}

/*
  Returns a clean copy of the tree, or throws EntryError with a message that
  names the entry. Unknown fields and types are refused (decisions.md C2).
*/
function validateEntries(entries) {
  let count = 0;
  const visit = (list, depth, label) => {
    if (!Array.isArray(list)) throw new EntryError(`${label}: entries must be a list.`);
    if (depth > MAX_DEPTH) throw new EntryError(`Chapters may nest at most ${MAX_DEPTH} deep.`);
    return list.map((e, i) => {
      const where = `${label}${label ? '/' : 'Entry '}${i + 1}`;
      if (++count > MAX_ENTRIES) throw new EntryError(`A publication may have at most ${MAX_ENTRIES} entries.`);
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw new EntryError(`${where} is not an entry.`);
      const allowed = FIELDS[e.type];
      if (!allowed) throw new EntryError(`${where} has an unknown type.`);
      for (const k of Object.keys(e)) if (!allowed.has(k)) throw new EntryError(`${where} has an unknown field "${String(k).slice(0, 30)}".`);
      const extra = e.extra === undefined ? undefined : (() => {
        if (!Array.isArray(e.extra) || e.extra.length > 20) throw new EntryError(`${where}: unmodelled content is not valid.`);
        return e.extra.map((x, j) => str(x, `${where} unmodelled part ${j + 1}`, 20000));
      })();
      const out = { type: e.type };
      if (e.page !== undefined && e.page !== null && e.page !== '') {
        if (!PAGES.includes(e.page)) throw new EntryError(`${where}: the page is portrait, a4-landscape or a3-landscape.`);
        out.page = e.page;
      }
      const title = str(e.title, `${where} title`, 300);
      if (e.type === 'folder') {
        out.title = title || '';
        out.children = visit(e.children || [], depth + 1, where);
      } else if (e.type === 'dm') {
        if (title !== undefined) out.title = title;
        out.dmCode = attrs(e.dmCode, 'dmCode', `${where} dmCode`) || {};
        if (!out.dmCode.modelIdentCode) throw new EntryError(`${where} has no data module code.`);
        for (const k of ['identExtension', 'issueInfo', 'language', 'issueDate']) { const a = attrs(e[k], k, `${where} ${k}`); if (a) out[k] = a; }
        for (const k of ['techName', 'infoName']) { const t = str(e[k], `${where} ${k}`, 300); if (t !== undefined) out[k] = t; }
      } else if (e.type === 'include') {
        if (title !== undefined) out.title = title;
        out.href = str(e.href, `${where} file`, 200) || '';
        if (e.hasFallback !== undefined) { if (typeof e.hasFallback !== 'boolean') throw new EntryError(`${where} fallback must be true or false.`); out.hasFallback = e.hasFallback; }
      } else {
        if (title !== undefined) out.title = title;
        out.pmCode = attrs(e.pmCode, 'pmCode', `${where} pmCode`) || {};
        const ii = attrs(e.issueInfo, 'issueInfo', `${where} issueInfo`); if (ii) out.issueInfo = ii;
        for (const k of ['pmTitle', 'shortPmTitle']) { const t = str(e[k], `${where} ${k}`, 300); if (t !== undefined) out[k] = t; }
      }
      if (extra) out.extra = extra;
      return out;
    });
  };
  return visit(entries, 0, '');
}

// ---- writing -----------------------------------------------------------------

const XI_NS = 'http://www.w3.org/2001/XInclude';
const usesInclude = (entries) => { let any = false; walk(entries, (e) => { if (e.type === 'include') any = true; }); return any; };

/*
  The new tree written into the existing publication module text: the old
  <content>...</content> is replaced by the serialised entries; everything
  else is kept byte for byte. xmlns:xi is added to the root only when an
  include needs it and it is not declared yet.
*/
function applyEntries(existingText, entries) {
  const serial = pmc.serialisePm({ meta: {}, entries });
  const block = /\n?(\s*)<content>[\s\S]*<\/content>/.exec(serial);
  const newContent = block ? block[0].replace(/^\n/, '').trim() : '<content>\n  </content>';
  const m = /<content(\s[^>]*)?>[\s\S]*?<\/content>|<content(\s[^>]*)?\/>/.exec(existingText);
  let text;
  if (m) {
    // Keep any attributes the existing <content> carries.
    const attrsPart = m[1] || m[2] || '';
    text = existingText.slice(0, m.index) + newContent.replace(/^<content>/, `<content${attrsPart}>`) + existingText.slice(m.index + m[0].length);
  } else {
    const close = existingText.lastIndexOf('</pm>');
    if (close === -1) throw new EntryError('The publication module has no </pm> end tag.');
    text = `${existingText.slice(0, close)}  ${newContent}\n${existingText.slice(close)}`;
  }
  if (usesInclude(entries) && !new RegExp(`xmlns:xi\\s*=\\s*["']${XI_NS.replace(/[.]/g, '\\.')}["']`).test(text)) {
    text = text.replace(/<pm(\s|>)/, `<pm xmlns:xi="${XI_NS}"$1`);
  }
  return text;
}

// Every module in document order: the invariant a save must preserve.
function moduleIds(entries) {
  const out = [];
  walk(entries, (e) => {
    if (e.type === 'include') out.push(`href:${e.href}`);
    else if (e.type === 'dm') out.push(`dmc:${codeKey(e.dmCode)}`);
    else if (e.type === 'pmRef') out.push(`pm:${JSON.stringify(e.pmCode || {})}`);
  });
  return out;
}

// The saved text must read back as the same tree (counts and module order).
function roundTrip(text, entries) {
  let back;
  try { back = pmc.parsePm(text); } catch { return false; }
  const a = pmc.countEntries(entries), b = pmc.countEntries(back.entries);
  if (a.total !== b.total || a.dms !== b.dms || a.folders !== b.folders) return false;
  return JSON.stringify(moduleIds(entries)) === JSON.stringify(moduleIds(back.entries));
}

// ---- export forms ------------------------------------------------------------

// dmRef ("IETM") form: includes resolved back to the modules' own identities.
function toIetmEntries(dir, entries) {
  return (entries || []).map((e) => {
    if (e.type === 'folder') return { ...e, children: toIetmEntries(dir, e.children) };
    if (e.type !== 'include' || !e.href) return e;
    const name = e.href.replace(/^.*\//, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.xml$/i.test(name)) return e;
    const ident = readDmIdent(path.join(dir, 'csdb', name));
    if (!ident.dmCode) return e;
    const out = { type: 'dm', dmCode: ident.dmCode };
    if (e.title) out.title = e.title;
    for (const k of ['identExtension', 'issueInfo', 'language', 'techName', 'infoName', 'issueDate']) if (ident[k] !== undefined) out[k] = ident[k];
    return out;
  });
}

function ietmForm(dir, text) {
  const model = pmc.parsePm(text);
  return applyEntries(text, toIetmEntries(dir, model.entries));
}

// xi:include ("PDF") form: what the build consumes, generated on demand.
function pdfForm(dir, text) {
  const s1 = resolveDmRefs(text, path.join(dir, 'csdb'), 'csdb');
  return guardMissingIncludes(s1.text, dir).text;
}

module.exports = { readModel, validateEntries, applyEntries, roundTrip, ietmForm, pdfForm, moduleIds, readDmIdent, EntryError, MAX_ENTRIES };
