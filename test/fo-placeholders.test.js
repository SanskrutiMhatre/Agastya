'use strict';
// Missing artwork in the PDF (decisions.md PV39): every fo:external-graphic
// whose file is not there becomes a visible "Artwork not available" box
// before FOP runs; graphics that resolve, or cannot be checked, are untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { checkImages, placeholderMissingImages } = require('../vendor/engine/foChecks');
const { tmpdir } = require('./helpers');

const graphic = (src, extra = '') => `<fo:external-graphic src="${src}" content-width="scale-down-to-fit"${extra}/>`;
const fo = (body) => `<?xml version="1.0"?><fo:root xmlns:fo="http://www.w3.org/1999/XSL/Format"><fo:block>${body}</fo:block></fo:root>`;

test('missing images become a dashed box naming the file; present ones stay', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'csdb'));
  fs.writeFileSync(path.join(dir, 'csdb', 'ICN-HERE.png'), 'x');
  fs.mkdirSync(path.join(dir, 'with space'));
  fs.writeFileSync(path.join(dir, 'with space', 'logo.svg'), 'x');
  const body = [
    graphic("url('csdb/ICN-HERE.png')"),
    graphic("url('csdb/ICN-GONE-1.png')", ' width="100%"'),
    `Press <fo:external-graphic src="csdb/ICN-GONE-2.png" height="10mm"></fo:external-graphic> then`,
    graphic("url('with%20space/logo.svg')"),
    graphic(`url('${pathToFileURL(path.join(dir, 'csdb', 'ICN-HERE.png')).href}')`),
    graphic(path.join(dir, 'csdb', 'ICN-HERE.png')),
    graphic("url('https://example.invalid/a.png')"),
    graphic(''),
  ].join('');
  const file = path.join(dir, 'out.fo');
  fs.writeFileSync(file, fo(body));
  // Encoded and absolute paths that exist are no longer reported missing.
  assert.deepEqual(checkImages(file, dir).missing.map((m) => m.src), ['csdb/ICN-GONE-1.png', 'csdb/ICN-GONE-2.png']);
  assert.equal(placeholderMissingImages(file, dir), 2);
  const out = fs.readFileSync(file, 'utf8');
  assert.match(out, /<fo:inline border="0\.5pt dashed #808080"[^>]*>Artwork not available: ICN-GONE-1\.png<\/fo:inline>/);
  assert.match(out, /Press <fo:inline [^>]*>Artwork not available: ICN-GONE-2\.png<\/fo:inline> then/);
  assert.equal((out.match(/<fo:external-graphic/g) || []).length, 6);
  for (const kept of ["csdb/ICN-HERE.png'", 'with%20space/logo.svg', 'https://example.invalid/a.png', 'src=""']) assert.ok(out.includes(kept), kept);
  assert.deepEqual(checkImages(file, dir).missing, []);
});

test('an FO with every image present is not rewritten', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.png'), 'x');
  const file = path.join(dir, 'out.fo');
  const text = fo(graphic("url('a.png')"));
  fs.writeFileSync(file, text);
  const before = fs.statSync(file).mtimeMs;
  assert.equal(placeholderMissingImages(file, dir), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.equal(placeholderMissingImages(path.join(dir, 'none.fo'), dir), 0);
});
