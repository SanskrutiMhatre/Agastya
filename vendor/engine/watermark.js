'use strict';
// Watermark rendering for the PDF pipeline.
//
// Both build engines already accept a `watermark.image.uri` parameter and set
// it as the region-body background; this module is what actually produces
// that image. One SVG generator covers every style so the three look like
// one family and a new style is a case here rather than a new mechanism:
//
//   horizontal  one large line across the middle of the page
//   diagonal    the same line rotated up the page (the classic DRAFT stamp)
//   tiled       a small line repeated across the whole page
//
// The generated file is written into the project directory as a build
// artefact (like jss-output.fo), so it is regenerated on every build and
// never becomes stale state someone has to clean up.
//
// A "NOT RELEASED" watermark is not a style choice: an unreleased document
// must carry it, which is why resolveWatermark() below decides the effective
// settings rather than any caller.

const fs = require('fs');
const path = require('path');

const STYLES = ['horizontal', 'diagonal', 'tiled'];
const WATERMARK_FILE = '_watermark.svg';

/*
  Fallback printable box (mm), used only if a caller has no real page geometry
  to hand in — server.js always computes one from the project's actual layout
  settings (see printableBoxMm there), so this exists purely so the module
  still produces something sane if it is ever called without one.
*/
const FALLBACK_BOX = { w: 167, h: 217 };
const TILE = { w: 70, h: 70 };

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/*
  Font size for `text` set at `rotateDeg` inside a `box.w` × `box.h` mm area.

  THIS is the calculation that was actually broken: the previous version chose
  a size to make the text's UNROTATED width fill most of a target box, then
  rotated the result — without ever checking what the ROTATED text's own
  bounding box came out to. Rotating a 200mm-wide line by 45° needs roughly
  280mm of clearance in EACH direction (its own diagonal), not 200mm, so a
  watermark sized that way ran off every edge of the region it was meant to
  sit inside — worse for a short custom word than for "NOT RELEASED", because
  a short string gave the old per-character budget more size to spend before
  the (absent) rotation check would have caught it.

  This works backwards from the real rotated footprint instead. At font-size
  `s`, a string of `n` characters has an unrotated box roughly `n·k·s` wide by
  `s` tall (k ≈ 0.62 is an average bold-sans glyph width). Rotated by θ, its
  axis-aligned bounding box is:
    width  = (n·k·s)·|cosθ| + s·|sinθ|
    height = (n·k·s)·|sinθ| + s·|cosθ|
  Both are solved for the largest `s` that keeps both within `box`, scaled by
  `margin` so the mark sits inside the printable area with visible clearance
  rather than touching its edge exactly.
*/
const GLYPH_WIDTH_RATIO = 0.62;

function fitRotatedFontSize(text, box, rotateDeg, { cap = 30, margin = 0.88 } = {}) {
  const n = Math.max(1, String(text).length);
  const rad = Math.abs(rotateDeg) * Math.PI / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const k = GLYPH_WIDTH_RATIO;
  const byWidth = (box.w * margin) / (n * k * c + s);
  const byHeight = (box.h * margin) / (n * k * s + c);
  return Math.max(6, Math.min(cap, byWidth, byHeight));
}

function svgDocument({ width, height, body }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">
${body}
</svg>
`;
}

function textNode({ x, y, size, text, rotate, opacity, color }) {
  const t = rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : '';
  return `  <text x="${x}" y="${y}"${t} font-family="Helvetica, Arial, sans-serif"` +
    ` font-size="${size.toFixed(2)}" font-weight="bold" fill="${color}" fill-opacity="${opacity}"` +
    ` text-anchor="middle" dominant-baseline="middle">${escapeXml(text)}</text>`;
}

/*
  Build the SVG for one style. Returns the markup plus the background-repeat
  the stylesheet must use — a tiled watermark is a small image repeated, the
  other two are one image sized to the printable box and placed once.

  `box` is the real printable area (mm) this watermark will sit inside — see
  printableBoxMm() in server.js, which derives it from the project's actual
  page-geometry settings rather than a guessed constant.
*/
function buildSvg({ text, style, color = '#9AA3AF', opacity = 0.28, box }) {
  const st = STYLES.includes(style) ? style : 'diagonal';
  const printable = box && box.w > 0 && box.h > 0 ? box : FALLBACK_BOX;

  if (st === 'tiled') {
    // Capped well below what fitRotatedFontSize would allow in a 70mm tile —
    // a dense, subtle repeating mark is the point of this style, not the
    // largest word that technically fits. The rotation-aware fit is still the
    // ceiling underneath that cap, so an unusually long custom watermark text
    // cannot overflow its own tile the way the old width-only formula could.
    const size = fitRotatedFontSize(text, TILE, 30, { cap: 9, margin: 0.92 });
    // Two offset rows read as a pattern rather than a grid of columns.
    const body = [
      textNode({ x: TILE.w / 2, y: TILE.h * 0.28, size, text, rotate: -30, opacity, color }),
      textNode({ x: 0, y: TILE.h * 0.78, size, text, rotate: -30, opacity, color }),
      textNode({ x: TILE.w, y: TILE.h * 0.78, size, text, rotate: -30, opacity, color }),
    ].join('\n');
    return { svg: svgDocument({ width: TILE.w, height: TILE.h, body }), repeat: 'repeat' };
  }

  const rotateDeg = st === 'diagonal' ? 45 : 0;
  const size = fitRotatedFontSize(text, printable, rotateDeg, { cap: st === 'diagonal' ? 32 : 26 });
  const body = textNode({ x: printable.w / 2, y: printable.h / 2, size, text, rotate: -rotateDeg, opacity, color });
  return { svg: svgDocument({ width: printable.w, height: printable.h, body }), repeat: 'no-repeat' };
}

/*
  THE watermark decision, in one place.

  An unreleased document is stamped NOT RELEASED whatever the project's own
  watermark settings say — that is the point of the stamp, so it is not
  something a setting can switch off. A released one uses the project's
  watermark if it is enabled, and nothing otherwise.
*/
function resolveWatermark({ settings, released }) {
  const s = settings || {};
  if (!released) {
    return { enabled: true, text: 'NOT RELEASED', style: 'diagonal', forced: true, color: '#C2410C', opacity: 0.3 };
  }
  const text = String(s.text == null ? '' : s.text).trim();
  if (!s.enabled || !text) return { enabled: false, forced: false };
  return {
    enabled: true,
    text,
    style: STYLES.includes(s.style) ? s.style : 'diagonal',
    forced: false,
    color: '#9AA3AF',
    opacity: 0.28,
  };
}

/*
  Write the watermark for this build and hand back what the stylesheets need.
  Returns null when no watermark applies, and always clears a previous build's
  file first so a disabled watermark cannot linger through a stale artefact.

  `box` is the real printable area (mm) for THIS project's page geometry — see
  printableBoxMm() in server.js. Passed through so the horizontal/diagonal
  styles size themselves to what will actually be visible without clipping.
*/
function writeWatermark(projectDir, resolved, box) {
  const abs = path.join(projectDir, WATERMARK_FILE);
  try { fs.rmSync(abs, { force: true }); } catch { /* nothing to clear */ }
  if (!resolved || !resolved.enabled) return null;
  const { svg, repeat } = buildSvg({ ...resolved, box });
  fs.writeFileSync(abs, svg, 'utf8');
  // Relative on purpose: xsltproc runs with cwd = the project directory and
  // FOP resolves the FO's relative URIs against the same place, so an
  // absolute (drive-lettered / dotted) path is exactly what breaks here.
  return { uri: WATERMARK_FILE, repeat, text: resolved.text, style: resolved.style };
}

module.exports = { buildSvg, resolveWatermark, writeWatermark, STYLES, WATERMARK_FILE };
