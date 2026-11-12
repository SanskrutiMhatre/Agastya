'use strict';
// CSDB packages in the browser (Phase 6, decisions.md CX1 to CX6): the
// Author exports a project, checks the package against a new project, imports
// it, opens a module and builds its preview with the artwork that came with
// it; a second import replaces nothing; a file that is not a zip is refused;
// a Project Manager may export but not import. No screenshots are taken.
const { test, expect, run, signedIn, authorApi, shots } = require('./fixtures');

async function readDownload(download) {
  const chunks = [];
  for await (const c of await download.createReadStream()) chunks.push(c);
  return Buffer.concat(chunks);
}

test('export a project and import it into a new one, then build a module with its artwork', async ({ browser }) => {
  test.setTimeout(240000);
  const { r, call } = authorApi();
  const live = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules.length;
  const copy = (await call('POST', '/api/projects', { name: `Package copy ${Date.now()}` })).body.project;

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.projectId}?tab=dms`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export package' }).click()]);
  expect(download.suggestedFilename()).toBe('CSDB-PDU-200_Manual.zip');
  const zip = await readDownload(download);
  expect(zip.subarray(0, 2).toString()).toBe('PK');

  await page.goto(`/projects/${copy.id}?tab=dms`);
  await page.getByRole('button', { name: 'Import package' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import a CSDB package' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Choose CSDB package').setInputFiles({ name: 'CSDB-PDU-200_Manual.zip', mimeType: 'application/zip', buffer: zip });
  await expect(dialog.getByTestId('package-summary')).toContainText(`${live} data modules and 1 graphic to import`, { timeout: 60000 });
  await expect(dialog.getByTestId('package-summary')).toContainText('exported from PDU-200 Manual');
  const plan = dialog.getByTestId('package-plan');
  await expect(plan.locator('tr[data-status="import"]')).toHaveCount(live + 1);
  await expect(plan.locator('tr', { hasText: 'publication.xml' })).toContainText('ignored');
  await expect(plan.locator('tr', { hasText: 'emblem.png' })).toContainText('Not named as an ICN');
  await shots(page, 'package preview');
  // Nothing written by the check.
  expect((await call('GET', `/api/projects/${copy.id}/dms`)).body.modules).toHaveLength(0);

  await dialog.getByRole('button', { name: `Import ${live + 1} files` }).click();
  await expect(dialog.getByText(`${live} data modules and 1 graphic imported`)).toBeVisible({ timeout: 60000 });
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('link', { name: 'AGS-A-24-00-00-00A-040A-D' })).toBeVisible();

  // Open the module with the figure: its artwork is there, in the page and in the PDF.
  await page.getByRole('link', { name: 'AGS-A-24-00-00-00A-040A-D' }).click();
  await expect(page.getByTestId('page-view')).toBeVisible();
  await expect(page.getByTestId('page-view').locator('img').first()).toBeVisible();
  const built = page.waitForResponse((res) => res.request().method() === 'POST' && /\/preview$/.test(new URL(res.url()).pathname), { timeout: 180000 });
  await page.getByRole('button', { name: 'Preview PDF' }).click();
  expect((await built).status()).toBe(200);
  await expect(page.locator('iframe[title="Preview of DMC-AGS-A-24-00-00-00A-040A-D"]')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('build-log')).toBeVisible();
  await expect(page.getByTestId('build-log')).not.toContainText('artwork not available');

  // The same package again: everything is already there, and the import button stays off.
  await page.goto(`/projects/${copy.id}?tab=dms`);
  await page.getByRole('button', { name: 'Import package' }).click();
  await dialog.getByLabel('Choose CSDB package').setInputFiles({ name: 'again.zip', mimeType: 'application/zip', buffer: zip });
  await expect(dialog.getByTestId('package-summary')).toContainText('0 data modules and 0 graphics to import', { timeout: 60000 });
  await expect(dialog.getByRole('button', { name: /^Import/ })).toBeDisabled();

  // Not a zip: refused, and said so.
  await dialog.getByLabel('Choose CSDB package').setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  await expect(dialog.getByRole('alert')).toContainText('could not be read as a zip package');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('a Project Manager can export a project they own but has no import', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto(`/projects/${run().managedId}?tab=dms`);
  await expect(page.getByRole('button', { name: 'Export package' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import package' })).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export package' }).click()]);
  expect(download.suggestedFilename()).toBe('CSDB-Managed_manual.zip');
  expect(page.errors).toEqual([]);
  await ctx.close();
});
