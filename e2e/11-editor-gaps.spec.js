'use strict';
// The editor gaps closed after checkpoint 2d, through the real UI: merging
// and splitting table cells in the page view (schema-valid CALS spans), the
// identification and status section edited in the page view (checked before
// anything changes, the data module code untouched), and the Design view of
// the review screen (the frozen snapshot, read-only, its own artwork). Roles:
// the Author, a Project Manager and the administrator read only, an Author
// outside the project, two tabs. No screenshots are taken.
const { test, expect, run, signedIn, authorApi, apiAs, ensurePending } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

const CODE = 'AGS-A-32-00-00-00A-040B-D';
const BODY = `
        <levelledPara id="par-0001">
          <title>Cells</title>
          <para>Table below.</para>
          <table id="tab-0001">
            <title>Grid</title>
            <tgroup cols="3">
              <colspec colname="c1"/>
              <colspec colname="c2"/>
              <colspec colname="c3"/>
              <thead><row><entry><para>H1</para></entry><entry><para>H2</para></entry><entry><para>H3</para></entry></row></thead>
              <tbody>
                <row><entry><para>A</para></entry><entry><para>B</para></entry><entry><para>C</para></entry></row>
                <row><entry><para>D</para></entry><entry><para>E</para></entry><entry><para>F</para></entry></row>
              </tbody>
            </tgroup>
          </table>
        </levelledPara>
      `;
let moduleId;

const api = () => authorApi();
const getModule = async (code = CODE, project = run().projectId) => {
  const { call } = api();
  const m = (await call('GET', `/api/projects/${project}/dms`)).body.modules.find((x) => x.dmc === code);
  return { m, ...(await call('GET', `/api/projects/${project}/dms/${m.id}`)).body };
};
const savedXml = async (code) => (await getModule(code)).xml;
async function putXml(xml, code = CODE) {
  const { r, call } = api();
  const g = await getModule(code);
  const res = await call('PUT', `/api/projects/${r.projectId}/dms/${g.m.id}`, { xml, baseRevision: g.revision });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
const withBody = (xml, body) => xml.replace(/<description\s*\/>|<description>[\s\S]*?<\/description>/, `<description>${body}</description>`);
async function expectValid(xml) {
  const { r, call } = api();
  const v = await call('POST', `/api/projects/${r.projectId}/dms/${moduleId}/validate`, { xml });
  expect(v.body.findings.filter((f) => f.sev === 'error' && f.kind !== 'brex'), JSON.stringify(v.body.findings)).toEqual([]);
}

async function openDesign(page, code = CODE, project = run().projectId) {
  await page.goto(`/projects/${project}?tab=dms`);
  await page.getByRole('link', { name: code }).click();
  await expect(page.getByRole('radio', { name: 'Design' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('page-view')).toBeVisible();
}
const putDone = (page) => page.waitForResponse((r) => r.request().method() === 'PUT' && /\/dms\/[0-9a-f-]+$/.test(new URL(r.url()).pathname));
async function save(page) {
  const done = putDone(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await done).status()).toBe(200);
}
// A fresh sign-in (the saved session of some accounts is ended by the session scenario of spec 08).
async function fresh(browser, username) {
  const r = run();
  const ctx = await browser.newContext({ baseURL: r.base });
  const page = await ctx.newPage();
  const login = await page.request.post('/api/auth/login', { data: { username, password: r.accounts[username].password }, headers: { origin: r.base } });
  expect(login.status()).toBe(200);
  return { ctx, page, r };
}
const grid = (page) => page.getByTestId('page-view').locator('table').first();
const cell = (page, text) => grid(page).locator('td').filter({ hasText: new RegExp(`^${text}$`) });

test.beforeAll(async () => {
  const { r, call } = api();
  for (const q of (await call('GET', `/api/projects/${r.projectId}/requests`)).body.requests.filter((x) => x.status === 'pending')) await call('POST', `/api/requests/${q.id}/withdraw`, {});
  const mods = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules;
  if (!mods.some((x) => x.dmc === CODE)) {
    const dmc = { modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '32', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: '00', disassyCodeVariant: 'A', infoCode: '040', infoCodeVariant: 'B', itemLocationCode: 'D' };
    expect((await call('POST', `/api/projects/${r.projectId}/dms`, { dmc, techName: 'Cell tray', infoName: 'Description', schemaType: 'descript' })).status).toBe(201);
  }
  const g = await getModule();
  moduleId = g.m.id;
  await putXml(withBody(g.xml, BODY));
  await expectValid(await savedXml(CODE));
});

test('table cells merge right and down, and split back; the saved table stays valid CALS', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  // The last cell of a row has nothing to its right; a cell in the last row nothing below.
  await cell(page, 'C').click();
  await expect(page.getByTestId('tbl-merge-right')).toBeDisabled();
  await expect(page.getByTestId('tbl-split')).toBeDisabled();
  await cell(page, 'A').click();
  await page.getByTestId('tbl-merge-right').click();
  await expect(grid(page).locator('td[colspan="2"]')).toHaveText('AB');
  await save(page);
  let xml = await savedXml(CODE);
  expect(xml).toMatch(/<row><entry namest="c1" nameend="c2"><para>A<\/para><para>B<\/para><\/entry><entry><para>C<\/para><\/entry><\/row>/);
  expect(xml).toContain('<title>Cells</title>');
  await expectValid(xml);

  // C over F: rows span.
  await cell(page, 'C').click();
  await page.getByTestId('tbl-merge-down').click();
  await expect(grid(page).locator('td[rowspan="2"]')).toHaveText('CF');
  // The merged A-B cannot go down onto D and E (it would leave a row half covered).
  await grid(page).locator('td[colspan="2"]').click();
  await expect(page.getByTestId('tbl-merge-down')).toBeDisabled();
  await save(page);
  xml = await savedXml(CODE);
  expect(xml).toMatch(/<entry morerows="1"><para>C<\/para><para>F<\/para><\/entry>/);
  await expectValid(xml);

  // Split both: single cells again, every one in its place.
  await grid(page).locator('td[colspan="2"]').click();
  await page.getByTestId('tbl-split').click();
  await grid(page).locator('td[rowspan="2"]').click();
  await page.getByTestId('tbl-split').click();
  await expect(grid(page).locator('td[colspan], td[rowspan]')).toHaveCount(0);
  await expect(grid(page).locator('tbody tr').nth(0).locator('td')).toHaveCount(3);
  await expect(grid(page).locator('tbody tr').nth(1).locator('td')).toHaveCount(3);
  await save(page);
  xml = await savedXml(CODE);
  expect(xml).not.toMatch(/namest|nameend|morerows/);
  await expectValid(xml);
  await ctx.close();
});

test('identification: wrong values are refused field by field; correct ones change only those values', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  const before = await savedXml(CODE);
  await page.getByTestId('edit-ident').click();
  const dlg = page.getByRole('dialog', { name: 'Identification and status' });
  await expect(dlg).toContainText(`DMC-${CODE}`);
  await dlg.getByLabel('Technical name').fill('');
  await dlg.getByLabel('Issue number').fill('2');
  await dlg.getByLabel('Language').fill('EN');
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await expect(dlg.getByText('The technical name is required.')).toBeVisible();
  await expect(dlg.getByText('Three digits, for example 001.')).toBeVisible();
  await expect(dlg.getByText(/ISO 639 code in lower case/)).toBeVisible();
  // Script-like text is stored as text, never markup.
  await dlg.getByLabel('Technical name').fill('Cell tray <b>&</b>');
  await dlg.getByLabel('Issue number').fill('002');
  await dlg.getByLabel('Language').fill('en');
  await dlg.getByLabel('Information name').fill('');
  await dlg.getByLabel('Issue date').fill('2026-03-04');
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.getByTestId('page-ident')).toContainText('Cell tray <b>&</b>');
  await expect(page.getByTestId('page-ident')).toContainText('Issue 002-');
  await expect(page.getByTestId('page-ident').locator('b')).toHaveCount(0);
  await save(page);
  const xml = await savedXml(CODE);
  expect(xml).toContain('<techName>Cell tray &lt;b&gt;&amp;&lt;/b&gt;</techName>');
  expect(xml).not.toContain('<infoName>');
  // Attributes keep their place in the tag; only their values change.
  expect(xml).toContain('<issueInfo inWork="00" issueNumber="002" />');
  expect(xml).toContain('<issueDate day="04" month="03" year="2026" />');
  // The code and everything outside the changed values are as they were.
  const dmCode = (x) => /<dmCode [^>]*\/>/.exec(x)[0];
  expect(dmCode(xml)).toBe(dmCode(before));
  expect(xml.slice(xml.indexOf('<content>'))).toBe(before.slice(before.indexOf('<content>')));
  await expectValid(xml);
  await ctx.close();
});

test('two tabs: an identification change made in a stale tab is refused, not merged over the newer save', async ({ browser }) => {
  const { ctx, page: tab1 } = await signedIn(browser, 'arjun.das');
  const tab2 = await ctx.newPage();
  for (const p of [tab1, tab2]) await openDesign(p);
  // (After the split above, A and B share the first cell: splitting keeps content, it does not share it out.)
  await cell(tab1, 'D').click();
  await tab1.getByTestId('tbl-merge-right').click();
  await save(tab1);
  await expect(tab2.getByText(/saved a newer version/)).toBeVisible();
  await tab2.getByTestId('edit-ident').click();
  const dlg = tab2.getByRole('dialog', { name: 'Identification and status' });
  await dlg.getByLabel('In work').fill('05');
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await tab2.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(tab2.getByRole('dialog', { name: 'Someone else saved this module' })).toBeVisible();
  const xml = await savedXml(CODE);
  expect(xml).toMatch(/<entry namest="c1" nameend="c2"><para>D<\/para><para>E<\/para><\/entry>/);
  expect(xml).not.toMatch(/inWork="05"/);
  await ctx.close();
});

test('read-only: no cell or identification editing for a Project Manager or the administrator without a session', async ({ browser }) => {
  const r = run();
  const pm = await signedIn(browser, 'priya.rao');
  await openDesign(pm.page, 'AGS-A-24-00-00-00A-040A-D', r.managedId);
  await expect(pm.page.getByTestId('page-ident')).toBeVisible();
  await expect(pm.page.getByTestId('edit-ident')).toHaveCount(0);
  await expect(pm.page.getByTestId('tbl-merge-right')).toHaveCount(0);
  await pm.ctx.close();

  const ad = await signedIn(browser, 'admin');
  await openDesign(ad.page);
  await expect(ad.page.getByTestId('override-offer')).toBeVisible();
  await expect(ad.page.getByTestId('edit-ident')).toHaveCount(0);
  await ad.page.getByTestId('page-view').locator('td').first().click();
  await expect(ad.page.getByTestId('tbl-merge-right')).toHaveCount(0);
  await ad.ctx.close();
});

test('an Author who is not on the project cannot change the module through the API', async ({ browser }) => {
  const { ctx, page, r } = await fresh(browser, 'ravi.k');
  const before = await savedXml(CODE);
  const res = await page.request.put(`/api/projects/${r.projectId}/dms/${moduleId}`, { data: { xml: before.replace(/<techName>[^<]*/, '<techName>Taken over'), baseRevision: 1 }, headers: { origin: r.base } });
  expect(res.status()).toBe(404);
  expect(await savedXml(CODE)).toBe(before);
  await ctx.close();
});

test('review Design view: the frozen snapshot as a page, its own artwork, read-only; others are refused', async ({ browser }) => {
  const req = await ensurePending();
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto(`/approvals/${req.id}`);
  await page.getByRole('tab', { name: 'Sources' }).click();
  await page.getByTestId('source-list').getByRole('button', { name: /DMC-AGS-A-24-00-00-00A-040A-D\.xml/ }).click();
  const design = page.getByTestId('source-design');
  await expect(design).toBeVisible();
  await expect(page.getByRole('button', { name: 'Design', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(design.getByTestId('page-ident')).toBeVisible();
  // Artwork comes from the snapshot, not the live project.
  const img = design.getByTestId('figure-image').first();
  await expect(img).toBeVisible();
  expect(await img.getAttribute('src')).toMatch(new RegExp(`^/api/requests/${req.id}/source\\?rel=`));
  await expect.poll(() => img.evaluate((i) => i.naturalWidth)).toBeGreaterThan(0);
  // Nothing to edit.
  await expect(design.locator('[contenteditable="plaintext-only"]')).toHaveCount(0);
  await expect(page.getByTestId('page-toolbar')).toHaveCount(0);
  await expect(page.getByTestId('edit-ident')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);
  // The Tags and XML views are still there.
  await page.getByRole('button', { name: 'Tags', exact: true }).click();
  await expect(page.getByTestId('source-document')).toBeVisible();
  await page.getByRole('button', { name: 'XML', exact: true }).click();
  await expect(page.locator('[data-readonly]')).toHaveAttribute('data-readonly', 'true');
  await ctx.close();

  // The approver reads the frozen source; another manager and an Author outside the project see nothing.
  const rel = (await apiAs('priya.rao').call('GET', `/api/requests/${req.id}`)).body.files.map((f) => f.rel).find((x) => /040A-D\.xml$/.test(x) && /24-00-00/.test(x));
  const url = `/api/requests/${req.id}/source?rel=${encodeURIComponent(rel)}`;
  expect((await apiAs('priya.rao').call('GET', url)).status).toBe(200);
  for (const who of ['other.pm', 'ravi.k']) {
    const o = await fresh(browser, who);
    expect((await o.page.request.get(url)).status(), who).toBe(404);
    await o.ctx.close();
  }
  await api().call('POST', `/api/requests/${req.id}/withdraw`, {});
});
