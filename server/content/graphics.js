'use strict';
/*
  Graphics (ICN) handling.

  Resolution rule, shared with the PDF engine (vendor/pipeline/s1000dtojss/
  content.xsl) and the Agastya original (routes/graphics.ts): a data module
  that declares the ICN as an unparsed entity
  (<!ENTITY ICN-... SYSTEM "file.png" NDATA png>) names the file, which sits
  beside the module in csdb/. With no declaration the engine looks for
  Media/<ICN>.png. An upload is written to exactly the place the build will
  look, so "uploaded" always means "will appear in the PDF".

  As in the original, an ICN keeps the case it is written with and is
  matched case-insensitively (declarations, files and registry entries), so a
  file found on Windows is also found on a case-sensitive server; an upload
  takes the spelling the modules use. Uploads are limited to 64 MB.

  Only PNG, JPEG and GIF are accepted, recognised by their content, not their
  name. SVG is refused: it can carry script, and it is served back to
  browsers. (The original also lists TIFF and CGM, which FOP cannot render
  here.)
*/

const fs = require('node:fs');
const path = require('node:path');

const ICN_RE = /^ICN-[A-Za-z0-9][A-Za-z0-9-]{3,80}$/i;
const MAX_GRAPHIC_BYTES = 64 * 1024 * 1024;

function detectFormat(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a') return 'gif';
  return null;
}
const EXT = { png: '.png', jpeg: '.jpg', gif: '.gif' };
const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' };

// Trim and drop an image extension; the case is kept.
const normaliseIcn = (s) => String(s || '').trim().replace(/\.(png|jpe?g|gif)$/i, '');
const icnKey = (icn) => String(icn).toLowerCase();

// ICN (lower-cased key) -> declared file name, from every entity declaration in the given module texts.
function declaredEntities(xmlTexts) {
  const map = new Map();
  for (const text of xmlTexts) {
    const dt = /<!DOCTYPE[\s\S]*?\]>/.exec(text);
    if (!dt) continue;
    const re = /<!ENTITY\s+(ICN-[^\s>]+)\s+SYSTEM\s+["']([^"']+)["']\s+NDATA\s+\w+\s*>/gi;
    let m;
    while ((m = re.exec(dt[0]))) map.set(icnKey(m[1]), m[2]);
  }
  return map;
}

// Every ICN a module refers to through <graphic>/<symbol infoEntityIdent>, as written (first spelling wins).
function referencedIcns(text) {
  const out = new Map();
  const re = /<(?:graphic|symbol)\b[^>]*\binfoEntityIdent\s*=\s*["']\s*([^"'\s]+)\s*["']/g;
  let m;
  while ((m = re.exec(String(text)))) if (!out.has(icnKey(m[1]))) out.set(icnKey(m[1]), m[1]);
  return [...out.values()];
}

/*
  Where the build will look for an ICN's file, relative to the project:
  the declared name in csdb/, or Media/<ICN>.png.
*/
function expectedLocation(icn, declared) {
  const name = declared.get(icnKey(icn));
  if (name) {
    const base = path.basename(String(name).replace(/\\/g, '/'));
    if (base && base === String(name).replace(/\\/g, '/') && /^[A-Za-z0-9._-]+$/.test(base)) return { rel: `csdb/${base}`, declared: true };
  }
  return { rel: `Media/${icn}.png`, declared: false };
}

/*
  Where an image of this format is stored for an ICN: where the build looks
  when the format matches that file's extension; otherwise beside it under
  the format's own extension, which the build will not find (`warning`).
*/
function placeFor(icn, format, declared) {
  const exp = expectedLocation(icn, declared);
  const ext = path.extname(exp.rel).toLowerCase();
  const matches = (format === 'png' && ext === '.png') || (format === 'jpeg' && /\.jpe?g$/.test(ext)) || (format === 'gif' && ext === '.gif');
  const rel = matches ? exp.rel : `${path.posix.dirname(exp.rel)}/${icn}${EXT[format]}`;
  return {
    rel, expected: exp.rel, matches,
    warning: matches ? undefined : `The build looks for ${exp.rel}, but this is a ${format.toUpperCase()} image; it was stored as ${rel} and will not appear in the PDF until the module's declaration or the file is changed.`,
  };
}

// The real name of a file in dir/sub matching `name` case-insensitively, or null.
function entryLike(dir, sub, name) {
  let list = [];
  try { list = fs.readdirSync(path.join(dir, sub)); } catch { return null; }
  if (list.includes(name)) return name;
  const lower = name.toLowerCase();
  return list.find((f) => f.toLowerCase() === lower) || null;
}

// Find an existing file for an ICN: the expected location, else any image with the same stem (case-insensitive).
function findFile(dir, icn, declared) {
  const exp = expectedLocation(icn, declared);
  const [sub, name] = exp.rel.split('/');
  const hit = entryLike(dir, sub, name);
  if (hit) return `${sub}/${hit}`;
  for (const s of ['csdb', 'Media']) {
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif']) {
      const f = entryLike(dir, s, `${icn}${ext}`);
      if (f) return `${s}/${f}`;
    }
  }
  return null;
}

// The spelling the modules use for this ICN, if any refer to it.
function canonicalIcn(icn, referenced) {
  return referenced.find((r) => icnKey(r) === icnKey(icn)) || icn;
}

/*
  Suggest an unused ICN (the original's GET /graphics/next-icn): the highest
  sequence number among existing ICNs shaped ICN-<prefix>-<4-6 digits>-<suffix>
  is incremented with the pattern kept; a project with none gets
  ICN-<model>-00001-A-001-01.
*/
function nextIcn(existing, model) {
  const seen = new Set([...existing].map(icnKey));
  let best = null;
  for (const icn of existing) {
    const m = /^(ICN-.*?-)(\d{4,6})(-.*)$/.exec(icn);
    if (!m) continue;
    const seq = Number(m[2]);
    if (!best || seq > best.seq) best = { prefix: m[1], width: m[2].length, suffix: m[3], seq };
  }
  let suggestion;
  if (best) {
    let n = best.seq;
    do { n++; suggestion = `${best.prefix}${String(n).padStart(best.width, '0')}${best.suffix}`; }
    while (seen.has(icnKey(suggestion)) && n < best.seq + 10000);
  } else {
    const stem = String(model || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'PROJ';
    let n = 1;
    do { suggestion = `ICN-${stem}-${String(n).padStart(5, '0')}-A-001-01`; n++; }
    while (seen.has(icnKey(suggestion)) && n < 10000);
  }
  return suggestion;
}

// ICN-shaped file stems in csdb/ and Media/.
function icnFiles(dir) {
  const out = [];
  for (const sub of ['csdb', 'Media']) {
    let list = [];
    try { list = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const f of list) {
      const stem = f.replace(/\.[^.]+$/, '');
      if (/^ICN-/i.test(stem) && !/\.xml$/i.test(f)) out.push(stem);
    }
  }
  return out;
}

module.exports = {
  ICN_RE, MAX_GRAPHIC_BYTES, detectFormat, EXT, MIME, normaliseIcn, icnKey, declaredEntities, referencedIcns,
  expectedLocation, placeFor, findFile, canonicalIcn, nextIcn, icnFiles,
};
