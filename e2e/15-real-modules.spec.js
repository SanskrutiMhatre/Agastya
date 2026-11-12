'use strict';
// Real S1000D modules through the real UI (decisions.md PV35). Opt-in: set
// AGASTYA_REAL_MODULES to a folder of .xml data modules (copies; the folder is
// only read). Not run otherwise, so no customer content is kept in the
// repository. For every module: imported through the Import XML dialog and
// stored byte for byte; opened in Design with no page error; a typed edit
// saved as exactly that edit; reopened; validated with the button (no new
// errors); its PDF built with the button. Then a table and a procedure are
// edited further. Run on its own:
//   AGASTYA_REAL_MODULES=/path/to/xml npx playwright test e2e/15-real-modules.spec.js
const fs = require('fs');
const path = require('path');
const { test, expect, signedIn, authorApi } = require('./fixtures');

const DIR = process.env.AGASTYA_REAL_MODULES || '';
const FILES = DIR && fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /\.xml$/i.test(f)).sort() : [];

test.describe.configure({ mode: 'serial' });
test.skip(!FILES.length, 'set AGASTYA_REAL_MODULES to a folder of real data modules to run this spec');
test.setTimeout(1800000);

const api = () => authorApi();
let project;
const modules = async () => (await api().call('GET', `/api/projects/${project}/dms`)).body.modules;
const moduleXml = async (id) => (await api().call('GET', `/api/projects/${project}/dms/${id}`)).body;
async function errorsOf(id, xml) {
  const v = await api().call('POST', `/api/projects/${project}/dms/${id}/validate`, { xml });
  return v.body.findings.filter((f) => f.sev === 'error').map((f) => `${f.kind}: ${f.message}`);
}
const view = (p) => p.getByTestId('page-view');
const fileOf = (dmc) => FILES.find((f) => f.includes(dmc));
async function saveKeys(page) {
  const put = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/dms\/[0-9a-f-]+$/.test(new URL(r.url()).pathname));
  await page.keyboard.press('Control+s');
  expect((await put).status()).toBe(200);
}
async function validateAndPdf(page, m, original) {
  const vr = page.waitForResponse((r) => r.request().method() === 'POST' && /\/validate$/.test(new URL(r.url()).pathname));
  await page.getByRole('button', { name: 'Validate' }).click();
  const now = (await (await vr).json()).findings.filter((f) => f.sev === 'error').map((f) => `${f.kind}: ${f.message}`);
  const before = await errorsOf(m.id, original);
  expect(now.filter((f) => !before.includes(f)), `${m.dmc}: no new validation errors`).toEqual([]);
  const pr = page.waitForResponse((r) => /\/preview$/.test(new URL(r.url()).pathname), { timeout: 300000 });
  await page.getByRole('button', { name: 'Preview PDF' }).click();
  const p = await pr;
  expect(p.status(), `${m.dmc}: PDF`).toBe(200);
  expect(p.headers()['content-type']).toBe('application/pdf');
}

test.beforeAll(async () => {
  const r = await api().call('POST', '/api/projects', { name: 'Real modules', description: 'Real S1000D data modules (copies).' });
  expect(r.status).toBe(201);
  project = r.body.project.id;
});

test('every real module: imported intact, edited, saved as only that edit, reopened, validated, built to PDF', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`/projects/${project}?tab=dms`);
  await page.getByRole('button', { name: 'Import XML' }).click();
  const dlg = page.getByRole('dialog', { name: 'Import XML data modules' });
  await dlg.locator('input[type="file"]').setInputFiles(FILES.map((f) => path.join(DIR, f)));
  await expect(dlg).toContainText(`${FILES.length} of ${FILES.length} imported`, { timeout: 300000 });
  await dlg.getByRole('button', { name: 'Done' }).click();
  const mods = await modules();
  expect(mods.length).toBe(FILES.length);
  for (const m of mods) {
    const original = fs.readFileSync(path.join(DIR, fileOf(m.dmc)), 'utf8');
    const g = await moduleXml(m.id);
    expect(g.xml, `${m.dmc}: stored byte for byte`).toBe(original);
    errs.length = 0;
    await page.goto(`/projects/${project}/dms/${m.id}`);
    await expect(view(page)).toBeVisible();
    await expect(page.getByText('The XML cannot be shown as a page')).toHaveCount(0);
    await expect(view(page).getByText('<symbol>', { exact: true })).toHaveCount(0);
    let run = view(page).locator('[data-element="para"] [data-run], [data-element="notePara"] [data-run]').filter({ hasText: /\S/ }).first();
    if (!(await run.count())) run = view(page).locator('[data-element="levelledPara"] [data-run], figure [data-run]').filter({ hasText: /\S/ }).first();
    await run.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' EDITED');
    await saveKeys(page);
    const after = (await moduleXml(m.id)).xml;
    expect(after.includes(' EDITED') && after.replace(' EDITED', '') === original, `${m.dmc}: only the typed edit changed`).toBe(true);
    await page.reload();
    await expect(view(page)).toBeVisible();
    expect((await view(page).getByRole('textbox').allTextContents()).some((t) => t.includes(' EDITED')), `${m.dmc}: reopened`).toBe(true);
    await validateAndPdf(page, m, original);
    expect(errs, `${m.dmc}: no page errors`).toEqual([]);
  }
  await ctx.close();
});

test('a real table and a real procedure, edited further', async ({ browser }) => {
  const mods = await modules();
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  page.on('dialog', (d) => d.accept());
  const xmlOf = (m) => fs.readFileSync(path.join(DIR, fileOf(m.dmc)), 'utf8');
  const table = mods.find((m) => /<tbody>/.test(xmlOf(m)));
  if (table) {
    const original = (await moduleXml(table.id)).xml;
    await page.goto(`/projects/${project}/dms/${table.id}`);
    await view(page).locator('table').first().locator('tbody td').first().click();
    await page.getByTestId('tbl-row-below').click();
    await page.keyboard.type('Real row');
    await page.keyboard.press('Tab');
    await page.keyboard.type('next');
    await saveKeys(page);
    const x = (await moduleXml(table.id)).xml;
    expect(x).toContain('<para>Real row</para>');
    expect(x.slice(0, x.indexOf('<content>'))).toBe(original.slice(0, original.indexOf('<content>')));
    await page.reload();
    await validateAndPdf(page, table, original);
  }
  const proc = mods.find((m) => m.schemaType === 'proced');
  if (proc) {
    const original = (await moduleXml(proc.id)).xml;
    await page.goto(`/projects/${project}/dms/${proc.id}`);
    await view(page).locator('[data-element="proceduralStep"] [data-run]').filter({ hasText: /\S/ }).last().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Alt+S');
    await page.keyboard.type('A new step.');
    await saveKeys(page);
    expect((await moduleXml(proc.id)).xml).toContain('A new step.');
    await page.reload();
    await validateAndPdf(page, proc, original);
  }
  await ctx.close();
});
