'use strict';
// Release marking and download control over real HTTP (Phase 10, decisions.md
// RL1-RL6): an unapproved build is stamped NOT RELEASED whatever the settings
// say; after approval a rebuild is released ("Release N", the project's own
// watermark if set); a PDF that no longer matches the content, its settings or
// the release state is refused on every route; every build records what it
// was made from; downloads are audited; outsiders get nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServer, adminClient, makeUser } = require('./helpers');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');
const ICN = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';
let t, admin, pm, author, outsider, project, dir;

async function pdfText(buf) {
  const { extractPdfText } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'pdf-text.mjs')).href);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agastya-pdf-')), 'p.pdf');
  fs.writeFileSync(f, buf);
  return (await extractPdfText(f)).pages.join('\n').replace(/\s+/g, ' ');
}
async function fetchPdf(c, url) {
  const res = await fetch(t.base + url, { headers: { cookie: c.cookie } });
  const buf = Buffer.from(await res.arrayBuffer());
  let body = null; try { body = JSON.parse(buf.toString()); } catch { /* a PDF */ }
  return { status: res.status, buf, body, release: res.headers.get('x-agastya-release'), type: res.headers.get('content-type') };
}
const audits = (action) => t.store.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action).map((r) => ({ ...r, meta: JSON.parse(r.meta || 'null') }));

test.before(async () => {
  t = await startServer();
  admin = await adminClient(t);
  pm = await makeUser(t, admin, { username: 'priya.rao', role: 'project_manager' });
  author = await makeUser(t, pm, { username: 'arjun.das', role: 'author' });
  outsider = await makeUser(t, pm, { username: 'ravi.k', role: 'author' });
  project = (await author.post('/api/projects', { name: 'PDU release' })).body.project;
  dir = path.join(t.dataDir, 'projects', project.id);
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) {
    await author.post(`/api/projects/${project.id}/dms/import`, { filename: f, content: fs.readFileSync(path.join(GOLDEN, 'csdb', f), 'utf8') });
  }
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(path.join(GOLDEN, 'csdb', `${ICN}.png`))]), `${ICN}.png`);
  await fetch(`${t.base}/api/projects/${project.id}/graphics`, { method: 'POST', body: form, headers: { cookie: author.cookie } });
  for (const f of ['emblem.png', 'publisher-logo.png']) fs.copyFileSync(path.join(GOLDEN, 'Media', f), path.join(dir, 'Media', f));
  const g = await author.get(`/api/projects/${project.id}/publication`);
  await author.raw('PUT', `/api/projects/${project.id}/publication`, { xml: fs.readFileSync(path.join(GOLDEN, 'publication.xml'), 'utf8'), baseRevision: g.body.revision });
});
test.after(() => t.stop());

test('unapproved: every build is stamped NOT RELEASED, even with the watermark switched off or set to other text', { timeout: 240000 }, async () => {
  assert.equal((await author.raw('PUT', `/api/projects/${project.id}/settings/watermark`, { value: { enabled: false, text: '', style: 'diagonal' } })).status, 200);
  const b = await author.post(`/api/projects/${project.id}/build`, {});
  assert.equal(b.status, 200, b.text);
  assert.deepEqual([b.body.marking.released, b.body.marking.watermark.text, b.body.marking.watermark.forced], [false, 'NOT RELEASED', true]);
  assert.ok(fs.readFileSync(path.join(dir, '_watermark.svg'), 'utf8').includes('NOT RELEASED'), 'the stamp the stylesheets draw');
  const fo = fs.readFileSync(path.join(dir, 'output.fo'), 'utf8');
  assert.match(fo, /background-image="[^"]*_watermark\.svg/, 'set as the page background');
  const pdf = await fetchPdf(author, `/api/projects/${project.id}/output.pdf?download=1`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.release, 'NOT RELEASED');
  const text = await pdfText(pdf.buf);
  // Drawn by FOP on every non-cover page (the JSS stylesheets leave covers and blank versos unmarked).
  assert.match(text, /NOT RELEASED/);
  assert.ok(!/Release \d/.test(text), 'no release in the running head');
  // Recorded with what it was made from.
  const row = t.store.db.prepare("SELECT * FROM builds WHERE project_id = ? AND kind = 'full' ORDER BY id DESC").get(project.id);
  assert.ok(row.fingerprint && row.settings_hash && row.pdf_sha256);
  assert.deepEqual([row.released, row.marking], [0, 'NOT RELEASED']);
  // A module preview is marked the same way.
  const dm = (await author.get(`/api/projects/${project.id}/dms`)).body.modules[0];
  const pv = await author.post(`/api/projects/${project.id}/dms/${dm.id}/preview`, {});
  assert.equal(pv.status, 200);
  const prow = t.store.db.prepare("SELECT * FROM builds WHERE project_id = ? AND kind = 'preview' ORDER BY id DESC").get(project.id);
  assert.equal(prow.marking, 'NOT RELEASED');
});

let request;
test('approval releases the publication: the old PDF is refused, a rebuild carries Release 1 and the project watermark', { timeout: 300000 }, async () => {
  const s = await author.post(`/api/projects/${project.id}/requests`, { approverId: pm.user.id });
  assert.equal(s.status, 201, s.text);
  request = s.body.request;
  // Not by the Author who submitted it, not by an outsider (neither is told the decision route exists for them).
  for (const c of [author, outsider]) {
    const r = await c.post(`/api/requests/${request.id}/decision`, { outcome: 'approve', comment: 'mine' });
    assert.ok([403, 404].includes(r.status), `refused: ${r.status}`);
  }
  assert.equal((await author.get(`/api/projects/${project.id}/builds/last`)).body.release.released, false, 'still unreleased');
  const d = await pm.post(`/api/requests/${request.id}/decision`, { outcome: 'approve', comment: 'Approved for issue.' });
  assert.equal(d.status, 200, d.text);
  const old = await fetchPdf(author, `/api/projects/${project.id}/output.pdf?download=1`);
  assert.equal(old.status, 409);
  assert.equal(old.body.code, 'PDF_OUT_OF_DATE');
  assert.match(old.body.error, /approved since/);
  assert.equal((await fetchPdf(author, `/api/projects/${project.id}/output.pdf`)).status, 409, 'inline too');
  assert.equal((await author.get(`/api/projects/${project.id}/builds/last`)).body.release.released, true);

  const b = await author.post(`/api/projects/${project.id}/build`, {});
  assert.equal(b.status, 200, b.text);
  assert.deepEqual([b.body.marking.released, b.body.marking.releaseNumber, b.body.marking.watermark], [true, 1, null]);
  assert.ok(!fs.existsSync(path.join(dir, '_watermark.svg')), 'no stamp left from the last build');
  const pdf = await fetchPdf(author, `/api/projects/${project.id}/output.pdf?download=1`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.release, 'Release 1');
  const text = await pdfText(pdf.buf);
  assert.match(text, /Release 1/, 'the release in the running head');
  assert.ok(!fs.readFileSync(path.join(dir, 'output.fo'), 'utf8').includes('_watermark.svg'));
  const dl = audits('publication.downloaded').pop();
  assert.deepEqual([dl.meta.released, dl.meta.releaseNumber], [true, 1]);
  assert.equal((await fetchPdf(pm, `/api/projects/${project.id}/output.pdf?download=1`)).status, 404, 'the approving manager does not see an Author-owned project');
  assert.equal((await fetchPdf(outsider, `/api/projects/${project.id}/output.pdf?download=1`)).status, 404);
});

test('a released publication with its own watermark; then an edit makes it NOT RELEASED again and the released PDF is refused', { timeout: 300000 }, async () => {
  // A settings change is a content change for the release (project.json is in the fingerprint): it must be approved again.
  assert.equal((await author.raw('PUT', `/api/projects/${project.id}/settings/watermark`, { value: { enabled: true, text: 'CONTROLLED COPY', style: 'horizontal' } })).status, 200);
  const stale = await fetchPdf(author, `/api/projects/${project.id}/output.pdf?download=1`);
  assert.equal(stale.status, 409);
  const b1 = await author.post(`/api/projects/${project.id}/build`, {});
  assert.equal(b1.body.marking.watermark.text, 'NOT RELEASED', 'changed settings are not released');
  const s = await author.post(`/api/projects/${project.id}/requests`, { approverId: pm.user.id });
  assert.equal(s.status, 201, s.text);
  assert.equal((await pm.post(`/api/requests/${s.body.request.id}/decision`, { outcome: 'approve', comment: 'Watermark approved.' })).status, 200);
  const b2 = await author.post(`/api/projects/${project.id}/build`, {});
  assert.deepEqual([b2.body.marking.released, b2.body.marking.releaseNumber, b2.body.marking.watermark.text, b2.body.marking.watermark.style], [true, 2, 'CONTROLLED COPY', 'horizontal']);
  assert.ok(fs.readFileSync(path.join(dir, '_watermark.svg'), 'utf8').includes('CONTROLLED COPY'));
  const r2 = await fetchPdf(author, `/api/projects/${project.id}/output.pdf?download=1`);
  assert.equal(r2.release, 'Release 2');
  const t2 = await pdfText(r2.buf);
  assert.match(t2, /CONTROLLED COPY/);
  assert.match(t2, /Release 2/);
  assert.ok(!/NOT RELEASED/.test(t2));

  // An edit after the release: the released PDF can no longer be fetched, and the next build is stamped.
  const dm = (await author.get(`/api/projects/${project.id}/dms`)).body.modules.find((m) => m.dmc === 'AGS-A-24-00-00-00A-030A-D');
  const g = await author.get(`/api/projects/${project.id}/dms/${dm.id}`);
  assert.equal((await author.raw('PUT', `/api/projects/${project.id}/dms/${dm.id}`, { xml: g.body.xml.replace('</dmodule>', '\n</dmodule>'), baseRevision: g.body.revision })).status, 200);
  const after = await fetchPdf(author, `/api/projects/${project.id}/output.pdf?download=1`);
  assert.equal(after.status, 409);
  assert.match(after.body.error, /content changed/);
  const last = (await author.get(`/api/projects/${project.id}/builds/last`)).body;
  assert.deepEqual([last.pdfCurrent, last.release.released, last.release.stale], [false, false, true]);
  const b3 = await author.post(`/api/projects/${project.id}/build`, {});
  assert.deepEqual([b3.body.marking.released, b3.body.marking.watermark.text], [false, 'NOT RELEASED']);
  assert.equal((await fetchPdf(author, `/api/projects/${project.id}/output.pdf?download=1`)).release, 'NOT RELEASED');
});

test('a PDF file replaced on disk is refused: the server serves only the file its build wrote', async () => {
  fs.appendFileSync(path.join(dir, 'output.pdf'), '\n% tampered');
  const r = await fetchPdf(author, `/api/projects/${project.id}/output.pdf?download=1`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /not the one the last build wrote/);
});
