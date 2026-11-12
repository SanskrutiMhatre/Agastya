'use strict';
// The Author's checkpoint 2b workflow through the real UI: autosaved draft and
// restore, inline preview with live progress, the publication builder (add,
// drag, move, rename, remove, undo, save), the PDF build with live progress
// and inline viewer, submit for approval, withdraw, and the dashboards.
const { test, expect, run, signedIn, shots, authorApi, xmlView, appendXml, expectXml } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

test('editor: unsaved work is autosaved as a draft and can be restored after a reload', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.projectId}?tab=dms`);
  await page.getByRole('link', { name: 'AGS-A-24-10-00-00A-520A-D' }).click();
  await xmlView(page);
  await appendXml(page, '\n<!-- reviewed in e2e -->');
  await expect(page.getByTestId('editor-status')).toContainText('draft autosaved', { timeout: 10000 });
  page.on('dialog', (d) => d.accept()); // the "leave the page?" prompt for unsaved work
  await page.reload();
  await expect(page.getByText('You have an unsaved draft of this module')).toBeVisible();
  await shots(page, '20-editor-draft-banner', { fullPage: false });
  await page.getByRole('button', { name: 'Restore draft' }).click();
  await expectXml(page, /reviewed in e2e/);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('A new revision was recorded.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('You have an unsaved draft of this module')).toHaveCount(0);
  await expectXml(page, /reviewed in e2e/);
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('editor: the preview builds with live progress and is shown in the page', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.projectId}?tab=dms`);
  await page.getByRole('link', { name: 'AGS-A-24-10-00-00A-520A-D' }).click();
  await expect(page.getByRole('radio', { name: 'Design' })).toBeVisible();
  const pdfResponse = page.waitForResponse((res) => res.url().includes('/preview.pdf'), { timeout: 120000 });
  await page.getByRole('button', { name: 'Preview PDF' }).click();
  await expect(page.locator('iframe[title="Preview of DMC-AGS-A-24-10-00-00A-520A-D"]')).toBeVisible({ timeout: 120000 });
  const res = await pdfResponse;
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect((await (await page.request.get(res.url())).body()).subarray(0, 5).toString()).toBe('%PDF-');
  expect(await page.getByTestId('build-log').locator('li').count()).toBeGreaterThan(2);
  await expect(page.getByText('Building the preview')).toBeVisible();
  await shots(page, '21-editor-preview');
  await ctx.close();
});

test('builder: add a chapter, add a module from the pool, drag, move, undo, rename, save, remove', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.projectId}?tab=publication`);
  const counts = page.getByTestId('pm-counts');
  await expect(counts).toHaveText(/^8 modules · 3 chapters/);
  await shots(page, '22-builder');

  // Drag the first chapter below the last one, then undo.
  await page.getByTestId('pm-row-0').dragTo(page.getByTestId('pm-row-2'), { targetPosition: { x: 40, y: 2 } });
  await expect(counts).toContainText('unsaved');
  await expect(page.getByTestId('pm-row-1')).toContainText('General');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('pm-row-0')).toContainText('General');

  // A new chapter with the unplaced BREX module in it.
  await page.getByRole('button', { name: 'Add chapter' }).click();
  const prompt = page.getByRole('dialog', { name: 'Add a chapter' });
  await prompt.getByLabel('Title').fill('Annex');
  await prompt.getByRole('button', { name: 'Add chapter' }).click();
  await expect(page.getByTestId('pm-row-3')).toContainText('Annex');
  await page.getByRole('button', { name: /Add AGS-A-00-00-00-00A-022A-D to the publication/ }).click();
  await expect(counts).toHaveText(/^9 modules · 4 chapters/);
  await page.getByRole('button', { name: 'Move up' }).click();
  await expect(page.getByTestId('pm-row-2')).toContainText('Annex');
  await page.getByRole('button', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename' });
  await rename.getByLabel('Title').fill('Annex A');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByTestId('pm-row-2')).toContainText('Annex A');
  await page.getByRole('button', { name: 'Save publication' }).click();
  await expect(page.getByText('Publication saved', { exact: true })).toBeVisible();
  await expect(counts).toHaveText(/^9 modules · 4 chapters$/);
  await shots(page, '23-builder-saved');

  // Remove it again so the publication is the golden one.
  await page.getByTestId('pm-row-2').click();
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Save publication' }).click();
  await expect(counts).toHaveText(/^8 modules · 3 chapters$/);
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('PDF: the build streams its progress and the PDF opens in the page', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.projectId}?tab=publication`);
  const pdfResponse = page.waitForResponse((res) => res.url().includes('/output.pdf'), { timeout: 150000 });
  await page.getByRole('button', { name: 'Build PDF' }).click();
  await expect(page.getByTestId('build-log')).toBeVisible({ timeout: 30000 });
  // Headless Chromium has no PDF viewer, so the frame stays blank: check what it was sent instead.
  const res = await pdfResponse;
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect(res.headers()['x-frame-options']).toBe('SAMEORIGIN');
  expect((await (await page.request.get(res.url())).body()).subarray(0, 5).toString()).toBe('%PDF-');
  await expect(page.locator('iframe[title="Publication PDF"]')).toBeVisible({ timeout: 150000 });
  await expect(page.getByTestId('last-build')).toContainText('Last build succeeded');
  expect(await page.getByTestId('build-log').locator('li').count()).toBeGreaterThan(3);
  await shots(page, '24-publication-pdf');
  await ctx.close();
});

test('approval: a publication with validation errors is refused, with each error listed under its module', async ({ browser }) => {
  const r = run();
  const { call } = authorApi();
  const mods = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules;
  const dm = mods.find((m) => m.dmc.endsWith('030A-D'));
  const g = (await call('GET', `/api/projects/${r.projectId}/dms/${dm.id}`)).body;
  const broken = await call('PUT', `/api/projects/${r.projectId}/dms/${dm.id}`, { xml: g.xml.replace('<description>', '<description><bogusElement/>'), baseRevision: g.revision });
  expect(broken.status).toBe(200);

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.projectId}?tab=publication`);
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit for approval' });
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(dialog.getByText('Not submitted: validation failed')).toBeVisible({ timeout: 60000 });
  const list = dialog.getByTestId('submit-errors');
  await expect(list.getByRole('link', { name: /Technical data DMC-AGS-A-24-00-00-00A-030A-D/ })).toBeVisible();
  await expect(list).toContainText('bogusElement');
  await shots(page, '29-submit-refused', { fullPage: false });
  await list.getByRole('link', { name: /Technical data/ }).click();
  await expect(page.getByTestId('model-problems')).toContainText('<bogusElement> is not allowed here');
  await ctx.close();

  const g2 = (await call('GET', `/api/projects/${r.projectId}/dms/${dm.id}`)).body;
  expect((await call('PUT', `/api/projects/${r.projectId}/dms/${dm.id}`, { xml: g2.xml.replace('<bogusElement/>', ''), baseRevision: g2.revision })).status).toBe(200);
});

test('approval: submit to the default manager, withdraw, submit again; the dashboard follows', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.projectId}?tab=publication`);
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit for approval' });
  await expect(dialog.getByLabel('Send to')).toHaveValue(r.accounts['priya.rao'].id);
  await dialog.getByLabel('Note for the reviewer').fill('First issue for review.');
  await shots(page, '25-submit-dialog', { fullPage: false });
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByTestId('current-request')).toContainText('Pending approval', { timeout: 150000 });
  await expect(page.getByTestId('current-request')).toContainText('Priya Rao');
  await shots(page, '26-request-pending');

  await page.getByRole('button', { name: 'Withdraw' }).click();
  await page.getByRole('dialog', { name: 'Withdraw the request?' }).getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByTestId('current-request')).toContainText('Withdrawn');

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.getByRole('dialog', { name: 'Submit for approval' }).getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByTestId('current-request')).toContainText('Pending approval', { timeout: 150000 });

  await page.goto('/');
  await expect(page.getByTestId('dashboard-requests')).toContainText('Pending approval');
  await shots(page, '27-author-dashboard');
  await page.goto('/publications');
  await expect(page.getByText('PDU-200 Manual')).toBeVisible();
  await expect(page.getByText('Pending approval').first()).toBeVisible();
  await shots(page, '28-publications');
  expect(page.errors).toEqual([]);
  await ctx.close();
});
