'use strict';
/*
  CSDB packages (Phase 6, decisions.md CX1 to CX6): a project's content
  as one zip, out and in.

  Export: every live data module, the publication module and every image in
  csdb/ and Media/, at their workspace paths, with agastya-package.json
  listing each file, its SHA-256 and, for modules, the code and status.

  Import: a zip of data modules and graphics is read and checked first
  (planImport), and nothing is written by that check. The plan is the report
  the user sees: per file, whether it will be imported, and why not. The
  import itself re-reads the same upload and writes only what the plan
  accepts, modules through the normal write path.

  The zip is untrusted:
    - entry names are never used to place a file: a module goes to
      csdb/DMC-<its own code>.xml and a graphic to where the build looks for
      its ICN (graphics.js). Names with "..", absolute paths, drive letters,
      backslashes or NUL are still refused and reported;
    - symbolic links, encrypted entries and directories are skipped;
    - entry count, the size of each entry and the total are capped, and an
      entry is inflated as a stream that stops at its cap, so a size header
      that lies cannot inflate past it (a zip bomb);
    - every module passes the same XML safety guard as any save
      (xmlcheck.js), and graphics are recognised by content (PNG, JPEG, GIF).
*/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const dmcLib = require('./dmc');
const graphics = require('./graphics');
const { assertWritableXml, ContentError, MAX_XML_BYTES } = require('./xmlcheck');

const FORMAT = 'agastya-csdb-package';
const FORMAT_VERSION = 1;
const MANIFEST = 'agastya-package.json';
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024; // the upload itself
const MAX_XML_UPLOAD = MAX_XML_BYTES + 1024; // one XML file
const MAX_ENTRIES = 5000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024; // everything inflated
const MAX_VALIDATED = 300; // modules checked against XSD and BREX in one preview

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ── Reading a zip safely ────────────────────────────────────────────────────

// Why an entry name may not be read, or null.
function unsafeName(name) {
  if (!name || name.includes('\0')) return 'The name is empty or contains a NUL character.';
  if (name.includes('\\')) return 'The name contains a backslash.';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'The name is an absolute path.';
  if (name.split('/').some((s) => s === '..')) return 'The name leads outside the package ("..").';
  return null;
}

// Files a packer adds that are not content.
const NOISE = (name) => /(^|\/)__MACOSX\//.test(name) || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name) || /(^|\/)\._/.test(name);

class InflateLimit extends Error {}

// Inflate one entry, stopping as soon as it passes `cap` bytes.
function inflate(entry, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let helper;
    try { helper = entry.internalStream('nodebuffer'); } catch (e) { reject(e); return; }
    helper
      .on('data', (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > cap) { done = true; helper.pause(); reject(new InflateLimit()); return; }
        chunks.push(chunk);
      })
      .on('error', (e) => { if (!done) { done = true; reject(e); } })
      .on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } })
      .resume();
  });
}

const isSymlink = (entry) => typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0o170000) === 0o120000;
const capFor = (name) => (/\.xml$/i.test(name) ? MAX_XML_BYTES : graphics.MAX_GRAPHIC_BYTES);

/*
  The entries of a package: [{ name, buffer }] for those that could be read,
  and [{ name, reason }] for those that were refused. Throws ContentError for
  a file that is not a zip or breaks the package limits.
*/
async function readPackage(buffer) {
  if (!buffer || !buffer.length) throw new ContentError(400, 'VALIDATION', 'Choose a .zip package to upload.');
  if (buffer.length > MAX_PACKAGE_BYTES) throw new ContentError(413, 'TOO_LARGE', 'The package is larger than 200 MB.');
  let zip;
  try { zip = await JSZip.loadAsync(buffer, { createFolders: false }); } catch {
    throw new ContentError(400, 'UNREADABLE', 'The file could not be read as a zip package.');
  }
  const all = Object.values(zip.files);
  if (all.length > MAX_ENTRIES) throw new ContentError(413, 'TOO_MANY_FILES', `The package holds more than ${MAX_ENTRIES} files.`);
  const files = [], refused = [];
  let manifest = null;
  let total = 0;
  for (const entry of all) {
    // JSZip strips "../" from names it loads; the name as written is what is judged.
    const name = entry.unsafeOriginalName || entry.name;
    if (entry.dir || NOISE(name)) continue;
    const bad = unsafeName(name);
    if (bad) { refused.push({ name, reason: bad }); continue; }
    if (isSymlink(entry)) { refused.push({ name, reason: 'A symbolic link: not read.' }); continue; }
    const cap = name === MANIFEST ? 1024 * 1024 : capFor(name);
    const declared = entry._data && entry._data.uncompressedSize;
    if (typeof declared === 'number' && declared > cap) { refused.push({ name, reason: tooLarge(name) }); continue; }
    let buf;
    try { buf = await inflate(entry, cap); } catch (e) {
      refused.push({ name, reason: e instanceof InflateLimit ? tooLarge(name) : 'The file could not be read from the zip (damaged or encrypted).' });
      continue;
    }
    total += buf.length;
    if (total > MAX_TOTAL_BYTES) throw new ContentError(413, 'TOO_LARGE', 'The package holds more than 512 MB once unpacked.');
    if (name === MANIFEST) { manifest = readManifest(buf); continue; }
    files.push({ name, buffer: buf });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, refused, manifest };
}

const tooLarge = (name) => (/\.xml$/i.test(name) ? 'Larger than 8 MB, the limit for a data module.' : 'Larger than 64 MB, the limit for a graphic.');

// Our own manifest, when the package came from an Agastya export: shown, never trusted for placement.
function readManifest(buf) {
  try {
    const m = JSON.parse(buf.toString('utf8'));
    if (!m || m.format !== FORMAT) return null;
    return { format: m.format, version: m.version, project: String(m.project || '').slice(0, 200), exportedAt: String(m.exportedAt || '').slice(0, 40), files: Array.isArray(m.files) ? m.files.length : 0 };
  } catch { return null; }
}

// ── Planning an import ──────────────────────────────────────────────────────

// UTF-8 (or plain ASCII) only, as with every other way in; the byte-order mark goes, as when a browser reads the file.
function decodeXml(buf) {
  const head = buf.slice(0, 200).toString('latin1');
  const enc = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head.replace(/^\uFEFF|^\u00EF\u00BB\u00BF/, ''));
  if (enc && !/^(utf-?8|us-ascii|ascii)$/i.test(enc[1])) return { error: `Declared as ${enc[1]}: only UTF-8 files are imported. Save it as UTF-8 and try again.` };
  if (buf[0] === 0xff && buf[1] === 0xfe || buf[0] === 0xfe && buf[1] === 0xff) return { error: 'A UTF-16 file: only UTF-8 files are imported. Save it as UTF-8 and try again.' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf) }; } catch {
    return { error: 'Not valid UTF-8 text: only UTF-8 files are imported.' };
  }
}

const isPublicationModule = (text) => /^(?:\s*<\?[\s\S]*?\?>|\s*<!--[\s\S]*?-->|\s*<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>)*\s*<pm[\s>]/.test(text);

/*
  The plan: what an import of this package would do in this project.
    dir           the project workspace
    liveCodes     Set of data module codes live in the project
    projectTexts  the live modules' XML (for graphic declarations and references)
    locked        Map rel -> lock (files frozen by a pending request)
    validate      async (rel, text) -> { errors, firstError, issue, schemaChecked } | null
  Returns { items, counts, manifest }. Each item is
    { name, kind: 'module'|'graphic'|'publication'|'other', status: 'import'|'exists'|'duplicate'|'refused'|'ignored', message?, warnings[], ... }
  and, for an item to import, `_write` with what the import needs (never sent to the client).
*/
async function planImport(pkg, { dir, liveCodes, projectTexts = [], locked = new Map(), validate = null, newProject = false }) {
  const items = [];
  /*
    Into a project being created from the package (decisions.md WS3), the
    publication (a <pm>, or a <jssbook> for a JSS project), the branding
    images in Media/ and the settings in project.json come too; into an
    existing project they are left alone (CX4).
  */
  let publication = null;
  for (const r of pkg.refused) items.push({ name: r.name, kind: kindOf(r.name), status: 'refused', message: r.reason, warnings: [] });

  // Modules first: their declarations decide where the package's graphics go.
  const seen = new Map(); // code -> name of the first file with it
  const modules = [];
  for (const f of pkg.files.filter((x) => /\.xml$/i.test(x.name))) {
    const item = { name: f.name, kind: 'module', status: 'refused', warnings: [] };
    items.push(item);
    const dec = decodeXml(f.buffer);
    if (dec.error) { item.message = dec.error; continue; }
    const text = dec.text;
    try { await assertWritableXml(text); } catch (e) {
      if (!(e instanceof ContentError)) throw e;
      item.message = e.message; continue;
    }
    const book = /^(?:\s*<\?[\s\S]*?\?>|\s*<!--[\s\S]*?-->)*\s*<jssbook[\s>]/.test(text);
    if (isPublicationModule(text) || book) {
      item.kind = 'publication';
      if (!newProject) {
        item.status = 'ignored';
        item.message = 'A publication module: not imported into an existing project. Use Publication → Import XML to replace the publication.';
      } else if (publication) {
        item.status = 'duplicate'; item.message = `A second publication (${publication.name} is used): skipped.`;
      } else {
        item.status = 'import'; item.target = 'publication.xml'; item.format = book ? 'jss' : 's1000d';
        item._write = { text };
        publication = item;
      }
      continue;
    }
    const id = dmcLib.readIdentity(text);
    if (!id.isDataModule || !id.dmc) { item.message = 'Not an S1000D data module with a valid data module code in its dmIdent.'; continue; }
    const code = dmcLib.formatDmc(id.dmc);
    const target = `csdb/${dmcLib.dmcFilename(id.dmc)}`;
    Object.assign(item, { code, target, techName: id.techName, infoName: id.infoName, schemaType: id.schemaType || 'descript', issue: id.issue });
    if (liveCodes.has(code)) { item.status = 'exists'; item.message = `Data module ${code} is already in this project: skipped, nothing replaced.`; continue; }
    if (fs.existsSync(path.join(dir, target))) { item.status = 'exists'; item.message = `A file ${path.posix.basename(target)} is already in the project: skipped, nothing replaced.`; continue; }
    if (seen.has(code)) { item.status = 'duplicate'; item.message = `The same code as ${seen.get(code)}, earlier in the package: skipped.`; continue; }
    seen.set(code, f.name);
    if (path.posix.basename(f.name) !== path.posix.basename(target)) item.warnings.push(`The file name does not match the code; it is stored as ${path.posix.basename(target)}.`);
    item.status = 'import';
    item._write = { text };
    modules.push({ item, text });
  }

  const allTexts = [...projectTexts, ...modules.map((m) => m.text)];
  const declared = graphics.declaredEntities(allTexts);
  const referenced = new Map();
  for (const t of allTexts) for (const icn of graphics.referencedIcns(t)) if (!referenced.has(graphics.icnKey(icn))) referenced.set(graphics.icnKey(icn), icn);

  const seenIcn = new Map();
  const incoming = new Set();
  for (const f of pkg.files.filter((x) => !/\.xml$/i.test(x.name))) {
    const item = { name: f.name, kind: 'graphic', status: 'refused', warnings: [] };
    items.push(item);
    if (f.name === 'project.json') {
      item.kind = 'settings';
      if (!newProject) { item.status = 'ignored'; item.message = 'Project settings: applied only when a project is created from the package.'; continue; }
      try { item._write = { json: JSON.parse(f.buffer.toString('utf8')) }; item.status = 'import'; } catch { item.message = 'project.json is not valid JSON.'; }
      continue;
    }
    const format = graphics.detectFormat(f.buffer);
    const given = graphics.normaliseIcn(path.posix.basename(f.name));
    if (!format) {
      if (!/\.(png|jpe?g|gif|svg|tiff?|cgm|bmp|webp)$/i.test(f.name)) { item.kind = 'other'; item.status = 'ignored'; item.message = 'Not a data module or a graphic: ignored.'; continue; }
      item.message = 'Not a PNG, JPEG or GIF image (recognised by its content): SVG, TIFF and CGM are not accepted.'; continue;
    }
    if (!graphics.ICN_RE.test(given)) {
      // Branding images (emblem, logos) come with an export; they belong to the project, not the CSDB.
      const base = path.posix.basename(f.name);
      if (newProject && /^Media\//.test(f.name) && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|gif)$/i.test(base) && !seenIcn.has(`media:${base.toLowerCase()}`)) {
        seenIcn.set(`media:${base.toLowerCase()}`, f.name);
        Object.assign(item, { kind: 'branding', status: 'import', target: `Media/${base}`, format, _write: { buffer: f.buffer } });
        continue;
      }
      item.status = 'ignored'; item.message = 'Not named as an ICN (ICN-…): ignored. Rename it to its ICN to import it as a graphic.'; continue;
    }
    const icn = graphics.canonicalIcn(given, [...referenced.values()]);
    const key = graphics.icnKey(icn);
    item.icn = icn;
    if (seenIcn.has(key)) { item.status = 'duplicate'; item.message = `The same ICN as ${seenIcn.get(key)}, earlier in the package: skipped.`; continue; }
    seenIcn.set(key, f.name);
    const place = graphics.placeFor(icn, format, declared);
    item.target = place.rel;
    const have = graphics.findFile(dir, icn, declared);
    if (have) {
      let same = false;
      try { same = sha256(fs.readFileSync(path.join(dir, have))) === sha256(f.buffer); } catch { /* unreadable: treated as different */ }
      item.status = 'exists';
      item.message = same ? 'Already in the project, identical: skipped.' : 'Already in the project with different content: skipped, nothing replaced. Upload it on the Graphics tab to replace it.';
      incoming.add(key);
      continue;
    }
    if (locked.has(place.rel)) { item.message = 'Frozen by a submitted publication awaiting approval.'; continue; }
    if (!place.matches) item.warnings.push(place.warning);
    if (!referenced.has(key)) item.warnings.push('No data module in the project or the package refers to this ICN.');
    item.status = 'import';
    item.format = format;
    item._write = { buffer: f.buffer, format, icn };
    incoming.add(key);
  }

  // What the imported modules will show as missing artwork.
  let validated = 0;
  for (const { item, text } of modules) {
    const missing = graphics.referencedIcns(text).filter((icn) => !incoming.has(graphics.icnKey(icn)) && !graphics.findFile(dir, icn, declared));
    if (missing.length) item.warnings.push(`${missing.length} graphic${missing.length === 1 ? '' : 's'} not in the package or the project: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}.`);
    if (!validate) continue;
    if (validated >= MAX_VALIDATED) { item.validation = null; continue; }
    validated++;
    item.validation = await validate(item.target, text);
  }

  const counts = { import: 0, exists: 0, duplicate: 0, refused: 0, ignored: 0, modules: 0, graphics: 0 };
  for (const it of items) {
    counts[it.status]++;
    if (it.status === 'import' && it.kind === 'module') counts.modules++;
    if (it.status === 'import' && it.kind === 'graphic') counts.graphics++;
  }
  // A JSS package is a book and its artwork; it holds no data modules.
  const format = publication ? publication.format : 's1000d';
  if (format === 'jss') {
    for (const it of items) {
      if (it.kind === 'module' && it.status === 'import') { it.status = 'refused'; it.message = 'A JSS project holds no data modules.'; delete it._write; counts.import--; counts.modules--; counts.refused++; }
    }
  }
  return { items, counts, manifest: pkg.manifest, format, notValidated: Math.max(0, modules.length - MAX_VALIDATED) };
}

const kindOf = (name) => (/\.xml$/i.test(name) ? 'module' : 'graphic');

// The plan as sent to the client: nothing that is content.
function planOut(plan) {
  return { ...plan, items: plan.items.map(({ _write, ...rest }) => rest) };
}

// ── Export ─────────────────────────────────────────────────────────────────

/*
  The project as a zip. `modules`: the live data_modules rows. Files that
  cannot be read are left out and listed in the manifest's `missing`.
*/
async function exportPackage({ dir, project, modules, by, now }) {
  const zip = new JSZip();
  const files = [], missing = [];
  const add = (rel, extra = {}) => {
    let buf;
    try { buf = fs.readFileSync(path.join(dir, rel)); } catch { missing.push(rel); return; }
    zip.file(rel, buf, { date: now, binary: true });
    files.push({ path: rel, size: buf.length, sha256: sha256(buf), ...extra });
  };
  for (const m of [...modules].sort((a, b) => a.rel_path.localeCompare(b.rel_path))) add(m.rel_path, { kind: 'module', code: m.dmc, status: m.status, issue: m.issue || null });
  if (fs.existsSync(path.join(dir, 'publication.xml'))) add('publication.xml', { kind: 'publication' });
  // The publication settings (identity, publishers, page, pipeline, watermark) travel with the project (decisions.md WS3).
  if (fs.existsSync(path.join(dir, 'project.json'))) add('project.json', { kind: 'settings' });
  for (const sub of ['csdb', 'Media']) {
    let list = [];
    try { list = fs.readdirSync(path.join(dir, sub)).sort(); } catch { continue; }
    for (const f of list) {
      if (!/\.(png|jpe?g|gif)$/i.test(f)) continue;
      let st; try { st = fs.lstatSync(path.join(dir, sub, f)); } catch { continue; }
      if (st.isFile()) add(`${sub}/${f}`, { kind: 'graphic' });
    }
  }
  const manifest = {
    format: FORMAT, version: FORMAT_VERSION, project: project.name, projectFormat: project.format || 's1000d', exportedAt: now.toISOString(), exportedBy: by,
    counts: { modules: files.filter((f) => f.kind === 'module').length, graphics: files.filter((f) => f.kind === 'graphic').length },
    files, missing,
  };
  zip.file(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', { date: now });
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
  return { buffer, manifest };
}

module.exports = {
  readPackage, planImport, planOut, exportPackage, unsafeName, decodeXml,
  MANIFEST, FORMAT, MAX_PACKAGE_BYTES, MAX_XML_UPLOAD, MAX_ENTRIES, MAX_TOTAL_BYTES,
};
