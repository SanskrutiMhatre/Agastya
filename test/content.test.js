'use strict';
// Checkpoint 2a content flow over real HTTP: workspace, data modules, the
// write path (guard, conflicts, revisions), import, graphics, validation,
// BREX, DMRL, PDF build and preview, and scope isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { startServer, adminClient, makeUser } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const GOLDEN = path.join(ROOT, 'samples', 'golden');
const BROKEN = path.join(ROOT, 'samples', 'broken');
const read = (p) => fs.readFileSync(p, 'utf8');
// The Agastya descript shell has an empty <description>; tests write a paragraph into it.
const EMPTY = '<description></description>';
const DESC = (text) => `<description><levelledPara><title>Tray</title><para>${text}</para></levelledPara></description>`;

const DMC = {
  modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '31', subSystemCode: '0', subSubSystemCode: '0',
  assyCode: '00', disassyCode: '00', disassyCodeVariant: 'A', infoCode: '040', infoCodeVariant: 'A', itemLocationCode: 'D',
};

let t, admin, pm, writer, outsider, project, wsDir;

// Multipart helper over fetch.
async function upload(c, url, fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields || {})) form.append(k, v);
  if (file) form.append('file', new Blob([file.data]), file.name);
  const res = await fetch(t.base + url, { method: 'POST', body: form, headers: { cookie: c.cookie } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* binary */ }
  return { status: res.status, body: json };
}
async function raw(c, method, url) {
  const res = await fetch(t.base + url, { method, headers: { cookie: c.cookie } });
  return { status: res.status, type: res.headers.get('content-type'), buf: Buffer.from(await res.arrayBuffer()) };
}

test.before(async () => {
  t = await startServer();
  admin = await adminClient(t);
  pm = await makeUser(t, admin, { username: 'pub.lead', role: 'project_manager' });
  writer = await makeUser(t, pm, { username: 'tech.writer', role: 'author' });
  outsider = await makeUser(t, pm, { username: 'other.writer', role: 'author' });
  project = (await writer.post('/api/projects', { name: 'PDU-200 Manual' })).body.project;
  wsDir = path.join(t.dataDir, 'projects', project.id);
});
test.after(() => t.stop());

test('creating a project scaffolds its S1000D workspace on disk', () => {
  for (const p of ['csdb', 'Media', 'jss/frontmatter', '.deleted', 'project.json', 'publication.xml']) {
    assert.ok(fs.existsSync(path.join(wsDir, p)), p);
  }
  assert.equal(JSON.parse(read(path.join(wsDir, 'project.json'))).templateRef, 'agastya');
});

let dm;
test('a data module is created from the 4.2 shell, named by its code, and is schema-valid', async () => {
  const r = await writer.post(`/api/projects/${project.id}/dms`, { dmc: DMC, techName: 'Cooling fan tray', infoName: 'Description', schemaType: 'descript' });
  assert.equal(r.status, 201, r.text);
  dm = r.body.module;
  assert.equal(dm.dmc, 'AGS-A-31-00-00-00A-040A-D');
  assert.equal(dm.file, 'DMC-AGS-A-31-00-00-00A-040A-D.xml');
  const xml = read(path.join(wsDir, 'csdb', dm.file));
  assert.match(xml, /<techName>Cooling fan tray<\/techName>/);
  const v = await writer.post(`/api/projects/${project.id}/dms/${dm.id}/validate`, {});
  assert.equal(v.body.valid, true, JSON.stringify(v.body.findings));
  assert.match(v.body.schema, /descript\.xsd \(Issue 4\.2\)/);
  assert.equal((await writer.post(`/api/projects/${project.id}/dms`, { dmc: DMC, techName: 'Again', schemaType: 'descript' })).body.code, 'DMC_TAKEN');
  // No project BREX: the bundled S1000D default 4.2 BREX is used, and the result says so.
  assert.equal(v.body.brex.projectOwn, false);
  assert.match(v.body.brex.source, /S1000D default BREX/);
  assert.ok(v.body.brex.evaluated > 200);
  assert.ok(v.body.findings.some((f) => f.kind === 'brex' && f.sev === 'info' && /default business rules/.test(f.message)));
});

test('creation fields follow the original: shell choice, language, security, issue, enterprise and learn codes', async () => {
  const p3 = (await writer.post('/api/projects', { name: 'Creation fields' })).body.project;
  const p3Dir = path.join(t.dataDir, 'projects', p3.id);
  const shells = (await writer.get(`/api/projects/${p3.id}/dms`)).body.shells.map((s) => s.id);
  assert.deepEqual(shells.sort(), ['descript41', 'descript42', 'ipd41', 'ipd42', 'proced41', 'proced42']);
  const code = { ...DMC, systemCode: '33', learnCode: 'T10', learnEventCode: 'A' };
  const r = await writer.post(`/api/projects/${p3.id}/dms`, {
    dmc: code, techName: 'Fan', schemaType: 'descript', templateId: 'descript41', languageIsoCode: 'fr', countryIsoCode: 'FR',
    securityClassification: 'RESTRICTED', issueNumber: '001', inWork: '01', originator: '1671y', rpcCode: 'C6000',
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.module.file, 'DMC-AGS-A-33-00-00-00A-040A-D-T10-A.xml');
  const xml = read(path.join(p3Dir, 'csdb', r.body.module.file));
  assert.match(xml, /S1000D_4-1/);
  assert.match(xml, /learnCode="T10" learnEventCode="A"/);
  assert.match(xml, /<language countryIsoCode="FR" languageIsoCode="fr"/);
  assert.match(xml, /securityClassification="02"/);
  assert.match(xml, /<issueInfo inWork="01" issueNumber="001"/);
  assert.match(xml, /<originator enterpriseCode="1671Y"/);
  assert.match(xml, /<dmStatus issueType="new"/, 'a new module is a new issue, whatever the shell says');
  const v = await writer.post(`/api/projects/${p3.id}/dms/${r.body.module.id}/validate`, {});
  assert.match(v.body.schema, /Issue 4\.1/);
  assert.equal(v.body.valid, true, JSON.stringify(v.body.findings));
  const bad = [
    { templateId: 'proced42' }, { issueNumber: '1' }, { securityClassification: 'SECRETISH' },
    { dmc: { ...DMC, systemCode: '34', learnCode: 'X01', learnEventCode: 'A' } }, { dmc: { ...DMC, systemCode: '34', learnCode: 'T01' } },
  ];
  for (const b of bad) {
    const res = await writer.post(`/api/projects/${p3.id}/dms`, { dmc: { ...DMC, systemCode: '34' }, techName: 'X', schemaType: 'descript', ...b });
    assert.equal(res.status, 400, JSON.stringify(b));
  }
});

test('XSD issue resolution: an undeclared issue is checked against 4.2, an uninstalled one against the nearest older, with notes', async () => {
  const g = await writer.get(`/api/projects/${project.id}/dms/${dm.id}`);
  const undeclared = g.body.xml.replace(/\s+xsi:noNamespaceSchemaLocation="[^"]*"/, '');
  let v = (await writer.post(`/api/projects/${project.id}/dms/${dm.id}/validate`, { xml: undeclared })).body;
  assert.match(v.schema, /descript\.xsd \(Issue 4\.2\)/, 'the recorded schema type names the file');
  assert.match(v.issue.note, /does not declare/);
  v = (await writer.post(`/api/projects/${project.id}/dms/${dm.id}/validate`, { xml: g.body.xml.replace('S1000D_4-2', 'S1000D_4-3') })).body;
  assert.equal(v.issue.used, '4.2');
  assert.match(v.issue.note, /Issue 4\.3, which is not installed/);
  v = (await writer.post(`/api/projects/${project.id}/dms/${dm.id}/validate`, { issue: '5.0' })).body;
  assert.equal(v.issue.used, '5.0');
  assert.equal((await writer.post(`/api/projects/${project.id}/dms/${dm.id}/validate`, { issue: '../x' })).status, 400);
});

test('hostile or malformed data module codes are refused before any file is named', async () => {
  for (const bad of [{ ...DMC, modelIdentCode: '../X' }, { ...DMC, infoCode: '04' }, { ...DMC, systemCode: 'A/B' }, { ...DMC, itemLocationCode: 'Q' }]) {
    const r = await writer.post(`/api/projects/${project.id}/dms`, { dmc: bad, techName: 'X', schemaType: 'descript' });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await writer.post(`/api/projects/${project.id}/dms`, { dmc: { ...DMC, extra: '1' }, techName: 'X', schemaType: 'descript' })).body.code, 'UNKNOWN_FIELD');
  assert.ok(!fs.readdirSync(path.join(wsDir, 'csdb')).some((f) => /\.\./.test(f)));
});

test('save: revision-based conflict detection; stale saves are refused with 409 and change nothing', async () => {
  const g = await writer.get(`/api/projects/${project.id}/dms/${dm.id}`);
  const base = g.body.revision;
  const edited = g.body.xml.replace(EMPTY, DESC('The tray holds four fans.'));
  const s1 = await writer.raw('PUT', `/api/projects/${project.id}/dms/${dm.id}`, { xml: edited, baseRevision: base });
  assert.equal(s1.status, 200, s1.text);
  assert.ok(s1.body.revision > base);
  const stale = await writer.raw('PUT', `/api/projects/${project.id}/dms/${dm.id}`, { xml: g.body.xml.replace(EMPTY, DESC('Overwrite')), baseRevision: base });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CONFLICT');
  assert.equal(stale.body.conflict.current, s1.body.revision);
  assert.match(read(path.join(wsDir, 'csdb', dm.file)), /The tray holds four fans\./, 'the stale save changed nothing');
});

test('a change made on disk outside Agastya is detected and recorded', async () => {
  const g = await writer.get(`/api/projects/${project.id}/dms/${dm.id}`);
  const file = path.join(wsDir, 'csdb', dm.file);
  fs.writeFileSync(file, read(file).replace('four fans', 'six fans'));
  const r = await writer.raw('PUT', `/api/projects/${project.id}/dms/${dm.id}`, { xml: g.body.xml, baseRevision: g.body.revision });
  assert.equal(r.status, 409);
  const revs = (await writer.get(`/api/projects/${project.id}/dms/${dm.id}/revisions`)).body.revisions;
  assert.equal(revs[0].reason, 'Changed outside Agastya');
});

test('the XML safety guard refuses XXE, doubled documents, malformed XML and non-modules on save and import', async () => {
  const g = await writer.get(`/api/projects/${project.id}/dms/${dm.id}`);
  const save = (xml) => writer.raw('PUT', `/api/projects/${project.id}/dms/${dm.id}`, { xml, baseRevision: g.body.revision });
  const xxe = g.body.xml.replace('<dmodule', '<!DOCTYPE dmodule [<!ENTITY x SYSTEM "file:///C:/Windows/win.ini">]>\n<dmodule').replace('six fans', '&x;');
  assert.equal((await save(xxe)).body.code, 'XML_REFUSED');
  const pe = g.body.xml.replace('<dmodule', '<!DOCTYPE dmodule [<!ENTITY % p SYSTEM "../../secret.dtd"> %p;]>\n<dmodule');
  assert.equal((await save(pe)).body.code, 'XML_REFUSED');
  const bomb = g.body.xml.replace('<dmodule', '<!DOCTYPE dmodule [<!ENTITY % a "lol"> ]>\n<dmodule');
  assert.equal((await save(bomb)).body.code, 'XML_REFUSED');
  assert.equal((await save(g.body.xml + g.body.xml)).body.code, 'DOCUMENT_DOUBLED');
  const broken = await save(g.body.xml.replace('</levelledPara>', ''));
  assert.equal(broken.body.code, 'NOT_WELL_FORMED');
  assert.ok(broken.body.line > 1);
  assert.equal((await save('<pm/>')).body.code, 'NOT_A_DATA_MODULE');
  const imp = await writer.post(`/api/projects/${project.id}/dms/import`, { filename: '../../evil.xml', content: xxe });
  assert.equal(imp.body.code, 'XML_REFUSED');
  assert.ok(!fs.existsSync(path.join(t.dataDir, 'projects', 'evil.xml')));
});

test('changing the code in the XML renames the file; history follows the document', async () => {
  const g = await writer.get(`/api/projects/${project.id}/dms/${dm.id}`);
  const xml = g.body.xml.replace('systemCode="31"', 'systemCode="32"');
  const r = await writer.raw('PUT', `/api/projects/${project.id}/dms/${dm.id}`, { xml, baseRevision: g.body.revision });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.module.dmc, 'AGS-A-32-00-00-00A-040A-D');
  assert.ok(fs.existsSync(path.join(wsDir, 'csdb', 'DMC-AGS-A-32-00-00-00A-040A-D.xml')));
  assert.ok(!fs.existsSync(path.join(wsDir, 'csdb', dm.file)));
  const revs = (await writer.get(`/api/projects/${project.id}/dms/${dm.id}/revisions`)).body.revisions;
  assert.ok(revs.length >= 4);
  const first = await writer.get(`/api/projects/${project.id}/dms/${dm.id}/revisions/${revs.at(-1).id}`);
  assert.ok(first.body.xml.includes(EMPTY), 'the first revision is unchanged');
  dm = r.body.module;
});

test('revisions are immutable in the database', () => {
  assert.throws(() => t.store.db.prepare("UPDATE revisions SET reason = 'x'").run(), /immutable/);
  assert.throws(() => t.store.db.prepare('DELETE FROM revisions').run(), /immutable/);
  assert.throws(() => t.store.db.prepare('DELETE FROM blobs').run(), /immutable/);
});

test('soft delete moves the module out of the build; restore brings it back', async () => {
  assert.equal((await writer.del(`/api/projects/${project.id}/dms/${dm.id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(wsDir, 'csdb', dm.file)));
  assert.equal((await writer.get(`/api/projects/${project.id}/dms`)).body.modules.length, 0);
  assert.equal((await writer.get(`/api/projects/${project.id}/dms?deleted=1`)).body.modules.length, 1);
  assert.equal((await writer.get(`/api/projects/${project.id}/dms/${dm.id}`)).body.readOnly, true);
  assert.equal((await writer.post(`/api/projects/${project.id}/dms/${dm.id}/restore`)).status, 200);
  assert.ok(fs.existsSync(path.join(wsDir, 'csdb', dm.file)));
});

test('import, graphics, publication module and the PDF build with the golden sample', async () => {
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) {
    const r = await writer.post(`/api/projects/${project.id}/dms/import`, { filename: f, content: read(path.join(GOLDEN, 'csdb', f)) });
    assert.equal(r.status, 201, `${f}: ${r.text}`);
  }
  assert.equal((await writer.post(`/api/projects/${project.id}/dms/import`, { content: read(path.join(GOLDEN, 'publication.xml')) })).body.code, 'NOT_A_DATA_MODULE');

  // The figure's graphic is missing until uploaded; upload goes where the build looks.
  let gl = (await writer.get(`/api/projects/${project.id}/graphics`)).body;
  const icn = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';
  assert.equal(gl.graphics.find((g) => g.icn === icn).present, false);
  const png = fs.readFileSync(path.join(GOLDEN, 'csdb', `${icn}.png`));
  const up = await upload(writer, `/api/projects/${project.id}/graphics`, { icn }, { data: png, name: 'diagram.png' });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.file, `csdb/${icn}.png`);
  assert.equal(up.body.resolves, true);
  gl = (await writer.get(`/api/projects/${project.id}/graphics`)).body;
  assert.equal(gl.counts.missing, 0);
  const served = await raw(writer, 'GET', `/api/projects/${project.id}/graphics/${icn}/file`);
  assert.equal(served.type, 'image/png');
  for (const m of ['emblem.png', 'publisher-logo.png']) fs.copyFileSync(path.join(GOLDEN, 'Media', m), path.join(wsDir, 'Media', m));

  const pmGet = await writer.get(`/api/projects/${project.id}/publication`);
  const pmPut = await writer.raw('PUT', `/api/projects/${project.id}/publication`, { xml: read(path.join(GOLDEN, 'publication.xml')), baseRevision: pmGet.body.revision });
  assert.equal(pmPut.status, 200, pmPut.text);

  const report = (await writer.post(`/api/projects/${project.id}/validate`)).body;
  const errors = report.findings.filter((f) => f.sev === 'error');
  assert.deepEqual(errors, [], 'the imported golden sample validates cleanly');

  const build = await writer.post(`/api/projects/${project.id}/build`);
  assert.equal(build.status, 200, build.text);
  assert.ok(!JSON.stringify(build.body).includes(t.dataDir), 'no absolute paths in build messages');
  const out = await raw(writer, 'GET', `/api/projects/${project.id}/output.pdf`);
  assert.equal(out.status, 200);
  assert.equal(out.buf.slice(0, 5).toString(), '%PDF-');

  const someDm = (await writer.get(`/api/projects/${project.id}/dms`)).body.modules.find((m) => m.dmc === 'AGS-A-24-10-00-00A-520A-D');
  const prev = await raw(writer, 'POST', `/api/projects/${project.id}/dms/${someDm.id}/preview`);
  assert.equal(prev.status, 200);
  assert.equal(prev.type, 'application/pdf');
  assert.equal(prev.buf.slice(0, 5).toString(), '%PDF-');
});

test('graphics: only real PNG/JPEG/GIF content is accepted, and ICNs are checked', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await upload(writer, `/api/projects/${project.id}/graphics`, { icn: 'ICN-AGS-TEST-00001' }, { data: svg, name: 'x.png' })).status, 415);
  const png = fs.readFileSync(path.join(GOLDEN, 'Media', 'emblem.png'));
  assert.equal((await upload(writer, `/api/projects/${project.id}/graphics`, { icn: '../../ICN-X' }, { data: png, name: 'x.png' })).body.code, 'BAD_ICN');
  assert.equal((await upload(writer, `/api/projects/${project.id}/graphics`, { icn: 'ICN-AGS-TEST-00001', evil: '1' }, { data: png, name: 'x.png' })).body.code, 'UNKNOWN_FIELD');
  const ok = await upload(writer, `/api/projects/${project.id}/graphics`, {}, { data: png, name: 'ICN-AGS-TEST-00002.png' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.file, 'Media/ICN-AGS-TEST-00002.png', 'undeclared ICNs go where the engine looks: Media/<ICN>.png');
  // Case is kept; an upload takes the spelling the modules use (as in the original).
  const icn = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';
  const lower = await upload(writer, `/api/projects/${project.id}/graphics`, { icn: icn.toLowerCase() }, { data: fs.readFileSync(path.join(GOLDEN, 'csdb', `${icn}.png`)), name: 'x.png' });
  assert.equal(lower.status, 201, JSON.stringify(lower.body));
  assert.equal(lower.body.icn, icn);
  assert.equal(lower.body.file, `csdb/${icn}.png`);
  const mixed = await upload(writer, `/api/projects/${project.id}/graphics`, { icn: 'ICN-Ags-Mixed-00001' }, { data: png, name: 'x.png' });
  assert.equal(mixed.body.file, 'Media/ICN-Ags-Mixed-00001.png');
  const list = (await writer.get(`/api/projects/${project.id}/graphics`)).body.graphics;
  assert.equal(list.filter((g) => g.icn.toLowerCase() === icn.toLowerCase()).length, 1, 'one registry row per ICN, whatever the case');
  assert.equal((await raw(writer, 'GET', `/api/projects/${project.id}/graphics/${icn.toLowerCase()}/file`)).status, 200);
  // Next-ICN suggestion: the highest sequence with the surrounding pattern kept.
  const next = (await writer.get(`/api/projects/${project.id}/graphics/next-icn`)).body;
  assert.equal(next.icn, 'ICN-AGS-A-240001-A-0AGS1-00001-A-01-1');
  assert.ok(!list.some((g) => g.icn.toLowerCase() === next.icn.toLowerCase()));
});

test('publication module save guards: empty refused unless allowed, unresolved entries reported', async () => {
  const url = `/api/projects/${project.id}/publication`;
  const golden = read(path.join(GOLDEN, 'publication.xml'));
  const empty = golden.replace(/<content>[\s\S]*<\/content>/, '<content></content>');
  let g = await writer.get(url);
  const refused = await writer.raw('PUT', url, { xml: empty, baseRevision: g.body.revision });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'EMPTY_PUBLICATION');
  assert.equal((await writer.get(url)).body.revision, g.body.revision, 'nothing was written');
  const allowed = await writer.raw('PUT', `${url}?allowEmpty=1`, { xml: empty, baseRevision: g.body.revision });
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal(allowed.body.counts.total, 0);
  assert.equal((await writer.raw('PUT', `${url}?allowEmpty=yes`, { xml: empty, baseRevision: allowed.body.revision })).status, 400);
  const ghost = golden.replace('systemCode="24" subSystemCode="1"', 'systemCode="97" subSystemCode="1"');
  const saved = await writer.raw('PUT', url, { xml: ghost, baseRevision: allowed.body.revision });
  assert.equal(saved.status, 200, saved.text);
  assert.ok(saved.body.unresolved.length >= 1);
  assert.ok(saved.body.counts.dms > 0);
  g = await writer.get(url);
  assert.equal((await writer.raw('PUT', url, { xml: golden, baseRevision: g.body.revision })).status, 200);
});

test('front-matter wording is a project setting with the JSS text as default', async () => {
  const url = `/api/projects/${project.id}/settings/wording`;
  const g = (await writer.get(url)).body;
  assert.deepEqual(g.wording, { authorityHeading: '', authority: '', documentNo: '' });
  assert.equal(g.fields.authority.default, 'Secretary, Ministry of Defence, Govt. of India');
  assert.equal(g.fields.documentNo.default, 'L&T Document No.: ');
  const r = await writer.raw('PUT', url, { authority: '-', documentNo: 'Document No.: ' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.changed.sort(), ['authority', 'documentNo']);
  const pj = JSON.parse(read(path.join(wsDir, 'project.json')));
  assert.equal(pj.frontMatter.labels.title.authority, '-');
  assert.equal(pj.frontMatter.labels.foreword.documentNo, 'Document No.: ');
  assert.equal((await writer.raw('PUT', url, { authority: 'x', extra: 1 })).body.code, 'UNKNOWN_FIELD');
  assert.equal((await writer.raw('PUT', url, { authority: 'a\u0007b' })).status, 400);
  assert.equal((await pm.get(url)).status, 404);
  assert.equal((await admin.raw('PUT', url, { authority: 'x' })).body.code, 'OVERRIDE_REQUIRED');
  const cleared = await writer.raw('PUT', url, { authority: '', documentNo: '' });
  assert.deepEqual(cleared.body.wording, { authorityHeading: '', authority: '', documentNo: '' });
  assert.ok(t.store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.wording_changed'").get().n >= 2);
});

test('the broken sample reports its schema errors, BREX breaches, missing graphic and unresolved reference', async () => {
  const p2 = (await writer.post('/api/projects', { name: 'Broken sample' })).body.project;
  for (const f of fs.readdirSync(path.join(BROKEN, 'csdb'))) {
    assert.equal((await writer.post(`/api/projects/${p2.id}/dms/import`, { content: read(path.join(BROKEN, 'csdb', f)) })).status, 201);
  }
  const pmGet = await writer.get(`/api/projects/${p2.id}/publication`);
  await writer.raw('PUT', `/api/projects/${p2.id}/publication`, { xml: read(path.join(BROKEN, 'publication.xml')), baseRevision: pmGet.body.revision });
  const expected = JSON.parse(read(path.join(BROKEN, 'expected.json')));
  const { findings } = (await writer.post(`/api/projects/${p2.id}/validate`)).body;
  const errs = findings.filter((f) => f.sev === 'error');
  for (const [rel, msgs] of Object.entries(expected.schemaErrors)) {
    for (const m of msgs) assert.ok(errs.some((f) => f.kind === 'schema' && f.rel === rel && f.message.includes(m)), `${rel}: ${m}`);
  }
  for (const [rel, rules] of Object.entries(expected.brexBreaches)) {
    for (const r of rules) assert.ok(errs.some((f) => f.kind === 'brex' && f.rel === rel && f.rule === r), `${rel}: ${r}`);
  }
  for (const icn of expected.missingGraphics) assert.ok(errs.some((f) => f.kind === 'graphic' && f.icn === icn), icn);
  for (const code of expected.unresolvedReferences) assert.ok(errs.some((f) => f.kind === 'reference' && f.code.includes(code.split('-').slice(0, 3).join('-'))), code);
  const expectedCount = Object.values(expected.schemaErrors).flat().length + Object.values(expected.brexBreaches).flat().length
    + expected.missingGraphics.length + expected.unresolvedReferences.length;
  assert.equal(errs.length, expectedCount, JSON.stringify(errs.map((e) => e.message)));
  for (const rel of expected.schemaValid) assert.ok(!errs.some((f) => f.kind === 'schema' && f.rel === rel), `${rel} is schema-valid`);
});

test('DMRL: export, then import of a sheet with new, existing, invalid and repeated rows', async () => {
  const exp = await raw(writer, 'GET', `/api/projects/${project.id}/dmrl`);
  assert.equal(exp.status, 200);
  assert.match(exp.type, /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(exp.buf);
  const ws = wb.getWorksheet('DMRL');
  // The Agastya original's master layout: group labels, then field names, data from row 3.
  assert.deepEqual(ws.getRow(2).values.slice(1), ['dmc', 'ModelIC', 'SDC', 'System', 'SubSystem', 'SubSubSys', 'Assembly',
    'DisCode', 'DisCodV', 'Infocode', 'InfoCodeV', 'ItemLoCode', 'TechName', 'InfoName', 'status', 'Allocated']);
  assert.equal(ws.getRow(1).getCell(2).value, 'DMC');
  assert.match(String(ws.getRow(3).getCell(1).value), /^DMC-AGS-/);
  assert.equal(ws.getRow(3).getCell(16).value, '-');
  ws.addRow(['', 'AGS', 'A', '24', '2', '0', '00', '00', 'A', '520', 'A', 'D', 'Fan', 'Remove procedure', '', '']);
  ws.addRow(['', 'AGS', 'A', '24', '2', '0', '00', '00', 'A', '720', 'A', 'D', 'Fan', 'Install procedure', '', '']);
  ws.addRow(['', 'AGS', 'A', '24', '2', '0', '00', '00', 'A', '72', 'A', 'D', 'Bad', 'Bad', '', '']);
  ws.addRow(['', 'AGS', 'A', '24', '2', '0', '00', '00', 'A', '720', 'A', 'D', 'Dup', 'Dup', '', '']);
  ws.addRow(['DMC--------', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']); // a pre-filled blank stub, skipped silently
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const pre = await upload(writer, `/api/projects/${project.id}/dmrl/preview`, { schemaType: 'auto' }, { data: buf, name: 'dmrl.xlsx' });
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.ok(pre.body.rows.filter((r) => r.exists).length >= 9);
  assert.equal(pre.body.rows.filter((r) => !r.exists).length, 2);
  assert.equal(pre.body.skipped.length, 2, JSON.stringify(pre.body.skipped));
  assert.equal((await upload(writer, `/api/projects/${project.id}/dmrl/preview`, { schemaType: 'fault' }, { data: buf, name: 'dmrl.xlsx' })).status, 400);
  const imp = await upload(writer, `/api/projects/${project.id}/dmrl/import`, { schemaType: 'auto' }, { data: buf, name: 'dmrl.xlsx' });
  assert.equal(imp.status, 200);
  assert.deepEqual(imp.body.created.map((m) => m.dmc).sort(), ['AGS-A-24-20-00-00A-520A-D', 'AGS-A-24-20-00-00A-720A-D']);
  assert.equal(imp.body.created[0].schemaType, 'proced');
  // The original's defaults for what a sheet does not carry: en/IN, 01, issue 001-00.
  const made = read(path.join(wsDir, 'csdb', imp.body.created[0].file));
  assert.match(made, /<language countryIsoCode="IN" languageIsoCode="en"/);
  assert.match(made, /securityClassification="01"/);
  assert.match(made, /<issueInfo inWork="00" issueNumber="001"/);
  assert.equal((await upload(writer, `/api/projects/${project.id}/dmrl/preview`, {}, { data: Buffer.from('not a workbook'), name: 'x.xlsx' })).body.code, 'UNREADABLE');
});

test('scope: outsiders get 404, Project Managers read only, the administrator needs an override to write', async () => {
  const someDm = (await writer.get(`/api/projects/${project.id}/dms`)).body.modules[0];
  // Earlier tests changed modules since the last build, so the stored PDF is out of date (decisions.md RL4): build it again first.
  assert.equal((await admin.get(`/api/projects/${project.id}/output.pdf`)).body.code, 'PDF_OUT_OF_DATE');
  assert.equal((await writer.post(`/api/projects/${project.id}/build`)).status, 200);
  const urls = [`/api/projects/${project.id}/dms`, `/api/projects/${project.id}/dms/${someDm.id}`, `/api/projects/${project.id}/graphics`, `/api/projects/${project.id}/publication`, `/api/projects/${project.id}/output.pdf`];
  for (const u of urls) {
    assert.equal((await outsider.get(u)).status, 404, `outsider ${u}`);
    assert.equal((await pm.get(u)).status, 404, `creating manager does not see an Author-owned project: ${u}`);
    assert.equal((await t.client().get(u)).status, 401, `anonymous ${u}`);
    assert.equal((await admin.get(u)).status, 200, `admin oversight ${u}`);
  }
  assert.equal((await outsider.post(`/api/projects/${project.id}/dms`, { dmc: DMC, techName: 'x', schemaType: 'descript' })).status, 404);
  assert.equal((await admin.post(`/api/projects/${project.id}/dms`, { dmc: DMC, techName: 'x', schemaType: 'descript' })).body.code, 'OVERRIDE_REQUIRED');

  // A Project Manager's own project, with the Author assigned: the manager reads, the Author writes.
  const pmProject = (await pm.post('/api/projects', { name: 'Managed manual' })).body.project;
  await pm.post(`/api/projects/${pmProject.id}/members`, { userId: writer.user.id });
  assert.equal((await writer.post(`/api/projects/${pmProject.id}/dms`, { dmc: DMC, techName: 'x', schemaType: 'proced' })).status, 201);
  assert.equal((await pm.get(`/api/projects/${pmProject.id}/dms`)).status, 200);
  assert.equal((await pm.post(`/api/projects/${pmProject.id}/dms`, { dmc: { ...DMC, infoCode: '041' }, techName: 'x', schemaType: 'descript' })).body.code, 'FORBIDDEN');

  // A data module id from another project is not found through this project.
  const otherDm = (await writer.get(`/api/projects/${pmProject.id}/dms`)).body.modules[0];
  assert.equal((await writer.get(`/api/projects/${project.id}/dms/${otherDm.id}`)).status, 404);
});
