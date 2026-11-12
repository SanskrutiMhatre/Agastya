'use strict';
// Standalone author tools, by mouse and keyboard: the DMC creator (a DMRL
// spreadsheet to a downloadable zip of shells, no project needed) and the
// Converter (a package upload through to an editable JSS project in one
// page), and the global sidebar collapsing while a project is open.
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const { test, expect, signedIn, authorApi } = require('./fixtures');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');

async function goldenPackage() {
  const z = new JSZip();
  for (const sub of ['csdb', 'Media']) for (const f of fs.readdirSync(path.join(GOLDEN, sub))) z.file(`${sub}/${f}`, fs.readFileSync(path.join(GOLDEN, sub, f)));
  z.file('publication.xml', fs.readFileSync(path.join(GOLDEN, 'publication.xml')));
  z.file('project.json', fs.readFileSync(path.join(GOLDEN, 'project.json')));
  return z.generateAsync({ type: 'nodebuffer' });
}

async function dmrlSheet() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('DMRL');
  ws.addRow(['', 'DMC', '', '', '', '', '', '', '', '', '', '', 'Technical Name', 'Information Name', '', '']);
  ws.addRow(['dmc', 'ModelIC', 'SDC', 'System', 'SubSystem', 'SubSubSys', 'Assembly', 'DisCode', 'DisCodV', 'Infocode', 'InfoCodeV', 'ItemLoCode', 'TechName', 'InfoName', 'status', 'Allocated']);
  ws.addRow(['', 'AGS', 'A', '24', '2', '0', '00', '00', 'A', '520', 'A', 'D', 'Fan', 'Remove procedure', '', '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('DMC creator: typed-in rows become a downloadable zip, with no project or spreadsheet involved', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/tools/dmc-creator');
  await expect(page.getByRole('heading', { name: 'DMC creator' })).toBeVisible();
  await page.getByPlaceholder('AGS-A-24-00-00-00A-040A-D').fill('AGS-A-24-20-00-00A-520A-D');
  await page.getByPlaceholder('e.g. Cooling fan tray').fill('Fan');
  await page.getByPlaceholder('e.g. Removal procedure').fill('Remove procedure');
  await page.getByText('1 of 1 ready').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Create and download 1 shell/ }).click()]);
  expect(dl.suggestedFilename()).toBe('dmc-shells-1.zip');
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('DMC creator: an existing DMRL spreadsheet still works, as the other direction', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/tools/dmc-creator');
  await page.getByText('Or, read an existing DMRL spreadsheet instead').click();
  await page.getByLabel('Choose DMRL spreadsheet').setInputFiles({ name: 'dmrl.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await dmrlSheet() });
  await expect(page.getByText('AGS-A-24-20-00-00A-520A-D')).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download 1 shell/ }).click()]);
  expect(dl.suggestedFilename()).toBe('dmc-shells.zip');
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('Converter: a package becomes an editable JSS project, in one page', async ({ browser }) => {
  test.setTimeout(120000);
  const stamp = Date.now();
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/tools/converter');
  await expect(page.getByRole('heading', { name: 'Converter' })).toBeVisible();
  await page.getByLabel('Project name').fill(`Tool convert ${stamp}`);
  await page.getByLabel('Choose CSDB package').setInputFiles({ name: 'golden.zip', mimeType: 'application/zip', buffer: await goldenPackage() });
  await page.getByRole('button', { name: 'Convert to JSS' }).click();
  await expect(page.getByTestId('conversion-report')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('conversion-report')).toContainText(`Tool convert ${stamp} (JSS) created`);
  await page.getByRole('button', { name: /Open .* to edit/ }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole('radio', { name: 'Design', exact: true })).toBeVisible();
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('the global sidebar collapses while a project is open, and is full elsewhere', async ({ browser }) => {
  const stamp = Date.now();
  const { call } = authorApi();
  const project = (await call('POST', '/api/projects', { name: `Sidebar collapse ${stamp}` })).body.project;

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Back to the dashboard' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
  await page.goto('/tools/converter');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard' })).toBeVisible();
  expect(page.errors).toEqual([]);
  await ctx.close();
});
