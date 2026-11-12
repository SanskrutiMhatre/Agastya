'use strict';
// Formats over real HTTP (Phase 7, decisions.md FM1-FM6): the adapters, an
// S1000D project converted to a JSS project through the reference's own
// s1000dtojss stage with its report and the source untouched, a JSS book
// edited, saved, reopened and built to PDF, and the conversions that are refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const formats = require('../server/formats');
const { startServer, adminClient, makeUser } = require('./helpers');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');
const ICN = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';
let t, pm, author, src, srcDir;

function tree(dir) {
  const out = {};
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(dir);
  return out;
}
async function pdfText(buf) {
  const { extractPdfText } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'pdf-text.mjs')).href);
  const f = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'agastya-pdf-')), 'p.pdf');
  fs.writeFileSync(f, buf);
  return (await extractPdfText(f)).pages.join('\n');
}

test('the adapters: detection, the JSS checks from the stylesheets, and which conversions exist', () => {
  assert.deepEqual(formats.detect('<?xml version="1.0"?><dmodule/>'), { format: 's1000d', kind: 'dm', root: 'dmodule' });
  assert.equal(formats.detect('<!-- c --><pm/>').kind, 'pm');
  assert.equal(formats.detect('<jssbook/>').format, 'jss');
  assert.equal(formats.detect('<notes/>').format, null);
  assert.equal(formats.conversionProblem('s1000d', 'jss'), null);
  assert.match(formats.conversionProblem('jss', 's1000d'), /no JSS to S1000D mapping/);
  assert.match(formats.conversionProblem('s1000d', 'jsg'), /JSG is not defined/);
  assert.deepEqual(formats.checkJss(formats.jssSkeleton({ bookName: 'B' })), []);
  const f = formats.checkJss('<jssbook><body><widget/></body></jssbook>');
  assert.ok(f.some((x) => x.sev === 'error' && /bookmeta/.test(x.message)));
  assert.ok(f.some((x) => x.sev === 'warning' && /<widget>/.test(x.message)));
  assert.equal(formats.checkJss('<pm/>')[0].sev, 'error');
  // The vocabulary is read from vendor/pipeline, not kept by hand.
  for (const n of ['jssbook', 'bookmeta', 'chapter', 'section', 'para', 'figure', 'table', 'warning']) assert.ok(formats.jssVocabulary().has(n), n);
  assert.ok(!formats.jssVocabulary().has('levelledPara'));
});

test.before(async () => {
  t = await startServer();
  const admin = await adminClient(t);
  pm = await makeUser(t, admin, { username: 'priya.rao', role: 'project_manager' });
  author = await makeUser(t, pm, { username: 'arjun.das', role: 'author' });
  src = (await author.post('/api/projects', { name: 'PDU source' })).body.project;
  srcDir = path.join(t.dataDir, 'projects', src.id);
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) {
    await author.post(`/api/projects/${src.id}/dms/import`, { filename: f, content: fs.readFileSync(path.join(GOLDEN, 'csdb', f), 'utf8') });
  }
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(path.join(GOLDEN, 'csdb', `${ICN}.png`))]), `${ICN}.png`);
  await fetch(`${t.base}/api/projects/${src.id}/graphics`, { method: 'POST', body: form, headers: { cookie: author.cookie } });
  for (const f of ['emblem.png', 'publisher-logo.png']) fs.copyFileSync(path.join(GOLDEN, 'Media', f), path.join(srcDir, 'Media', f));
  const g = await author.get(`/api/projects/${src.id}/publication`);
  await author.raw('PUT', `/api/projects/${src.id}/publication`, { xml: fs.readFileSync(path.join(GOLDEN, 'publication.xml'), 'utf8'), baseRevision: g.body.revision });
});
test.after(() => t.stop());

let jss;
test('S1000D to JSS: a new JSS project from the s1000dtojss stage, with a report, and the source untouched', { timeout: 240000 }, async () => {
  const before = tree(srcDir);
  const r = await author.post(`/api/projects/${src.id}/convert`, { to: 'jss', name: 'PDU book' });
  assert.equal(r.status, 201, r.text);
  jss = r.body.project;
  assert.equal(jss.format, 'jss');
  assert.deepEqual(tree(srcDir), before, 'not one file of the source changed');
  const rep = r.body.report;
  assert.equal(rep.modules, 9);
  assert.ok(rep.frontMatterPagesInlined > 0);
  assert.equal(rep.counts.figures.book, rep.counts.figures.source);
  assert.ok(Array.isArray(rep.unmapped) && Array.isArray(rep.unhandled));
  assert.equal(typeof rep.lossy, 'boolean');
  const dir = path.join(t.dataDir, 'projects', jss.id);
  const book = fs.readFileSync(path.join(dir, 'publication.xml'), 'utf8');
  assert.match(book, /^<\?xml[^>]*\?>\s*<jssbook>/);
  assert.ok(!/XInclude|xi:include/.test(book), 'front matter inlined');
  // The source project's identity (its own project.json) is in the book's bookmeta.
  assert.match(book, /<bookName>Technical Manual<\/bookName>\s*<systemName>PDU source<\/systemName>/, 'identity carried in bookmeta');
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) assert.ok(fs.existsSync(path.join(dir, 'source', 'csdb', f)), `source kept: ${f}`);
  assert.ok(fs.existsSync(path.join(dir, `csdb/${ICN}.png`)));
  assert.equal((await author.get(`/api/projects/${jss.id}/conversion-report`)).body.report.sourceProject.id, src.id);
  assert.equal((await author.get(`/api/projects/${jss.id}/dms`)).body.modules.length, 0, 'a JSS project holds no data modules');
});

test('a JSS book: edit, save, reopen byte for byte; refused when it stops being a book; built to PDF', { timeout: 240000 }, async () => {
  const g = (await author.get(`/api/projects/${jss.id}/publication`)).body;
  const edited = g.xml.replace(/<\/bookName>/, ' (converted)</bookName>').replace('</jssbook>', '<!-- kept -->\n</jssbook>');
  const s = await author.raw('PUT', `/api/projects/${jss.id}/publication`, { xml: edited, baseRevision: g.revision });
  assert.equal(s.status, 200, s.text);
  const again = (await author.get(`/api/projects/${jss.id}/publication`)).body;
  assert.equal(again.xml, edited);
  assert.equal((await author.raw('PUT', `/api/projects/${jss.id}/publication`, { xml: '<pm/>', baseRevision: again.revision })).body.code, 'NOT_A_JSS_BOOK');
  const w = await author.raw('PUT', `/api/projects/${jss.id}/publication`, { xml: edited.replace('</body>', '<chapter number="99"><title>Extra</title><gadget>odd</gadget></chapter></body>'), baseRevision: again.revision });
  assert.equal(w.status, 200);
  assert.ok(w.body.warnings.some((x) => /<gadget>/.test(x)));
  const b = await author.post(`/api/projects/${jss.id}/build`, {});
  assert.equal(b.status, 200, b.text);
  const pdf = Buffer.from(await (await fetch(`${t.base}/api/projects/${jss.id}/output.pdf`, { headers: { cookie: author.cookie } })).arrayBuffer());
  const text = (await pdfText(pdf)).replace(/\s+/g, ' ');
  assert.match(text, /\(converted\)/i);
  assert.match(text, /Extra/);
});

test('a JSS document type (decisions.md ST8): the cover title, running head and footer document number follow the chosen JSS0251 stencil', { timeout: 240000 }, async () => {
  const dir = path.join(t.dataDir, 'projects', jss.id);
  const r = await author.raw('PUT', `/api/projects/${jss.id}/settings/identity`, { value: { documentType: 'MM', systemName: '160kVA Generator', ltDocumentNo: 'DT0042_U01_160KVA_R0' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.settings.identity.documentType, 'MM');
  const book = fs.readFileSync(path.join(dir, 'publication.xml'), 'utf8');
  assert.match(book, /<documentTypeHeader>Maintenance<\/documentTypeHeader>/);
  assert.match(book, /<ltDocumentNo>DT0042_U01_160KVA_R0<\/ltDocumentNo>/);
  // A converted book's title pages are inlined, not read from project.json on every build (FM4) - the cover title is written into them directly, like bookmeta.
  assert.match(book, /<titlePage>\s*<documentType>\s*<line>TECHNICAL MANUAL<\/line>\s*<line>PART II MAINTENANCE<\/line>/);
  assert.match(book, /<titlePageJoint>\s*<documentType>\s*<line>TECHNICAL MANUAL<\/line>\s*<line>PART II MAINTENANCE<\/line>/);

  // An unrecognised key is refused; clearing it back out is allowed (falls back to the book's own name in the running head).
  assert.equal((await author.raw('PUT', `/api/projects/${jss.id}/settings/identity`, { value: { documentType: 'NOT_A_TYPE' } })).status, 400);

  const b = await author.post(`/api/projects/${jss.id}/build`, {});
  assert.equal(b.status, 200, b.text);
  const pdf = Buffer.from(await (await fetch(`${t.base}/api/projects/${jss.id}/output.pdf`, { headers: { cookie: author.cookie } })).arrayBuffer());
  const text = (await pdfText(pdf)).replace(/\s+/g, ' ');
  assert.match(text, /TECHNICAL MANUAL/);
  assert.match(text, /PART II MAINTENANCE/);
  assert.match(text, /Maintenance/);
  assert.match(text, /160kVA Generator/);
  assert.match(text, /DT0042_U01_160KVA_R0/);
});

test('refused conversions: JSS to S1000D, to JSG, by a Project Manager, and of an empty project', async () => {
  assert.equal((await author.post(`/api/projects/${jss.id}/convert`, { to: 's1000d', name: 'Back again' })).body.code, 'CONVERSION_UNSUPPORTED');
  assert.equal((await author.post(`/api/projects/${src.id}/convert`, { to: 'jsg', name: 'JSG try' })).body.code, 'CONVERSION_UNSUPPORTED');
  const managed = (await pm.post('/api/projects', { name: 'Managed', members: [author.user.id] })).body.project;
  assert.equal((await pm.post(`/api/projects/${managed.id}/convert`, { to: 'jss', name: 'PM conversion' })).status, 403);
  assert.equal((await author.post(`/api/projects/${managed.id}/convert`, { to: 'jss', name: 'Empty one' })).body.code, 'NOTHING_TO_CONVERT');
});
