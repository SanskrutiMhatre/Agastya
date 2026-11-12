'use strict';
/*
  The toolchain checks (decisions.md P5, V11): is everything the PDF build
  and validation need present inside the project folder, and does each tool
  actually run? Used by `npm run doctor` and by the administrator's System
  health screen. Each tool is run with execFile and argument arrays, never a
  shell. For Java and xsltproc the real file run is reported too: on a
  machine where tools/ holds links to system tools (decisions.md V12), the
  health screen shows the actual path and version, not the bundled name.
*/

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const paths = require('../../vendor/engine/paths');

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 60000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({ err, out: `${stdout || ''}${stderr || ''}` });
    });
  });
}

function realPath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// Windows paths compare without case (NTFS), so a drive letter typed as c: is still C:.
const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

async function runChecks() {
  const results = [];
  const tools = [];
  const rel = (p) => path.relative(ROOT, p) || '.';
  const ok = (name, detail) => results.push({ ok: true, name, detail });
  const note = (name, detail) => results.push({ ok: true, note: true, name, detail });
  const bad = (name, detail) => results.push({ ok: false, name, detail });
  const tool = (name, file, version, okFlag) => {
    const real = realPath(file);
    tools.push({ name, path: rel(file), realPath: real, linked: !!real && fold(real) !== fold(file), insideProject: !!real && fold(real).startsWith(fold(ROOT) + path.sep), version: version || null, ok: okFlag });
  };
  function needFiles(name, base, files) {
    const missing = files.filter((f) => !fs.existsSync(path.join(base, f)));
    if (missing.length) bad(name, `missing in ${rel(base)}: ${missing.join(', ')}`);
    else ok(name, `${files.length} files in ${rel(base)}`);
  }

  // Java
  if (!fs.existsSync(paths.JAVA)) {
    bad('Java runtime', `not found at ${rel(paths.JAVA)}`);
  } else {
    const r = await run(paths.JAVA, ['-version']);
    const m = /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(r.out);
    const major = m ? Number(m[1] === '1' ? m[2] : m[1]) : 0;
    const line = (r.out.split('\n')[0] || (r.err && r.err.message) || '').trim();
    if (r.err || major < 11) bad('Java runtime', `cannot run or too old (${line})`);
    else ok('Java runtime', `${line} (${rel(paths.JAVA)})`);
    tool('Java runtime', paths.JAVA, line, !r.err && major >= 11);
  }

  // xsltproc
  if (!fs.existsSync(paths.XSLTPROC)) {
    bad('xsltproc', `not found at ${rel(paths.XSLTPROC)}`);
  } else {
    const r = await run(paths.XSLTPROC, ['--version']);
    const line = r.out.split('\n')[0].trim();
    if (r.err) bad('xsltproc', `cannot run: ${r.err.message}`);
    else ok('xsltproc', `${line} (${rel(paths.XSLTPROC)})`);
    tool('xsltproc', paths.XSLTPROC, r.err ? null : line, !r.err);
  }

  // Apache FOP: the jars, then the CLI itself on the bundled JRE.
  needFiles('Apache FOP jars', path.join(paths.FOP_HOME, 'build'), ['fop-2.10.jar', 'fop-core-2.10.jar', 'fop-events-2.10.jar', 'fop-util-2.10.jar']);
  if (fs.existsSync(paths.JAVA) && fs.existsSync(path.join(paths.FOP_HOME, 'build', 'fop-core-2.10.jar'))) {
    const r = await run(paths.JAVA, [...paths.FOP_ARGS, '-version']);
    const line = (r.out.match(/FOP Version[^\n]*/) || [''])[0].trim();
    if (r.err && !line) bad('Apache FOP', `cannot run: ${r.out.split('\n')[0] || r.err.message}`);
    else ok('Apache FOP', line || 'runs');
    tool('Apache FOP', path.join(paths.FOP_HOME, 'build', 'fop-core-2.10.jar'), line || null, !(r.err && !line));
  }
  needFiles('FOP configuration and fonts', paths.TOOLS, ['fop.xconf', 'fonts/DejaVuSans.ttf', 'fonts/DejaVuSans-Bold.ttf', 'fonts/DejaVuSans-Oblique.ttf', 'fonts/DejaVuSans-BoldOblique.ttf']);
  needFiles('Warm FOP server', path.join(ROOT, 'vendor', 'engine', 'fopserver'), ['FopServer.class', 'warmup.fo']);

  // Schemas: every issue set, its key schemas and the ISO entity sets.
  for (const issue of ['3.0', '4.1', '4.2', '5.0', '6.0']) {
    const files = ['descript.xsd', 'proced.xsd', 'pm.xsd', 'brex.xsd', 'xlink.xsd', 'xml.xsd'];
    needFiles(`S1000D ${issue} schemas`, path.join(paths.SCHEMAS, issue), files);
    /*
      ISO character entity sets: JSS ships them for 3.0, 4.2 and 5.0 only; the
      official pack it came from has none for 4.1 and 6.0 (vendor/schemas/
      PROVENANCE.md). Required where expected, reported otherwise.
    */
    if (['3.0', '4.2', '5.0'].includes(issue)) needFiles(`S1000D ${issue} entity sets`, path.join(paths.SCHEMAS, issue, 'ent'), ['ISOEntities', 'iso-num.ent', 'iso-tech.ent']);
    else note(`S1000D ${issue} entity sets`, 'none shipped for this issue (as in JSS); entities such as &deg; will not resolve for it');
  }

  // Pipelines and stencils.
  needFiles('Pipeline s1000dtojss', path.join(paths.PIPELINE, 's1000dtojss'), ['s1000dtojss.xsl', 'content.xsl', 'identity.xsl', 'schemas.xsl']);
  needFiles('Pipeline jsstofo', path.join(paths.PIPELINE, 'jsstofo'), ['jsstofo.xsl', 'body.xsl', 'common.xsl', 'figures.xsl', 'frontmatter.xsl', 'headers_footers.xsl', 'pagesetup.xsl', 'tables.xsl', 'toc.xsl', 'warnings.xsl', 'intentionally-blank.svg']);
  needFiles('Pipeline s1000dtofo', path.join(paths.PIPELINE, 's1000dtofo'), ['s1000dtofo.xsl', 'descript.xsl', 'proced.xsl', 'tables.xsl', 'figures.xsl', 'warnings.xsl', 'refs.xsl', 'toc.xsl']);
  const fmDir = path.join(paths.PIPELINE, 'jss', 'frontmatter');
  const stencils = fs.existsSync(fmDir) ? fs.readdirSync(fmDir).filter((f) => f.endsWith('.xml')) : [];
  if (stencils.length >= 13) ok('Front-matter stencils', `${stencils.length} pages in ${rel(fmDir)}`);
  else bad('Front-matter stencils', `expected 13 in ${rel(fmDir)}, found ${stencils.length}`);
  needFiles('House template', path.join(ROOT, 'vendor', 'templates'), ['default.house.json', 'agastya.house.json']);
  // From the Agastya original (vendor/PROVENANCE.md): shells, the default BREX and reference data.
  needFiles('Data module shells', path.join(ROOT, 'vendor', 'templates', 'shells'), ['descript41.xml', 'descript42.xml', 'proced41.xml', 'proced42.xml', 'ipd41.xml', 'ipd42.xml']);
  needFiles('Default S1000D BREX', path.join(ROOT, 'vendor', 'brex'), ['S1000D-default-4.2.xml']);
  needFiles('Reference data', path.join(ROOT, 'vendor', 'reference-data'), ['country-codes.json', 'language-codes.json', 'security-classes.json', 'info-codes.json', 'sns.json', 'originator-cages.json', 'rpc-cages.json']);
  // The structured editor's content models, compiled from vendor/schemas (checkpoint 2c).
  const cmFile = path.join(ROOT, 'client', 'src', 'data', 'content-models.json');
  try {
    const cm = JSON.parse(fs.readFileSync(cmFile, 'utf8'));
    const keys = Object.keys(cm.models || {});
    if (['4.1/descript', '4.2/descript', '4.2/proced', '4.2/ipd'].every((k) => keys.includes(k))) ok('Content models', `${keys.length} models in ${rel(cmFile)} (rebuild: npm run content-models)`);
    else bad('Content models', `${rel(cmFile)} lacks the 4.x authoring models; run npm run content-models`);
  } catch { bad('Content models', `${rel(cmFile)} is missing; run npm run content-models`); }

  // Self-containment: no application file may point outside the project.
  const offenders = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') scan(p); continue; }
      if (!/\.(js|mjs|jsx|json|xsl|xconf)$/.test(e.name) || p === __filename || p === path.join(ROOT, 'scripts', 'doctor.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/jss source code|PDF_PublishingTool|server[\\/]tools[\\/]|JSSPUB_|JSS_JAVA/.test(src)) offenders.push(rel(p));
    }
  };
  for (const d of ['server', 'scripts', path.join('vendor', 'engine'), path.join('vendor', 'pipeline')]) scan(path.join(ROOT, d));
  scan(paths.TOOLS);
  if (offenders.length) bad('Self-contained', `references outside the project in: ${offenders.join(', ')}`);
  else ok('Self-contained', 'no application file refers to the JSS folder or tools outside the project');


  // A tool that is a link to something outside the project is reported (V12): the bundled tool was not what ran.
  for (const t of tools) {
    if (t.linked && !t.insideProject) note(`${t.name} location`, `${t.path} is a link to ${t.realPath}, outside the project; the bundled tool is not the one in use`);
  }
  return { results, tools, root: ROOT, ok: results.every((r) => r.ok) };
}

module.exports = { runChecks, ROOT };
