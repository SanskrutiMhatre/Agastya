'use strict';
// The whole publication workflow in the browser (Phase 10, decisions.md
// RL1-RL6), from creating the project to downloading the released PDF: a
// project from a package, validated and built (stamped NOT RELEASED),
// submitted, approved by the Project Manager, rebuilt as Release 1 and
// downloaded; an edit afterwards makes it NOT RELEASED again and the released
// PDF can no longer be downloaded; outsiders get nothing, even by calling the
// download route directly. No screenshots are taken.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const JSZip = require('jszip');
const { test, expect, signedIn, authorApi, freshApi } = require('./fixtures');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');

async function pdfText(buf) {
  const { extractPdfText } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'pdf-text.mjs')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agastya-e2e-pdf-'));
  try { fs.writeFileSync(path.join(dir, 'p.pdf'), buf); return (await extractPdfText(path.join(dir, 'p.pdf'))).pages.join('\n').replace(/\s+/g, ' '); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
async function readDownload(download) {
  const chunks = [];
  for await (const c of await download.createReadStream()) chunks.push(c);
  return Buffer.concat(chunks);
}
async function goldenPackage() {
  const z = new JSZip();
  for (const sub of ['csdb', 'Media']) for (const f of fs.readdirSync(path.join(GOLDEN, sub))) z.file(`${sub}/${f}`, fs.readFileSync(path.join(GOLDEN, sub, f)));
  z.file('publication.xml', fs.readFileSync(path.join(GOLDEN, 'publication.xml')));
  z.file('project.json', fs.readFileSync(path.join(GOLDEN, 'project.json')));
  return z.generateAsync({ type: 'nodebuffer' });
}

test('from a new project to the released PDF, and back to NOT RELEASED after an edit', async ({ browser }) => {
  test.setTimeout(420000);
  const stamp = Date.now();
  const name = `Release flow ${stamp}`;
  const a = await signedIn(browser, 'arjun.das');
  const page = a.page;

  // 1. A new project from a package.
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  const nd = page.getByRole('dialog', { name: 'New project' });
  await nd.getByRole('radio', { name: /From a package/ }).check();
  await nd.getByLabel('Choose the source package').setInputFiles({ name: 'golden.zip', mimeType: 'application/zip', buffer: await goldenPackage() });
  await nd.getByLabel('Project name').fill(name);
  await nd.getByRole('button', { name: 'Create project' }).click();
  await expect(nd).toBeHidden({ timeout: 60000 });
  await expect(page.getByRole('row', { name })).toBeVisible();
  const { call } = authorApi();
  const project = (await call('GET', '/api/projects')).body.projects.find((p) => p.name === name);
  // The Author Panel redesign: opening a project (its name link) goes straight into its focused editor workspace
  // (decisions.md UI5); the Overview dashboard with its tiles is one click away, through the project row's own icon.
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByTestId('tile-dms')).toContainText('9');
  await expect(page.getByTestId('tile-release')).toContainText('Not released');

  // 2. Validate and build: stamped NOT RELEASED.
  await page.getByRole('tab', { name: 'Publication & PDF' }).click();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('No errors')).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: 'Build PDF' }).click();
  await expect(page.getByTestId('last-marking')).toContainText('NOT RELEASED', { timeout: 120000 });
  await expect(page.getByTestId('release-state')).toContainText('NOT RELEASED');
  let [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF' }).click()]);
  let text = await pdfText(await readDownload(dl));
  expect(text).toContain('NOT RELEASED');

  // 3. Submit to the Project Manager.
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  const sd = page.getByRole('dialog', { name: 'Submit for approval' });
  await sd.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByTestId('current-request')).toContainText('Pending approval', { timeout: 120000 });

  // Outsiders cannot approve it or download it, even directly.
  const ravi = await freshApi('ravi.k');
  expect([403, 404]).toContain((await ravi.call('GET', `/api/projects/${project.id}/output.pdf?download=1`)).status);
  const req = (await call('GET', `/api/projects/${project.id}/requests`)).body.requests[0];
  expect([403, 404]).toContain((await ravi.call('POST', `/api/requests/${req.id}/decision`, { outcome: 'approve', comment: 'no' })).status);
  expect([403, 404]).toContain((await call('POST', `/api/requests/${req.id}/decision`, { outcome: 'approve', comment: 'self' })).status);

  // 4. The manager approves it in the review.
  const m = await signedIn(browser, 'priya.rao');
  await m.page.goto('/approvals');
  await m.page.getByRole('row', { name: new RegExp(name) }).getByRole('link').click();
  await m.page.getByRole('radio', { name: /^Approve/ }).check();
  await m.page.getByLabel(/^Comment/).fill('Approved for issue.');
  await m.page.getByRole('button', { name: 'Record decision' }).click();
  await expect(m.page.getByTestId('decision-closed')).toContainText('Approved by Priya Rao');
  await m.ctx.close();

  // 5. The old PDF is refused; a rebuild is Release 1 and downloads.
  await page.reload();
  await page.getByRole('tab', { name: 'Publication & PDF' }).click();
  await expect(page.getByTestId('release-state')).toContainText('Release 1');
  await expect(page.getByText('The PDF on the server is out of date')).toBeVisible();
  await page.getByRole('button', { name: 'Download PDF' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Not downloaded' })).toContainText('approved since');
  await page.getByRole('button', { name: 'Build PDF' }).click();
  await expect(page.getByText('The PDF on the server is out of date')).toBeHidden({ timeout: 120000 });
  [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF' }).click()]);
  text = await pdfText(await readDownload(dl));
  expect(text).toContain('Release 1');
  expect(text).not.toContain('NOT RELEASED');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByTestId('tile-release')).toContainText('Release 1');

  // 6. An edit after the release: NOT RELEASED again, the released PDF refused.
  const dm = (await call('GET', `/api/projects/${project.id}/dms`)).body.modules[0];
  const g = await call('GET', `/api/projects/${project.id}/dms/${dm.id}`);
  expect((await call('PUT', `/api/projects/${project.id}/dms/${dm.id}`, { xml: g.body.xml.replace('</dmodule>', '\n</dmodule>'), baseRevision: g.body.revision })).status).toBe(200);
  await page.reload();
  await expect(page.getByTestId('tile-release')).toContainText('Not released');
  await expect(page.getByTestId('tile-release')).toContainText('changed since approval');
  const direct = await page.request.get(`/api/projects/${project.id}/output.pdf?download=1`);
  expect(direct.status()).toBe(409);
  expect((await direct.json()).code).toBe('PDF_OUT_OF_DATE');
  expect(page.errors).toEqual([]);
  await a.ctx.close();
});
