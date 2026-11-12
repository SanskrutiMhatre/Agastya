'use strict';
// Functional repair of the editor (decisions.md PV25-PV31): each test is a
// defect reproduced in the real UI, now fixed, run as an author would, with
// the result checked in the saved XML, by the server's validator, after
// reopening the module, and in the PDF build where it matters. Roles and two
// tabs are covered by specs 10-12. No screenshots are taken.
const { test, expect, run, signedIn, authorApi } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

const CODE = 'AGS-A-32-00-00-00A-040E-D';
const BODY = `
        <levelledPara id="par-0001">
          <title>Alpha section</title>
          <para>Split me <emphasis>here</emphasis> please.</para>
          <para>Second para.</para>
          <para/>
          <para>Third para.</para>
          <table id="tab-0001">
            <title>Grid</title>
            <tgroup cols="3">
              <colspec colname="c1" colwidth="40mm"/><colspec colname="c2" colwidth="1*"/><colspec colname="c3" colwidth="3*"/>
              <tbody>
                <row><entry morerows="1"><para>A</para></entry><entry><para>B</para></entry><entry><para>C</para></entry></row>
                <row><entry><para>E</para></entry><entry><para>F</para></entry></row>
                <row><entry><para>G</para></entry><entry><para>H</para></entry><entry><para>I</para></entry></row>
              </tbody>
            </tgroup>
          </table>
          <para>List:<randomList><listItem><para>one two</para></listItem></randomList></para>
        </levelledPara>
      `;
const api = () => authorApi();
const getModule = async (code = CODE) => {
  const { r, call } = api();
  const m = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules.find((x) => x.dmc === code);
  return { m, ...(await call('GET', `/api/projects/${r.projectId}/dms/${m.id}`)).body };
};
const savedXml = async (code) => (await getModule(code)).xml;
async function putXml(xml, code = CODE) {
  const { r, call } = api();
  const g = await getModule(code);
  const res = await call('PUT', `/api/projects/${r.projectId}/dms/${g.m.id}`, { xml, baseRevision: g.revision });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
async function expectValid(code = CODE) {
  const { r, call } = api();
  const g = await getModule(code);
  const v = await call('POST', `/api/projects/${r.projectId}/dms/${g.m.id}/validate`, { xml: g.xml });
  expect(v.body.findings.filter((f) => f.sev === 'error' && f.kind !== 'brex'), JSON.stringify(v.body.findings)).toEqual([]);
}
let base;

async function openDesign(page, code = CODE) {
  await page.goto(`/projects/${run().projectId}?tab=dms`);
  await page.getByRole('link', { name: code }).click();
  await expect(page.getByTestId('page-view')).toBeVisible();
}
const view = (p) => p.getByTestId('page-view');
const run_ = (p, t) => view(p).getByRole('textbox').filter({ hasText: t }).first();
const runs = (p) => view(p).getByRole('textbox').allTextContents();
const cellOf = (p, t) => view(p).locator('table').first().locator('td').filter({ hasText: new RegExp(`^${t}$`) });
async function caretAt(loc, offset) {
  await loc.evaluate((el, o) => {
    el.focus();
    const r = document.createRange(); r.setStart(el.firstChild, o); r.collapse(true);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, offset);
}
async function save(page) {
  const done = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/dms\/[0-9a-f-]+$/.test(new URL(r.url()).pathname));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await done).status()).toBe(200);
}
const tbody = (x) => x.match(/<tbody>[\s\S]*?<\/tbody>/)[0].replace(/\s+/g, ' ');

test.beforeAll(async () => {
  const { r, call } = api();
  for (const q of (await call('GET', `/api/projects/${r.projectId}/requests`)).body.requests.filter((x) => x.status === 'pending')) await call('POST', `/api/requests/${q.id}/withdraw`, {});
  const mods = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules;
  if (!mods.some((x) => x.dmc === CODE)) {
    const dmc = { modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '32', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: '00', disassyCodeVariant: 'A', infoCode: '040', infoCodeVariant: 'E', itemLocationCode: 'D' };
    expect((await call('POST', `/api/projects/${r.projectId}/dms`, { dmc, techName: 'Repair tray', infoName: 'Description', schemaType: 'descript' })).status).toBe(201);
  }
  const g = await getModule();
  await putXml(g.xml.replace(/<description\s*\/>|<description>[\s\S]*?<\/description>/, `<description>${BODY}</description>`));
  base = await savedXml();
  await expectValid();
});

test('Enter splits at the caret (markup goes with the second half); Ctrl+Z joins it back; a bullet splits into two bullets', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  await caretAt(run_(page, 'Split me'), 6);
  await page.keyboard.press('Enter');
  // The caret is at the start of the new paragraph: typing goes before the moved text.
  await page.keyboard.type('>');
  await page.keyboard.press('Control+z'); // the browser undoes the typing first
  await expect(view(page).getByRole('textbox').filter({ hasText: /^me $/ })).toHaveCount(1);
  await page.keyboard.press('Control+z'); // then the editor undoes the split
  await expect(run_(page, 'Split me')).toHaveText('Split me ');
  await expect(view(page).locator('[data-element="para"]').filter({ hasText: /^Split me here please\.$/ })).toHaveCount(1);
  await page.keyboard.press('Control+y');
  await expect(view(page).locator('[data-element="para"]').filter({ hasText: /^Split $/ })).toHaveCount(1);
  await caretAt(run_(page, 'one two'), 3);
  await page.keyboard.press('Enter');
  await page.keyboard.type('NEW');
  await save(page);
  const x = await savedXml();
  expect(x).toMatch(/<para>Split <\/para>\s*<para>me <emphasis>here<\/emphasis> please\.<\/para>/);
  expect(x).toMatch(/<listItem><para>one<\/para><\/listItem>\s*<listItem><para>NEW two<\/para><\/listItem>/);
  await expectValid();
  // Reopened, the page shows the same.
  await page.reload();
  await expect(view(page).locator('li')).toHaveCount(2);
  expect(await runs(page)).toEqual(expect.arrayContaining(['Split ', 'NEW two']));
  await ctx.close();
});

test('Backspace removes an empty paragraph and joins a paragraph to the one before; Delete joins the next one; a lone bullet is kept', async ({ browser }) => {
  await putXml(base);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  await view(page).locator('[data-element="para"]').nth(2).getByRole('textbox').click();
  await page.keyboard.press('Backspace');
  await expect(view(page).locator('[data-element="levelledPara"] > section > [data-element="para"]')).toHaveCount(4);
  // The caret is at the end of "Second para."; Delete pulls "Third para." in.
  await page.keyboard.press('Delete');
  await expect(run_(page, 'Second para.')).toBeVisible();
  await caretAt(run_(page, 'Second para.'), 0);
  await page.keyboard.press('Backspace');
  // The lone bullet's paragraph is required: Backspace there changes nothing.
  await caretAt(run_(page, 'one two'), 0);
  await page.keyboard.press('Backspace');
  await save(page);
  const x = await savedXml();
  expect(x).toMatch(/<para>Split me <emphasis>here<\/emphasis> please\.Second para\.Third para\.<\/para>/);
  expect(x).not.toMatch(/<para\/>/);
  expect(x).toMatch(/<listItem><para>one two<\/para><\/listItem>/);
  await expectValid();
  await ctx.close();
});

test('rows in a table with merged cells: a row inside a span is spanned, deleting the spanning cell\'s row keeps its content; the table stays editable after reopening', async ({ browser }) => {
  await putXml(base);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  await cellOf(page, 'B').click();
  await page.getByTestId('tbl-row-below').click();
  await expect(cellOf(page, 'A')).toHaveAttribute('rowspan', '3');
  await save(page);
  expect(tbody(await savedXml())).toBe('<tbody> <row><entry morerows="2"><para>A</para></entry><entry><para>B</para></entry><entry><para>C</para></entry></row> <row><entry colname="c2"><para/></entry><entry colname="c3"><para/></entry></row> <row><entry><para>E</para></entry><entry><para>F</para></entry></row> <row><entry><para>G</para></entry><entry><para>H</para></entry><entry><para>I</para></entry></row> </tbody>');
  await expectValid();
  await page.reload();
  await cellOf(page, 'G').click();
  await expect(page.getByTestId('tbl-merge-right')).toBeEnabled();
  // Delete the row holding A: A moves down with its content.
  await cellOf(page, 'B').click();
  await page.getByTestId('tbl-row-delete').click();
  await expect(cellOf(page, 'A')).toHaveAttribute('rowspan', '2');
  await save(page);
  expect(tbody(await savedXml())).toBe('<tbody> <row><entry morerows="1" colname="c1"><para>A</para></entry><entry colname="c2"><para/></entry><entry colname="c3"><para/></entry></row> <row><entry><para>E</para></entry><entry><para>F</para></entry></row> <row><entry><para>G</para></entry><entry><para>H</para></entry><entry><para>I</para></entry></row> </tbody>');
  await expectValid();
  // The body keeps one row.
  await putXml(base.replace(/<tbody>[\s\S]*?<\/tbody>/, '<tbody><row><entry><para>Only</para></entry><entry><para>X</para></entry><entry><para>Y</para></entry></row></tbody>'));
  await page.reload();
  await cellOf(page, 'Only').click();
  await page.getByTestId('tbl-row-delete').click();
  await expect(page.getByTestId('page-notice')).toContainText('keeps at least one row');
  await ctx.close();
});

test('Tab moves through table cells, Shift+Tab back; the section around the table is not moved', async ({ browser }) => {
  await putXml(base);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  await cellOf(page, 'B').getByRole('textbox').click();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-run]:focus')).toHaveText('C');
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-run]:focus')).toHaveText('E');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('[data-run]:focus')).toHaveText('C');
  await page.keyboard.type(' typed');
  await save(page);
  const x = await savedXml();
  expect(x).toContain('<entry><para>C typed</para></entry>');
  expect(x.replace('C typed', 'C')).toBe(base);
  await ctx.close();
});

test('column widths in lengths and proportions show on the page as the PDF lays them out', async ({ browser }) => {
  await putXml(base);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  const widths = await view(page).locator('table').first().locator('col').evaluateAll((cs) => cs.map((c) => c.style.width));
  expect(widths).toEqual(['40mm', '25%', '75%']);
  await ctx.close();
});

test('duplicate, change into, replace "None": content kept, ids unique, valid, and the PDF builds', async ({ browser }) => {
  await putXml(base);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  const cm = page.getByTestId('context-menu');
  await page.getByTestId('outline').getByRole('button', { name: /Table 1/ }).click();
  await page.getByTestId('page-menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menu', { name: 'Edit' }).getByRole('menuitem', { name: 'Duplicate <table>' }).click();
  await expect(view(page).locator('table')).toHaveCount(2);
  await view(page).locator('ul').first().click({ button: 'right', position: { x: 2, y: 2 } });
  await cm.getByRole('menuitem', { name: 'Change to <sequentialList>' }).click();
  await expect(view(page).locator('ol')).toHaveCount(1);
  await save(page);
  const x = await savedXml();
  expect(x).toMatch(/<table id="tab-0001-2">/);
  expect((x.match(/<title>Grid<\/title>/g) || []).length).toBe(2);
  expect(x).toMatch(/<sequentialList><listItem><para>one two<\/para><\/listItem><\/sequentialList>/);
  await expectValid();
  const g = await getModule();
  const pdf = await page.request.post(`/api/projects/${run().projectId}/dms/${g.m.id}/preview`, { headers: { origin: run().base } });
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  await ctx.close();

  // "None" in a procedure's requirements becomes a real item, and back.
  const p = await signedIn(browser, 'arjun.das');
  await openDesign(p.page, 'AGS-A-24-10-00-00A-520A-D');
  const before = await savedXml('AGS-A-24-10-00-00A-520A-D');
  await view(p.page).getByTestId('req-reqSupplies').getByText('None').click({ button: 'right' });
  await p.page.getByTestId('context-menu').getByRole('menuitem', { name: 'Replace with <supplyDescrGroup>' }).click();
  await expect(view(p.page).getByTestId('req-reqSupplies').locator('tbody tr')).toHaveCount(1);
  await expect(view(p.page).getByTestId('req-reqSupplies')).not.toContainText('None');
  await save(p.page);
  await expectValid('AGS-A-24-10-00-00A-520A-D');
  await putXml(before, 'AGS-A-24-10-00-00A-520A-D');
  await p.ctx.close();
});

test('a data module reference to a module outside the project is flagged; a figure with missing artwork can be deleted safely', async ({ browser }) => {
  const errors = [];
  await putXml(base.replace('<para>Third para.</para>', '<para>Third <dmRef><dmRefIdent><dmCode modelIdentCode="ZZZ" systemDiffCode="A" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="040" infoCodeVariant="A" itemLocationCode="D"/></dmRefIdent></dmRef> para.</para><figure id="fig-0001"><title>Missing art</title><graphic infoEntityIdent="ICN-AGS-A-NOFILE-1"/></figure>'));
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  page.on('pageerror', (e) => errors.push(e.message));
  await openDesign(page);
  // The reference is marked where it is, and listed under Review, Live checks.
  await expect(view(page).locator('[data-testid="ref-pill"][data-check]')).toHaveAttribute('title', 'DMC-ZZZ-A-00-00-00-00A-040A-D is not a data module of this project.');
  await page.getByTestId('page-menubar').getByRole('menuitem', { name: 'Review', exact: true }).click();
  await page.getByRole('menu', { name: 'Review' }).getByRole('menuitem', { name: /Live checks/ }).click();
  await expect(page.getByTestId('checks-list')).toContainText('DMC-ZZZ-A-00-00-00-00A-040A-D is not a data module of this project');
  await page.keyboard.press('Escape');
  await expect(view(page).getByTestId('figure-missing')).toContainText('ICN-AGS-A-NOFILE-1');
  await page.getByTestId('outline').getByRole('button', { name: /Fig 1/ }).click();
  await page.getByTestId('page-menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menu', { name: 'Edit' }).getByRole('menuitem', { name: 'Delete <figure>' }).click();
  await expect(view(page).getByTestId('figure-missing')).toHaveCount(0);
  await page.getByTestId('page-menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menu', { name: 'Edit' }).getByRole('menuitem', { name: 'Undo' }).click();
  await expect(view(page).getByTestId('figure-missing')).toHaveCount(1);
  expect(errors).toEqual([]);
  await ctx.close();
  await putXml(base);
});

test('validation from the Review menu and Ctrl+Shift+V reports this module; Enter in a warning splits within the warning', async ({ browser }) => {
  // (S1000D puts warnings at the start of a section, before its paragraphs.)
  await putXml(base.replace('<title>Alpha section</title>', '<title>Alpha section</title><warning><warningAndCautionPara>Mains voltage is dangerous here.</warningAndCautionPara></warning>'));
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  const validated = () => page.waitForResponse((r) => r.request().method() === 'POST' && /\/validate$/.test(new URL(r.url()).pathname));
  let done = validated();
  await page.getByTestId('page-menubar').getByRole('menuitem', { name: 'Review', exact: true }).click();
  await page.getByRole('menu', { name: 'Review' }).getByRole('menuitem', { name: /^Validate/ }).click();
  expect((await done).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Validation' })).toBeVisible();
  await caretAt(run_(page, 'Mains voltage'), 14);
  await page.keyboard.press('Enter');
  done = validated();
  await page.keyboard.press('Control+Shift+V');
  expect((await done).status()).toBe(200);
  await save(page);
  const x = await savedXml();
  expect(x).toMatch(/<warning><warningAndCautionPara>Mains voltage <\/warningAndCautionPara><warningAndCautionPara>is dangerous here\.<\/warningAndCautionPara><\/warning>/);
  await expectValid();
  await ctx.close();
  await putXml(base);
});
