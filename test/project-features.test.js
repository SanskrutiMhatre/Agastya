'use strict';
// The project features from the JSS PDF Publisher over real HTTP (Phase 8,
// decisions.md ST1-ST7, GR1-GR6): settings that are saved, restored and
// checked; page size and margins that reach the PDF; identity in a JSS book;
// branding; ICNs, symbols and parts with their problems; parts added to an
// IPD module that stays schema-valid; graphic metadata, deletion, export and
// re-import; DMC and PMC downloads; and who may do each.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { startServer, adminClient, makeUser } = require('./helpers');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');
const ICN = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';
const PNG = fs.readFileSync(path.join(GOLDEN, 'csdb', `${ICN}.png`));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let t, pm, author, outsider, project, dir;

async function form(c, url, file, fields = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (file) f.append('file', new Blob([file.data]), file.name);
  const res = await fetch(t.base + url, { method: 'POST', body: f, headers: { cookie: c.cookie } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const raw = async (c, url) => { const r = await fetch(t.base + url, { headers: { cookie: c.cookie } }); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), disposition: r.headers.get('content-disposition') }; };
const put = (c, group, value) => c.raw('PUT', `/api/projects/${project.id}/settings/${group}`, { value });

test.before(async () => {
  t = await startServer();
  const admin = await adminClient(t);
  pm = await makeUser(t, admin, { username: 'priya.rao', role: 'project_manager' });
  author = await makeUser(t, pm, { username: 'arjun.das', role: 'author' });
  outsider = await makeUser(t, pm, { username: 'ravi.k', role: 'author' });
  project = (await pm.post('/api/projects', { name: 'Features', members: [author.user.id] })).body.project;
  dir = path.join(t.dataDir, 'projects', project.id);
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) {
    await author.post(`/api/projects/${project.id}/dms/import`, { filename: f, content: fs.readFileSync(path.join(GOLDEN, 'csdb', f), 'utf8') });
  }
  await form(author, `/api/projects/${project.id}/graphics`, { data: PNG, name: `${ICN}.png` });
  const g = await author.get(`/api/projects/${project.id}/publication`);
  await author.raw('PUT', `/api/projects/${project.id}/publication`, { xml: fs.readFileSync(path.join(GOLDEN, 'publication.xml'), 'utf8'), baseRevision: g.body.revision });
});
test.after(() => t.stop());

test('settings: each group saved and read back; bad values refused by field; the manager reads, the Author writes', async () => {
  const before = (await author.get(`/api/projects/${project.id}/settings`)).body;
  assert.deepEqual(before.groups, ['identity', 'publishers', 'page', 'type', 'pipeline', 'watermark']);
  assert.equal(before.settings.page.size, 'A4 portrait', 'from the house template');
  assert.equal((await put(author, 'identity', { bookName: 'Maintenance Manual', publicationNo: 'PUB-7', securityClassification: 'restricted' })).status, 200);
  assert.equal((await put(author, 'type', { fontFamily: 'Times', bodySize: '10pt', blankVersos: false, tocDepth: 2 })).status, 200);
  assert.equal((await put(author, 'pipeline', { pipeline: 's1000dtofo' })).status, 200);
  assert.equal((await put(author, 'pipeline', { pipeline: 's1000dtojss' })).status, 200);
  const after = (await pm.get(`/api/projects/${project.id}/settings`)).body.settings;
  assert.deepEqual([after.identity.publicationNo, after.identity.securityClassification, after.type.fontFamily, after.type.tocDepth, after.type.blankVersos], ['PUB-7', 'RESTRICTED', 'Times', 2, false]);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  assert.deepEqual([pj.publication.publicationNo, pj.overrides.layout.fonts.family, pj.overrides.layout.toc.sectionDepth], ['PUB-7', 'Times', 2]);
  // Refused, naming the field; nothing written.
  const bad = [
    ['identity', { bookName: 'x'.repeat(201) }, 'Book name'], ['identity', { nonsense: '1' }, 'nonsense'],
    ['identity', { securityClassification: 'SUPER' }, 'securityClassification'], ['page', { size: 'A9' }, 'size'],
    ['page', { size: 'Custom', width: '20mm' }, 'size'], ['page', { size: 'Custom', marginInner: '-4mm' }, 'marginInner'],
    ['type', { fontFamily: 'Comic Sans' }, 'fontFamily'], ['type', { bodySize: '40pt' }, 'bodySize'],
    ['pipeline', { pipeline: 'saxon' }, 'pipeline'], ['watermark', { enabled: true, text: '' }, 'text'],
    ['watermark', { enabled: true, text: 'X', style: 'spiral' }, 'style'], ['publishers', { publishers: [{}, {}, {}] }, 'publishers'],
    ['publishers', { publishers: [{ name: 'A', logo: 'Media/none.png' }] }, 'publishers.0.logo'], ['publishers', { publishers: [{ name: 'A', logo: '../x.png' }] }, 'publishers.0.logo'],
  ];
  const pjBefore = fs.readFileSync(path.join(dir, 'project.json'));
  for (const [g, v, field] of bad) {
    const r = await put(author, g, v);
    assert.equal(r.status, 400, `${g} ${JSON.stringify(v).slice(0, 60)}`);
    assert.ok(r.body.field === field || (r.body.error || '').includes(field), `${g}: ${r.body.field} / ${r.body.error}`);
  }
  assert.ok(fs.readFileSync(path.join(dir, 'project.json')).equals(pjBefore));
  assert.equal((await put(author, 'colours', {})).body.code, 'NOT_FOR_FORMAT');
  assert.equal((await put(pm, 'identity', { bookName: 'PM' })).status, 403, 'a Project Manager does not edit (D2)');
  assert.equal((await outsider.get(`/api/projects/${project.id}/settings`)).status, 404);
});

test('branding: logos uploaded into Media/ by a safe name and named by a publisher; ICNs, SVG and bad names refused', async () => {
  const ok = await form(author, `/api/projects/${project.id}/branding`, { data: PNG, name: 'company logo.png' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.file, 'Media/company-logo.png');
  assert.equal((await form(author, `/api/projects/${project.id}/branding`, { data: Buffer.from('<svg/>'), name: 'x.png' })).status, 415);
  // The upload parser keeps only the file's own name, so a folder in it never reaches the disk.
  const climbed = await form(author, `/api/projects/${project.id}/branding`, { data: PNG, name: '../x.png' });
  assert.equal(climbed.body.file, 'Media/x.png');
  assert.equal((await form(author, `/api/projects/${project.id}/branding`, { data: PNG, name: 'bad name!.png' })).body.code, 'BAD_NAME');
  assert.equal((await form(author, `/api/projects/${project.id}/branding`, { data: PNG, name: `${ICN}.png` })).body.code, 'BAD_NAME');
  assert.equal((await form(pm, `/api/projects/${project.id}/branding`, { data: PNG, name: 'pm.png' })).status, 403);
  const p = await put(author, 'publishers', { publishers: [{ name: 'Agastya Works', addressLines: ['Pune'], logo: 'Media/company-logo.png' }, { name: 'Partner', addressLines: [], logo: '' }] });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.body.settings.publishers[0].logo, 'Media/company-logo.png');
  assert.equal(p.body.settings.publishersFromTemplate, false);
});

test('Resize Pages: A4 landscape and the margins reach the PDF; the identity is on its pages', { timeout: 240000 }, async () => {
  assert.equal((await put(author, 'page', { size: 'A4 landscape', marginInner: '20mm', marginOuter: '15mm' })).status, 200);
  const s = (await author.get(`/api/projects/${project.id}/settings`)).body.settings.page;
  assert.deepEqual([s.size, s.width, s.height, s.marginInner], ['A4 landscape', '297mm', '210mm', '20mm']);
  const b = await author.post(`/api/projects/${project.id}/build`, {});
  assert.equal(b.status, 200, b.text);
  const pdf = fs.readFileSync(path.join(dir, 'output.pdf')).toString('latin1');
  const boxes = [...pdf.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Math.round(Number(m[1])), Math.round(Number(m[2]))]);
  assert.ok(boxes.length > 3, 'page boxes found');
  assert.ok(boxes.every(([w, h]) => w === 842 && h === 595), `every page A4 landscape: ${JSON.stringify(boxes.slice(0, 3))}`);
  const fo = fs.readFileSync(path.join(dir, 'output.fo'), 'utf8');
  assert.match(fo, /page-width="297mm"/);
  assert.match(fo, /PUB-7/, 'the publication number from Identity');
  // And back to portrait.
  assert.equal((await put(author, 'page', { size: 'A4 portrait' })).status, 200);
  assert.equal((await author.get(`/api/projects/${project.id}/settings`)).body.settings.page.size, 'A4 portrait');
});

test('Resize Pages per chapter: a chapter set to A4 landscape in the builder is landscape in the PDF, the rest portrait', { timeout: 240000 }, async () => {
  const m = (await author.get(`/api/projects/${project.id}/publication/model`)).body;
  const entries = JSON.parse(JSON.stringify(m.entries));
  const chapter = entries.find((e) => e.type === 'folder');
  assert.ok(chapter, 'the golden publication has chapters');
  chapter.page = 'a4-landscape';
  assert.equal((await author.raw('PUT', `/api/projects/${project.id}/publication/model`, { entries: [...entries.slice(0, 0), ...entries].map((e) => (e === chapter ? { ...e, page: 'a5-sideways' } : e)), baseRevision: m.revision })).body.code, 'VALIDATION');
  const r = await author.raw('PUT', `/api/projects/${project.id}/publication/model`, { entries, baseRevision: m.revision });
  assert.equal(r.status, 200, r.text);
  assert.match(fs.readFileSync(path.join(dir, 'publication.xml'), 'utf8'), /<pmEntry id="a4-landscape">/);
  const back = (await author.get(`/api/projects/${project.id}/publication/model`)).body.entries.find((e) => e.type === 'folder');
  assert.equal(back.page, 'a4-landscape', 'read back');
  assert.equal((await author.post(`/api/projects/${project.id}/build`, {})).status, 200);
  const pdf = fs.readFileSync(path.join(dir, 'output.pdf')).toString('latin1');
  const boxes = [...pdf.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((x) => `${Math.round(Number(x[1]))}x${Math.round(Number(x[2]))}`);
  assert.ok(boxes.includes('842x595') && boxes.includes('595x842'), `both orientations: ${[...new Set(boxes)].join(', ')}`);
});

test('a JSS project: identity is written into the book through the write path; publishers and pipeline are not its settings', async () => {
  const book = '<?xml version="1.0" encoding="UTF-8"?>\n<jssbook>\n  <bookmeta>\n    <bookName>Pump</bookName>\n  </bookmeta>\n  <body><chapter number="1"><title>A</title><section><title>B</title><para>C</para></section></chapter></body>\n</jssbook>\n';
  const j = await form(author, '/api/projects/from-xml', { data: book, name: 'b.xml' }, { name: 'JSS settings', format: 'jss' });
  assert.equal(j.status, 201);
  const id = j.body.project.id;
  const g = (await author.get(`/api/projects/${id}/settings`)).body;
  assert.deepEqual(g.groups, ['identity', 'page', 'type', 'watermark']);
  assert.equal(g.settings.identity.bookName, 'Pump');
  const r = await author.raw('PUT', `/api/projects/${id}/settings/identity`, { value: { bookName: 'Pump & valve', publicationNo: 'J-1' } });
  assert.equal(r.status, 200, r.text);
  const text = fs.readFileSync(path.join(t.dataDir, 'projects', id, 'publication.xml'), 'utf8');
  assert.match(text, /<bookName>Pump &amp; valve<\/bookName>/);
  assert.match(text, /<publicationNo>J-1<\/publicationNo>/);
  assert.match(text, /<body><chapter number="1">/, 'the rest of the book untouched');
  const revs = t.store.db.prepare("SELECT COUNT(*) AS n FROM revisions r JOIN documents d ON d.id = r.document_id WHERE d.project_id = ? AND d.rel_path = 'publication.xml'").get(id).n;
  assert.ok(revs >= 2, 'a revision for the change');
  assert.equal((await author.raw('PUT', `/api/projects/${id}/settings/publishers`, { value: { publishers: [] } })).body.code, 'NOT_FOR_FORMAT');
  assert.equal((await author.raw('PUT', `/api/projects/${id}/settings/pipeline`, { value: { pipeline: 's1000dtofo' } })).body.code, 'NOT_FOR_FORMAT');
});

let ipd;
test('graphics: ICNs, symbols and parts, each with its problems; a part added to an IPD module keeps it schema-valid', async () => {
  // A symbol, a missing ICN and a duplicate image.
  const dm = (await author.get(`/api/projects/${project.id}/dms`)).body.modules.find((m) => m.dmc === 'AGS-A-24-00-00-00A-030A-D');
  const g = await author.get(`/api/projects/${project.id}/dms/${dm.id}`);
  const xml = g.body.xml.replace(/<description>/, '<description><para>Press <symbol infoEntityIdent="ICN-AGS-A-240000-A-0AGS1-00099-A-01-1"/> now.</para><figure><title>Gone</title><graphic infoEntityIdent="ICN-AGS-A-240000-A-0AGS1-00077-A-01-1"/></figure>');
  assert.equal((await author.raw('PUT', `/api/projects/${project.id}/dms/${dm.id}`, { xml, baseRevision: g.body.revision })).status, 200);
  await form(author, `/api/projects/${project.id}/graphics`, { data: PNG, name: 'ICN-AGS-A-240000-A-0AGS1-00099-A-01-1.png' });
  await form(author, `/api/projects/${project.id}/graphics`, { data: PNG, name: 'ICN-AGS-A-240000-A-0AGS1-00001-A-02-1.png' }); // the same picture, issue 02
  // An IPD module and a part in it.
  const c = await author.post(`/api/projects/${project.id}/dms`, { dmc: { modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '24', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: '00', disassyCodeVariant: 'A', infoCode: '941', infoCodeVariant: 'A', itemLocationCode: 'D' }, techName: 'PDU parts', infoName: 'Illustrated parts data', schemaType: 'ipd' });
  assert.equal(c.status, 201, c.text);
  ipd = c.body.module;
  const add = await author.post(`/api/projects/${project.id}/parts`, { dmId: ipd.id, figureNumber: '01', item: '010', indenture: '1', partNumber: 'PSU-400', manufacturer: 'k0001', description: 'Power supply module', quantity: '2' });
  assert.equal(add.status, 201, add.text);
  assert.equal((await author.post(`/api/projects/${project.id}/parts`, { dmId: ipd.id, figureNumber: '01', item: '010', partNumber: 'X', manufacturer: 'K0001' })).body.code, 'VALIDATION', 'the same figure and item');
  assert.equal((await author.post(`/api/projects/${project.id}/parts`, { dmId: ipd.id, figureNumber: '01', item: '011', partNumber: 'X', manufacturer: 'K1' })).body.code, 'VALIDATION', 'a manufacturer code is five characters');
  assert.equal((await author.post(`/api/projects/${project.id}/parts`, { dmId: dm.id, figureNumber: '01', item: '011', partNumber: 'X', manufacturer: 'K0001' })).body.code, 'VALIDATION', 'not an IPD module');
  assert.equal((await pm.post(`/api/projects/${project.id}/parts`, { dmId: ipd.id, figureNumber: '01', item: '020', partNumber: 'X', manufacturer: 'K0001' })).status, 403);
  const v = await author.post(`/api/projects/${project.id}/dms/${ipd.id}/validate`, {});
  assert.equal(v.body.valid, true, JSON.stringify(v.body.findings.filter((f) => f.sev === 'error')));

  const a = (await author.get(`/api/projects/${project.id}/assets`)).body;
  const sym = a.symbols.find((x) => x.icn === 'ICN-AGS-A-240000-A-0AGS1-00099-A-01-1');
  assert.ok(sym && sym.usedAs.includes('symbol'));
  const missing = a.icns.find((x) => x.icn === 'ICN-AGS-A-240000-A-0AGS1-00077-A-01-1');
  assert.ok(missing.problems.some((p) => p.code === 'missing'));
  const fig = a.icns.find((x) => x.icn === ICN);
  assert.deepEqual([fig.issue, fig.security, fig.variant], ['01', '1', 'A']);
  assert.deepEqual(fig.issues, ['ICN-AGS-A-240000-A-0AGS1-00001-A-02-1', ICN], 'its issues, newest first');
  assert.ok(fig.problems.some((p) => p.code === 'duplicate'), 'the same image under another ICN');
  const part = a.parts.find((p) => p.partNumber === 'PSU-400');
  assert.deepEqual([part.manufacturer, part.description, part.entries[0].quantity, part.entries[0].item], ['K0001', 'Power supply module', '2', '010']);
  assert.deepEqual(a.ipdModules.map((m) => m.dmc), [ipd.dmc]);
});

test('graphic metadata, deletion only when unused, export of ICNs and symbols, and re-import into another project', async () => {
  assert.equal((await author.raw('PATCH', `/api/projects/${project.id}/graphics/${ICN}`, { title: 'Block diagram' })).status, 200);
  assert.equal((await author.get(`/api/projects/${project.id}/assets`)).body.icns.find((x) => x.icn === ICN).title, 'Block diagram');
  assert.equal((await author.raw('PATCH', `/api/projects/${project.id}/graphics/ICN-NOPE-0001`, { title: 'x' })).status, 404);
  assert.equal((await author.raw('DELETE', `/api/projects/${project.id}/graphics/${ICN}`, {})).body.code, 'GRAPHIC_IN_USE');
  const unused = 'ICN-AGS-A-240000-A-0AGS1-00001-A-02-1';
  assert.equal((await pm.raw('DELETE', `/api/projects/${project.id}/graphics/${unused}`, {})).status, 403);
  // Export before deleting it: ICNs only, then symbols only.
  const z = await raw(author, `/api/projects/${project.id}/graphics.zip?kind=icn`);
  assert.equal(z.status, 200);
  const zip = await JSZip.loadAsync(z.buf);
  const listed = JSON.parse(await zip.file('graphics.json').async('string')).graphics;
  assert.ok(listed.some((x) => x.icn === ICN && x.title === 'Block diagram'));
  assert.ok(!listed.some((x) => x.kind === 'symbol'));
  assert.ok((await zip.file(`csdb/${ICN}.png`).async('nodebuffer')).equals(PNG));
  const symZip = await JSZip.loadAsync((await raw(author, `/api/projects/${project.id}/graphics.zip?kind=symbol`)).buf);
  assert.deepEqual(JSON.parse(await symZip.file('graphics.json').async('string')).graphics.map((x) => x.icn), ['ICN-AGS-A-240000-A-0AGS1-00099-A-01-1']);
  assert.equal((await author.raw('DELETE', `/api/projects/${project.id}/graphics/${unused}`, {})).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'Media', `${unused}.png`)));
  // Re-import: the graphics zip is read by Import package; files and names are kept.
  const other = (await author.post('/api/projects', { name: 'Graphics copy' })).body.project;
  const imp = await form(author, `/api/projects/${other.id}/package/import`, { data: z.buf, name: 'g.zip' });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.ok(imp.body.graphics.length >= 1);
  assert.equal(sha(fs.readFileSync(path.join(t.dataDir, 'projects', other.id, 'Media', `${ICN}.png`))), sha(PNG));
});

test('DMC and PMC downloads are the stored files byte for byte; outsiders get 404', async () => {
  const dm = (await author.get(`/api/projects/${project.id}/dms`)).body.modules[0];
  const d = await raw(author, `/api/projects/${project.id}/dms/${dm.id}/file`);
  assert.equal(d.status, 200);
  assert.match(d.disposition, new RegExp(`filename="${dm.file}"`));
  assert.ok(d.buf.equals(fs.readFileSync(path.join(dir, 'csdb', dm.file))));
  const p = await raw(pm, `/api/projects/${project.id}/publication/file`);
  assert.equal(p.status, 200);
  assert.match(p.disposition, /filename="PMC-Features\.xml"/);
  assert.ok(p.buf.equals(fs.readFileSync(path.join(dir, 'publication.xml'))));
  assert.equal((await raw(outsider, `/api/projects/${project.id}/dms/${dm.id}/file`)).status, 404);
  assert.equal((await raw(outsider, `/api/projects/${project.id}/publication/file`)).status, 404);
});
