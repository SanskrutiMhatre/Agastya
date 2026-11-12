'use strict';
// Post-render sanity checks on the generated XSL-FO.
//
// These run on the FO rather than on the source or the stylesheets, so they
// hold for both pipelines and catch a bad reference however it arose — a
// stale unparsed-entity name, a wrong fallback folder, or a stylesheet that
// simply emitted nothing. FOP does not fail on a missing image: it logs and
// leaves a blank, so without this a build reports success while pages come
// out with holes in them.

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

// fo:external-graphic carries src either bare or wrapped in url('...').
const SRC_RE = /src="(?:url\((['"]?)([^'")]*)\1\)|([^"]*))"/g;

function imageRefs(foText) {
    const out = [];
    for (const m of String(foText || '').matchAll(SRC_RE)) {
        out.push(m[2] !== undefined ? m[2] : (m[3] || ''));
    }
    return out;
}

/*
  Whether an image src resolves on disk: true, false, or null when it cannot
  be told (a URL with a scheme other than file:). Relative paths resolve
  against `dir`; percent-encoding (spaces in an install path) is decoded.
*/
function resolves(dir, src) {
    let p = src;
    if (/^file:/i.test(p)) {
        try { p = fileURLToPath(p); } catch { return null; }
    } else if (/^[a-z][a-z0-9+.-]+:/i.test(p)) {
        return null;
    }
    const candidates = [p];
    try { const d = decodeURIComponent(p); if (d !== p) candidates.push(d); } catch { /* not encoded */ }
    return candidates.some((c) => fs.existsSync(path.isAbsolute(c) ? c : path.join(dir, c)));
}

/*
  Returns { total, empty, missing } where `missing` is a de-duplicated list of
  { src, count } for paths that do not resolve on disk. `empty` counts src=""
  separately: that is always a stylesheet bug rather than absent artwork, so
  it is worth distinguishing in the report.
*/
function checkImages(foPath, baseDir) {
    if (!fs.existsSync(foPath)) return { total: 0, empty: 0, missing: [] };
    const dir = baseDir || path.dirname(foPath);
    const refs = imageRefs(fs.readFileSync(foPath, 'utf8'));
    const counts = new Map();
    let empty = 0;
    for (const src of refs) {
        if (!src) { empty++; continue; }
        if (resolves(dir, src) !== false) continue;
        counts.set(src, (counts.get(src) || 0) + 1);
    }
    return {
        total: refs.length,
        empty,
        missing: [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([src, count]) => ({ src, count })),
    };
}

// Compact one-line summary, or '' when everything resolved.
function formatImageCheck(r) {
    if (!r || (!r.empty && !r.missing.length)) return '';
    const parts = [];
    if (r.empty) parts.push(`${r.empty} with no src (stylesheet bug)`);
    if (r.missing.length) {
        const shown = r.missing.slice(0, 5).map((m) => m.src + (m.count > 1 ? ` x${m.count}` : ''));
        const more = r.missing.length - shown.length;
        parts.push(`${r.missing.length} unresolved: ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`);
    }
    return parts.join('; ');
}

const GRAPHIC_RE = /<fo:external-graphic\b([^>]*?)(?:\/>|>\s*<\/fo:external-graphic>)/g;

/*
  FOP draws an image it cannot find as nothing: a figure keeps only its
  caption, a symbol leaves a gap, and the reader cannot tell artwork is
  missing. Each fo:external-graphic whose file does not resolve is replaced,
  in the FO file, by a small dashed box naming the missing file (an inline,
  so it is valid wherever the graphic was). Graphics that resolve, or whose
  src cannot be checked, are left alone. Returns the number replaced.
*/
function placeholderMissingImages(foPath, baseDir) {
    if (!fs.existsSync(foPath)) return 0;
    const dir = baseDir || path.dirname(foPath);
    const fo = fs.readFileSync(foPath, 'utf8');
    let replaced = 0;
    const out = fo.replace(GRAPHIC_RE, (whole, attrs) => {
        const m = /\bsrc="(?:url\((['"]?)([^'")]*)\1\)|([^"]*))"/.exec(attrs);
        const src = m ? (m[2] !== undefined ? m[2] : (m[3] || '')) : '';
        if (!src || resolves(dir, src) !== false) return whole;
        replaced++;
        const name = src.split(/[\\/]/).pop();
        return '<fo:inline border="0.5pt dashed #808080" padding="1pt 2pt" color="#505050"' +
            ' font-size="7pt" font-style="normal" font-weight="normal">' +
            `Artwork not available: ${name}</fo:inline>`;
    });
    if (replaced) fs.writeFileSync(foPath, out, 'utf8');
    return replaced;
}

module.exports = { imageRefs, checkImages, formatImageCheck, placeholderMissingImages };
