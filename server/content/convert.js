'use strict';
/*
  S1000D to JSS conversion (Phase 7, decisions.md FM4, FM5).

  Not a new mapping: the conversion is the first stage of the reference's own
  "Customize (JSS)" build (vendor/pipeline/s1000dtojss), which every S1000D
  publication already goes through on its way to PDF. The source project is
  copied to a temporary folder and built there, so nothing of it is touched,
  and the <jssbook> that stage writes becomes the new project's book. Its
  front-matter pages, which it includes by XInclude, are inlined, because a
  JSS book may contain no XInclude (decisions.md C6); any other include
  stops the conversion instead of being dropped.

  The report says what the conversion transformed and what it may have
  lost:
    - unmapped: elements the stage-1 stylesheet reported as dropped
      (vendor/engine/build.js "Unmapped elements (content dropped)");
    - unhandled: element names in the source modules that s1000dtojss never
      names, which its default rule reduces to their text;
    - counts of figures, tables, notices and steps before and after.
*/

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pdf = require('../publish/pdf');

const PIPELINE = path.join(__dirname, '..', '..', 'vendor', 'pipeline', 's1000dtojss');
const SKIP = /^(\.previews|\.deleted|source)$|^(output\.(pdf|fo)|jss-book\.xml|_.*)$/;
const INCLUDE = /<xi:include\s+href="(jss\/frontmatter\/[A-Za-z0-9][A-Za-z0-9._-]*\.xml)"\s*\/>/g;
const COUNTED = {
  figures: ['figure'], tables: ['table'], warnings: ['warning'], cautions: ['caution'], notes: ['note'],
};

// Element names s1000dtojss names anywhere (match, select, test, call): what it handles.
let handled = null;
function handledNames() {
  if (handled) return handled;
  handled = new Set();
  for (const f of fs.readdirSync(PIPELINE).filter((x) => x.endsWith('.xsl'))) {
    const text = fs.readFileSync(path.join(PIPELINE, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of text.matchAll(/\b(?:match|select|test)="([^"]*)"/g)) {
      for (const n of m[1].replace(/'[^']*'/g, '').matchAll(/[A-Za-z_][\w-]*/g)) handled.add(n[0]);
    }
  }
  return handled;
}

function countElements(text) {
  const out = new Map();
  for (const m of String(text).replace(/<!--[\s\S]*?-->/g, '').matchAll(/<([A-Za-z_][\w.-]*)[\s>/]/g)) out.set(m[1], (out.get(m[1]) || 0) + 1);
  return out;
}
const sum = (maps, names) => names.reduce((n, k) => n + maps.reduce((a, m) => a + (m.get(k) || 0), 0), 0);

class ConvertError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 422; }
}

/*
  Convert the S1000D project in `srcDir`. `modules` are its live data module
  rows. Resolves to { book, images: [{ rel, buffer }], report }.
*/
async function s1000dToJss({ srcDir, modules, log = console, onMessage = () => {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agastya-convert-'));
  try {
    const work = path.join(tmp, 'p');
    fs.cpSync(srcDir, work, { recursive: true, filter: (from) => from === srcDir || !SKIP.test(path.basename(from)) });
    // The default pipeline is the one that writes a book; a project set to the direct pipeline is converted the same way.
    const pjPath = path.join(work, 'project.json');
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    pj.pipeline = 's1000dtojss';
    fs.writeFileSync(pjPath, JSON.stringify(pj));
    const built = await pdf.buildPublication(work, { log, onMessage });
    let book = fs.readFileSync(path.join(work, pdf.OUTPUT.book), 'utf8');

    let inlined = 0;
    book = book.replace(INCLUDE, (m, href) => {
      const file = path.join(work, href);
      if (!fs.existsSync(file)) throw new ConvertError('CONVERSION_FAILED', `The front-matter page ${href} the conversion included is missing.`);
      inlined++;
      return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/^\s*<\?xml[^>]*\?>\s*/, '');
    });
    if (/<xi:include\b|XInclude/.test(book.replace(/xmlns:xi="http:\/\/www\.w3\.org\/2001\/XInclude"/g, ''))) {
      throw new ConvertError('CONVERSION_FAILED', 'The converted book still includes other files; it was not converted rather than lose them.');
    }
    book = book.replace(/\s+xmlns:xi="http:\/\/www\.w3\.org\/2001\/XInclude"/g, '');

    const sources = modules.map((m) => { try { return fs.readFileSync(path.join(srcDir, m.rel_path), 'utf8'); } catch { return ''; } });
    const srcCounts = sources.map(countElements);
    const bookCounts = [countElements(book)];
    const known = handledNames();
    const unhandled = new Map();
    for (const c of srcCounts) for (const [n, k] of c) if (!known.has(n)) unhandled.set(n, (unhandled.get(n) || 0) + k);
    const counts = Object.fromEntries(Object.entries(COUNTED).map(([k, names]) => [k, { source: sum(srcCounts, names), book: sum(bookCounts, names) }]));
    const images = [];
    for (const sub of ['csdb', 'Media']) {
      let list = [];
      try { list = fs.readdirSync(path.join(work, sub)); } catch { continue; }
      for (const f of list) if (/\.(png|jpe?g|gif)$/i.test(f) && fs.lstatSync(path.join(work, sub, f)).isFile()) images.push({ rel: `${sub}/${f}`, buffer: fs.readFileSync(path.join(work, sub, f)) });
    }
    const report = {
      from: 's1000d', to: 'jss', via: 'vendor/pipeline/s1000dtojss (the first stage of the Customize build)',
      modules: modules.length,
      frontMatterPagesInlined: inlined,
      counts,
      changed: Object.entries(counts).filter(([, c]) => c.source !== c.book).map(([k, c]) => `${k}: ${c.source} in the modules, ${c.book} in the book`),
      unmapped: built.unmapped || [],
      unhandled: [...unhandled.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      notes: built.notes || [],
      images: images.length,
      lossy: (built.unmapped || []).length > 0 || unhandled.size > 0 || Object.values(counts).some((c) => c.book < c.source),
    };
    return { book, images, report };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { s1000dToJss, ConvertError, handledNames, countElements };
