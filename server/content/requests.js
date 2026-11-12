'use strict';
/*
  Publication approval requests: the fingerprint and the frozen snapshot
  (PROMPT.md "Approval workflow"; decisions.md W1-W5, P7).

  Sources of a publication = what its PDF is built from:
    publication.xml, project.json, every live data module the publication
    places (by dmRef code or by include file), the graphics those modules
    refer to (where the build finds them) and the project BREX modules they
    name. The fingerprint is SHA-256 over "rel<TAB>sha256" lines, sorted.

  The snapshot is a copy of those sources plus the PDF built at submission
  and the validation report, under <dataDir>/snapshots/<requestId>/, outside
  the workspace (an edit to the project can never reach it), written once
  and made read-only. manifest.json records every file's SHA-256.

  Stale: when the live sources stop matching a pending request's
  fingerprint, the request becomes `stale` and the Author must resubmit.
  Content is not locked while a request is pending (decisions.md P7).
*/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pmc = require('../../vendor/engine/pmc');
const graphics = require('./graphics');
const brex = require('./brex');
const { brexIndex } = require('./validation');
const { parseOwnDmc, formatDmc } = require('./dmc');

const PUBLICATION_REF = 'publication.xml';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walk(entries, fn) {
  for (const e of entries || []) { fn(e); if (e.type === 'folder') walk(e.children, fn); }
}

function codeOf(attrs) {
  const own = parseOwnDmc(`<dmIdent><dmCode ${Object.entries(attrs || {}).map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`).join(' ')}/></dmIdent>`);
  return own ? formatDmc(own).toUpperCase() : null;
}

/*
  The publication's source files, relative to the workspace, sorted.
  `modules`: live data module records. Returns { files, model, title }.
*/
function publicationSources(dir, modules) {
  const pmText = fs.readFileSync(path.join(dir, PUBLICATION_REF), 'utf8');
  // A JSS book (decisions.md FM3): the book, its settings, and the images it names by path.
  if (/^(?:\s*<\?[\s\S]*?\?>|\s*<!--[\s\S]*?-->)*\s*<jssbook[\s>]/.test(pmText)) {
    const files = new Set([PUBLICATION_REF]);
    if (fs.existsSync(path.join(dir, 'project.json'))) files.add('project.json');
    for (const m of pmText.matchAll(/\bsrc="((?:csdb|Media)\/[A-Za-z0-9][A-Za-z0-9._-]*)"/g)) if (fs.existsSync(path.join(dir, m[1]))) files.add(m[1]);
    const title = (/<bookName>([^<]*)<\/bookName>/.exec(pmText) || [, ''])[1].trim();
    return { files: [...files].sort(), model: { entries: [], meta: { pmTitle: title }, warnings: [] }, title };
  }
  const model = pmc.parsePm(pmText);
  const byCode = new Map(modules.map((m) => [m.dmc.toUpperCase(), m]));
  const byFile = new Map(modules.map((m) => [path.posix.basename(m.rel_path).toLowerCase(), m]));
  const placed = new Map();
  walk(model.entries, (e) => {
    let m = null;
    if (e.type === 'dm') m = byCode.get(codeOf(e.dmCode) || '');
    else if (e.type === 'include') m = byFile.get(String(e.href || '').replace(/^.*\//, '').toLowerCase());
    if (m) placed.set(m.rel_path, m);
  });

  const files = new Set([PUBLICATION_REF]);
  if (fs.existsSync(path.join(dir, 'project.json'))) files.add('project.json');
  const texts = [];
  for (const rel of placed.keys()) {
    try { texts.push(fs.readFileSync(path.join(dir, rel), 'utf8')); files.add(rel); } catch { /* missing file: validation reports it */ }
  }
  const declared = graphics.declaredEntities(texts);
  const index = brexIndex(dir);
  for (const t of texts) {
    for (const icn of graphics.referencedIcns(t)) { const f = graphics.findFile(dir, icn, declared); if (f) files.add(f); }
    const ref = brex.brexRefOf(t);
    if (ref && index.has(ref)) files.add(index.get(ref).rel);
  }
  return { files: [...files].sort(), model, title: model.meta.pmTitle || '' };
}

// { fingerprint, files: [{ rel, sha256, size }] }
function fingerprint(dir, rels) {
  const files = rels.map((rel) => {
    const buf = fs.readFileSync(path.join(dir, rel));
    return { rel, sha256: sha256(buf), size: buf.length };
  });
  const fp = sha256(files.map((f) => `${f.rel}\t${f.sha256}`).join('\n'));
  return { fingerprint: fp, files };
}

// The live fingerprint of a project's publication, or null if it cannot be read.
function liveFingerprint(dir, modules) {
  try {
    const { files } = publicationSources(dir, modules);
    return fingerprint(dir, files).fingerprint;
  } catch { return null; }
}

function makeReadOnly(target) {
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    const p = path.join(target, e.name);
    if (e.isDirectory()) makeReadOnly(p); else { try { fs.chmodSync(p, 0o444); } catch { /* best effort */ } }
  }
}

/*
  Write the snapshot. `sources` from fingerprint(); `pdfPath` the PDF just
  built; `report` the validation result. Returns { dir, pdfSha256 }.
*/
function writeSnapshot({ dataDir, requestId, workspace, sources, pdfPath, report, meta }) {
  const root = path.join(dataDir, 'snapshots');
  const dir = path.join(root, requestId);
  if (!/^[0-9a-f-]{36}$/.test(requestId) || fs.existsSync(dir)) throw new Error('snapshot exists or bad id');
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  for (const f of sources.files) {
    const from = path.join(workspace, f.rel);
    const to = path.join(dir, 'sources', f.rel);
    if (!to.startsWith(path.join(dir, 'sources') + path.sep)) throw new Error('snapshot path escapes');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  const pdf = fs.readFileSync(pdfPath);
  fs.writeFileSync(path.join(dir, 'publication.pdf'), pdf);
  fs.writeFileSync(path.join(dir, 'validation.json'), JSON.stringify(report, null, 2));
  const pdfSha256 = sha256(pdf);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...meta, fingerprint: sources.fingerprint, files: sources.files, pdf: { sha256: pdfSha256, size: pdf.length } }, null, 2));
  makeReadOnly(dir);
  return { dir: path.relative(dataDir, dir).split(path.sep).join('/'), pdfSha256 };
}

// Absolute path of a file inside a request's snapshot, contained.
function snapshotFile(dataDir, request, name) {
  const base = path.resolve(dataDir, request.snapshot_dir);
  const abs = path.resolve(base, name);
  if (!abs.startsWith(base + path.sep)) return null;
  return abs;
}

module.exports = { PUBLICATION_REF, publicationSources, fingerprint, liveFingerprint, writeSnapshot, snapshotFile };
