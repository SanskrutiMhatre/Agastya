'use strict';
// Formats, settings and the graphics module in the browser (Phases 7 and 8,
// decisions.md FM1-FM6, ST1-ST7, GR1-GR6), by mouse and keyboard: a JSS
// project has no data module tab and its book is edited, saved and reopened;
// settings are saved and still there after a reload; a page size is chosen;
// an S1000D project is converted to a JSS book with its report; ICNs,
// symbols and parts each have their view, and a part is added through the
// dialog. No screenshots are taken.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, run, signedIn, authorApi, shots } = require('./fixtures');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');

async function newProject(call, name, format = 's1000d') {
  const r = await call('POST', '/api/projects', { name, format });
  expect(r.status).toBe(201);
  return r.body.project;
}

test('a JSS project: no data modules; the book is edited, saved and reopened; its identity is a setting', async ({ browser }) => {
  const stamp = Date.now();
  const { call } = authorApi();
  const p = await newProject(call, `Book ${stamp}`, 'jss');
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${p.id}`);
  await expect(page.getByRole('tab', { name: 'Data modules' })).toHaveCount(0);
  await expect(page.getByTestId('tile-dms')).toContainText('JSS');
  await page.getByRole('tab', { name: 'Book & PDF' }).click();
  await expect(page.getByRole('tab', { name: 'Builder' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'XML', exact: true }).click();
  const area = page.getByLabel('Publication module XML');
  await expect(area).toHaveValue(/<jssbook>/);
  const before = await area.inputValue();
  const edited = before.replace('<para>Text.</para>', '<para>The pump delivers 40 litres a minute.</para>');
  await area.fill(edited);
  await page.getByRole('button', { name: 'Save publication module' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Book & PDF' }).click();
  await page.getByRole('radio', { name: 'XML', exact: true }).click();
  await expect(page.getByLabel('Publication module XML')).toHaveValue(edited);
  // Not a book any more: refused, nothing saved.
  await page.getByLabel('Publication module XML').fill('<pm/>');
  await page.getByRole('button', { name: 'Save publication module' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'jssbook' })).toBeVisible();

  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByTestId('settings-publishers')).toHaveCount(0);
  await expect(page.getByTestId('settings-pipeline')).toHaveCount(0);
  const id = page.getByTestId('settings-identity');
  await id.getByLabel('Book name').fill('Pump manual');
  await id.getByLabel('Publication number').fill(`PM-${stamp}`);
  await id.getByLabel('Document type (JSS0251)').selectOption('DS');
  await id.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved').first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('settings-identity').getByLabel('Publication number')).toHaveValue(`PM-${stamp}`);
  await expect(page.getByTestId('settings-identity').getByLabel('Document type (JSS0251)')).toHaveValue('DS');
  const book = (await call('GET', `/api/projects/${p.id}/publication`)).body.xml;
  expect(book).toContain(`<publicationNo>PM-${stamp}</publicationNo>`);
  expect(book).toContain('The pump delivers 40 litres a minute.');
  expect(book).toContain('<documentTypeHeader>Design Specification</documentTypeHeader>');
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('S1000D settings persist; a page size is chosen; a bad margin is refused; the project converts to a JSS book', async ({ browser }) => {
  test.setTimeout(240000);
  const stamp = Date.now();
  const { call } = authorApi();
  const p = await newProject(call, `Settings ${stamp}`);
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb')).filter((x) => x.endsWith('.xml'))) {
    await call('POST', `/api/projects/${p.id}/dms/import`, { filename: f, content: fs.readFileSync(path.join(GOLDEN, 'csdb', f), 'utf8') });
  }
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${p.id}?tab=settings`);
  const pg = page.getByTestId('settings-page');
  await pg.getByLabel('Page size').selectOption('A4 landscape');
  await pg.getByLabel('Body font').selectOption('Times');
  await pg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved').first()).toBeVisible();
  await pg.getByLabel('Inner margin').fill('-4mm');
  await pg.getByRole('button', { name: 'Save' }).click();
  await expect(pg.getByRole('alert')).toContainText('marginInner');
  await page.reload();
  await expect(page.getByTestId('settings-page').getByLabel('Page size')).toHaveValue('A4 landscape');
  await expect(page.getByTestId('settings-page').getByLabel('Body font')).toHaveValue('Times');
  const wm = page.getByTestId('settings-watermark');
  await expect(wm).toContainText('NOT RELEASED');
  await wm.getByLabel('Watermark released publications').check();
  await wm.getByLabel('Text').fill('CONTROLLED COPY');
  await wm.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved').first()).toBeVisible();
  await shots(page, 'settings');

  const conv = page.getByTestId('settings-convert');
  await conv.getByLabel('New project name').fill(`Settings book ${stamp}`);
  await conv.getByRole('button', { name: 'Convert' }).click();
  const report = page.getByTestId('conversion-report');
  await expect(report).toContainText(`Settings book ${stamp} created`, { timeout: 180000 });
  await expect(report).toContainText('9 modules');
  await report.getByRole('button', { name: `Open Settings book ${stamp}` }).click();
  await expect(page.getByRole('heading', { name: `Settings book ${stamp}` })).toBeVisible();
  // The dashboard's banner (the project description says it too).
  await expect(page.getByRole('status').filter({ hasText: `Converted from Settings ${stamp}` })).toContainText('kept under source/');
  await expect(page.getByRole('tab', { name: 'Data modules' })).toHaveCount(0);
  // The source is unchanged and still S1000D.
  expect((await call('GET', `/api/projects/${p.id}`)).body.project.format).toBe('s1000d');
  expect((await call('GET', `/api/projects/${p.id}/dms`)).body.modules).toHaveLength(9);
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('graphics: ICNs, symbols and parts views; a part added through the dialog; a Project Manager only reads', async ({ browser }) => {
  const stamp = Date.now();
  const { r, call } = authorApi();
  const ipd = await call('POST', `/api/projects/${r.projectId}/dms`, { dmc: { modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '24', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: String(stamp % 90 + 10), disassyCodeVariant: 'A', infoCode: '941', infoCodeVariant: 'A', itemLocationCode: 'D' }, techName: 'PDU parts', infoName: 'Illustrated parts data', schemaType: 'ipd' });
  expect(ipd.status).toBe(201);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.projectId}?tab=graphics`);
  await expect(page.getByTestId('assets-summary')).toContainText('ICNs');
  await expect(page.getByText('ICN-AGS-A-240000-A-0AGS1-00001-A-01-1').first()).toBeVisible();
  await page.getByRole('tab', { name: /^Symbols/ }).click();
  await expect(page.getByRole('table', { name: 'Symbols' })).toBeVisible();
  await page.getByRole('tab', { name: /^Parts/ }).click();
  await page.getByRole('button', { name: 'Add part' }).click();
  const d = page.getByRole('dialog', { name: 'Add a part' });
  await d.getByLabel('Parts data module').selectOption({ label: ipd.body.module.dmc });
  await d.getByLabel('Part number').fill(`PSU-${stamp % 10000}`);
  await d.getByLabel(/^Manufacturer code/).fill('K0001');
  await d.getByLabel('Description').fill('Power supply module');
  await d.getByLabel(/^Item/).fill('010');
  await d.getByLabel(/^Item/).press('Enter');
  await expect(d).toBeHidden();
  const row = page.getByRole('row', { name: new RegExp(`PSU-${stamp % 10000}`) });
  await expect(row).toContainText('Power supply module');
  await expect(row).toContainText(`${ipd.body.module.dmc} fig 01 item 010`);
  const v = await call('POST', `/api/projects/${r.projectId}/dms/${ipd.body.module.id}/validate`, {});
  expect(v.body.valid).toBe(true);
  await ctx.close();

  const m = await signedIn(browser, 'priya.rao');
  await m.page.goto(`/projects/${run().managedId}?tab=graphics`);
  await expect(m.page.getByTestId('assets-summary')).toBeVisible();
  await expect(m.page.getByRole('button', { name: 'Upload graphic' })).toHaveCount(0);
  await m.page.getByRole('tab', { name: /^Parts/ }).click();
  await expect(m.page.getByRole('button', { name: 'Add part' })).toHaveCount(0);
  await m.ctx.close();
});
