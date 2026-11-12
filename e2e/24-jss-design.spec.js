'use strict';
// The JSS book Design view (decisions.md ST9): editing chapters, sections,
// a formatted paragraph, a list and a table without touching XML - saved,
// reloaded, and visible both in the XML view and in the built PDF.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, expect, signedIn, authorApi } = require('./fixtures');

async function pdfText(buf) {
  const fs = require('node:fs');
  const { extractPdfText } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'pdf-text.mjs')).href);
  const f = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'agastya-e2e-pdf-')), 'p.pdf');
  fs.writeFileSync(f, buf);
  return (await extractPdfText(f)).pages.join('\n');
}

async function addBlock(page, kind) {
  const add = page.getByRole('button', { name: 'Add', exact: true }).first();
  await add.click();
  const item = page.getByRole('button', { name: kind, exact: true });
  await expect(item).toBeVisible();
  await item.click();
}

test('a chapter built in the Design view: title, a bold paragraph, a list and a table', async ({ browser }) => {
  test.setTimeout(120000);
  const stamp = Date.now();
  const { call } = authorApi();
  const project = (await call('POST', '/api/projects', { name: `Design book ${stamp}`, format: 'jss' })).body.project;

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${project.id}?tab=publication`);
  await expect(page.getByRole('radio', { name: 'Design', exact: true })).toHaveAttribute('aria-checked', 'true');

  // The skeleton's own chapter and section, retitled.
  await page.getByLabel('Chapter title').fill(`Chapter ${stamp}`);
  await page.getByLabel('Section title').fill('Scope');

  // The skeleton's own paragraph, replaced with bold text in the middle.
  const para = page.getByTestId('para-editor');
  await para.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('This system is ');
  await page.getByTitle('bold', { exact: true }).click();
  await page.keyboard.type('mandatory');
  await page.getByTitle('bold', { exact: true }).click();
  await page.keyboard.type(' reading.');
  await page.getByLabel('Section title').click(); // blur the paragraph so it commits

  // A numbered list, in the section.
  await addBlock(page, 'List');
  await page.getByRole('checkbox', { name: 'Numbered' }).click();
  await page.getByTestId('list-item').first().fill('Read this first.');

  // A table, also in the section.
  await addBlock(page, 'Table');
  await page.getByLabel('Header 1').fill('Part');
  await page.getByLabel('Header 2').fill('Qty');
  await page.getByLabel('Row 1 cell 1').fill('Bolt');
  await page.getByLabel('Row 1 cell 2').fill('4');

  await page.getByRole('button', { name: /^Save publication module$/ }).click();
  await expect(page.getByText('Publication module saved').first()).toBeVisible();

  // The XML view shows exactly what was built, after a reload.
  await page.reload();
  await page.getByRole('radio', { name: 'XML', exact: true }).click();
  const xml = await page.getByLabel('Publication module XML').inputValue();
  expect(xml).toContain(`<title>Chapter ${stamp}</title>`);
  expect(xml).toContain('<title>Scope</title>');
  expect(xml).toMatch(/This system is <b>mandatory<\/b> reading\./);
  expect(xml).toContain('<list type="number"><item>Read this first.</item></list>');
  expect(xml).toContain('<cell><para>Bolt</para></cell>');

  // It is still a valid JSS book, and builds.
  const build = await page.request.post(`/api/projects/${project.id}/build`);
  expect(build.ok()).toBe(true);
  const pdfRes = await page.request.get(`/api/projects/${project.id}/output.pdf`);
  const text = (await pdfText(await pdfRes.body())).replace(/\s+/g, ' ');
  expect(text).toMatch(new RegExp(`Chapter ${stamp}`));
  expect(text).toMatch(/Scope/);
  expect(text).toMatch(/This system is mandatory reading\./);
  expect(text).toMatch(/Read this first\./);
  expect(text).toMatch(/Bolt/);

  expect(page.errors).toEqual([]);
  await ctx.close();
});
