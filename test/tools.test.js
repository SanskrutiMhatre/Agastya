'use strict';
// Standalone author tools (no project needed first): the DMC creator
// (routes/tools.js), built on the same DMRL reading and shell rendering the
// per-project import dialog uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const { startServer, adminClient, makeUser } = require('./helpers');

let t, admin, writer, pm;

async function upload(c, url, fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields || {})) form.append(k, v);
  if (file) form.append('file', new Blob([file.data]), file.name);
  const res = await fetch(t.base + url, { method: 'POST', body: form, headers: { cookie: c.cookie } });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary (zip) */ }
  return { status: res.status, body: json, buf: json ? null : buf };
}

async function sheet(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('DMRL');
  ws.addRow(['', 'DMC', '', '', '', '', '', '', '', '', '', '', 'Technical Name', 'Information Name', '', '']);
  ws.addRow(['dmc', 'ModelIC', 'SDC', 'System', 'SubSystem', 'SubSubSys', 'Assembly', 'DisCode', 'DisCodV', 'Infocode', 'InfoCodeV', 'ItemLoCode', 'TechName', 'InfoName', 'status', 'Allocated']);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test.before(async () => {
  t = await startServer();
  admin = await adminClient(t);
  pm = await makeUser(t, admin, { username: 'tools.pm', role: 'project_manager' });
  writer = await makeUser(t, admin, { username: 'tools.author', role: 'author' });
});
test.after(() => t.stop());

test('DMC creator: typed-in rows become a zip of shells directly, with no spreadsheet involved', async () => {
  const good = { dmc: 'AGS-A-24-20-00-00A-520A-D', techName: 'Fan', infoName: 'Remove procedure', schemaType: 'proced' };
  const res = await fetch(`${t.base}/api/tools/dmc/shells.zip`, {
    method: 'POST', headers: { cookie: writer.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: [good, { ...good, dmc: 'AGS-A-24-20-00-00A-040A-D', techName: 'Fan', infoName: 'General description', schemaType: 'descript' }] }),
  });
  assert.equal(res.status, 200);
  const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  assert.deepEqual(names, ['csdb/DMC-AGS-A-24-20-00-00A-040A-D.xml', 'csdb/DMC-AGS-A-24-20-00-00A-520A-D.xml']);
  const xml = await zip.files[names[1]].async('string');
  assert.match(xml, /<techName>Fan<\/techName>/);
  assert.match(xml, /issueType="new"/);

  // A bad code, a duplicate code, and nothing at all are each refused cleanly.
  const bad = await fetch(`${t.base}/api/tools/dmc/shells.zip`, { method: 'POST', headers: { cookie: writer.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [{ dmc: 'not a code', techName: 'X' }] }) });
  assert.equal((await bad.json()).code, 'BAD_DMC');
  const dup = await fetch(`${t.base}/api/tools/dmc/shells.zip`, { method: 'POST', headers: { cookie: writer.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [good, good] }) });
  assert.equal((await dup.json()).code, 'DUPLICATE_DMC');
  const empty = await fetch(`${t.base}/api/tools/dmc/shells.zip`, { method: 'POST', headers: { cookie: writer.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [] }) });
  assert.equal((await empty.json()).code, 'VALIDATION');
});

test('DMC creator: a spreadsheet previews with no project, and downloads as a zip of shells', async () => {
  const buf = await sheet([
    ['', 'AGS', 'A', '24', '2', '0', '00', '00', 'A', '520', 'A', 'D', 'Fan', 'Remove procedure', '', ''],
    ['', 'AGS', 'A', '24', '2', '0', '00', '00', 'A', '040', 'A', 'D', 'Fan', 'General description', '', ''],
  ]);
  const pre = await upload(writer, '/api/tools/dmrl/preview', { schemaType: 'auto' }, { data: buf, name: 'dmrl.xlsx' });
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.equal(pre.body.rows.length, 2);
  assert.equal(pre.body.rows[0].schemaType, 'proced');
  assert.equal(pre.body.rows[1].schemaType, 'descript');
  assert.equal(pre.body.rows[0].dmc, 'AGS-A-24-20-00-00A-520A-D');

  // A Project Manager cannot (project.import is Author-only, same as "New project from a file").
  assert.equal((await upload(pm, '/api/tools/dmrl/preview', {}, { data: buf, name: 'dmrl.xlsx' })).status, 403);

  const zipRes = await upload(writer, '/api/tools/dmrl/shells.zip', { schemaType: 'auto', rows: String(pre.body.rows[0].row) }, { data: buf, name: 'dmrl.xlsx' });
  assert.equal(zipRes.status, 200);
  const zip = await JSZip.loadAsync(zipRes.buf);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  assert.deepEqual(names, ['csdb/DMC-AGS-A-24-20-00-00A-520A-D.xml']);
  const xml = await zip.files[names[0]].async('string');
  assert.match(xml, /modelIdentCode="AGS"/);
  assert.match(xml, /infoCode="520"/);
  assert.match(xml, /<techName>Fan<\/techName>/);
  assert.match(xml, /issueType="new"/);

  // Nothing was written to any project: it is a pure download.
  assert.deepEqual((await writer.get('/api/projects')).body.projects, []);
});

test('DMC creator: an unreadable file and an empty selection are refused cleanly', async () => {
  const bad = await upload(writer, '/api/tools/dmrl/preview', {}, { data: Buffer.from('not a workbook'), name: 'x.xlsx' });
  assert.equal(bad.body.code, 'UNREADABLE');
  const buf = await sheet([['', 'AGS', 'A', '24', '2', '0', '00', '00', 'A', '520', 'A', 'D', 'Fan', 'Remove procedure', '', '']]);
  const none = await upload(writer, '/api/tools/dmrl/shells.zip', { rows: '999' }, { data: buf, name: 'dmrl.xlsx' });
  assert.equal(none.body.code, 'NOTHING_TO_CREATE');
});
