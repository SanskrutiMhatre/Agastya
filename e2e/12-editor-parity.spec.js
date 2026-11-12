'use strict';
// Editor parity with the Agastya original, through the real UI (decisions.md
// PV15-PV24): the menu bar, keyboard shortcuts, the context menu, sections and
// steps demoted and promoted, Enter in titles and bullets, warnings, cautions
// and notes, cell ranges, alignment, columns in tables with merged cells and
// column widths, data module and publication module references, find and
// replace, word count, id tools, re-indenting, print, live checks, the
// requirements tables of a procedure, and the Tags view's display options.
// Every edited module is checked by the server's validator. Roles: the
// Author, a Project Manager and the administrator read only, an Author outside
// the project, two tabs. No screenshots are taken.
const { test, expect, run, signedIn, authorApi } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

const CODE = 'AGS-A-32-00-00-00A-040C-D';
const PROC = 'AGS-A-32-00-00-00A-520B-D';
const BODY = `
        <levelledPara id="par-0001">
          <title>Alpha section</title>
          <para>Alpha text one.</para>
          <para>Bullets:<randomList><listItem><para>First bullet</para></listItem></randomList></para>
          <table id="tab-0009">
            <title>Grid</title>
            <tgroup cols="3">
              <colspec colname="c1"/>
              <colspec colname="c2"/>
              <colspec colname="c3"/>
              <thead><row><entry><para>H1</para></entry><entry><para>H2</para></entry><entry><para>H3</para></entry></row></thead>
              <tbody>
                <row><entry><para>A</para></entry><entry><para>B</para></entry><entry><para>C</para></entry></row>
                <row><entry><para>D</para></entry><entry><para>E</para></entry><entry><para>F</para></entry></row>
                <row><entry><para>G</para></entry><entry><para>H</para></entry><entry><para>I</para></entry></row>
              </tbody>
            </tgroup>
          </table>
          <para>See <internalRef internalRefId="tab-0009" internalRefTargetType="irtt02"/>.</para>
        </levelledPara>
        <levelledPara id="par-0002">
          <title>Beta section</title>
          <para>Beta text alpha.</para>
        </levelledPara>
      `;

const api = () => authorApi();
const getModule = async (code) => {
  const { r, call } = api();
  const m = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules.find((x) => x.dmc === code);
  return { m, ...(await call('GET', `/api/projects/${r.projectId}/dms/${m.id}`)).body };
};
const savedXml = async (code = CODE) => (await getModule(code)).xml;
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
async function make(code, schemaType, infoCode, variant) {
  const { r, call } = api();
  const mods = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules;
  if (mods.some((x) => x.dmc === code)) return;
  const dmc = { modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '32', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: '00', disassyCodeVariant: 'A', infoCode, infoCodeVariant: variant, itemLocationCode: 'D' };
  expect((await call('POST', `/api/projects/${r.projectId}/dms`, { dmc, techName: 'Parity tray', infoName: 'Description', schemaType })).status).toBe(201);
}
let baseXml;

async function openDesign(page, code = CODE, project = run().projectId) {
  await page.goto(`/projects/${project}?tab=dms`);
  await page.getByRole('link', { name: code }).click();
  await expect(page.getByRole('radio', { name: 'Design' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('page-view')).toBeVisible();
}
const view = (page) => page.getByTestId('page-view');
const run_ = (page, text) => view(page).getByRole('textbox').filter({ hasText: text }).first();
async function caretAtEnd(locator) {
  await locator.evaluate((el) => {
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}
const menu = async (page, top, item) => {
  await page.getByTestId('page-menubar').getByRole('menuitem', { name: top, exact: true }).click();
  const m = page.getByRole('menu', { name: top });
  await m.getByRole('menuitem', { name: item }).or(m.getByRole('menuitemcheckbox', { name: item })).first().click();
};
const putDone = (page) => page.waitForResponse((r) => r.request().method() === 'PUT' && /\/dms\/[0-9a-f-]+$/.test(new URL(r.url()).pathname));
async function save(page) {
  const done = putDone(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await done).status()).toBe(200);
}
const cellOf = (page, text) => view(page).locator('table').first().locator('td').filter({ hasText: new RegExp(`^${text}$`) });
const count = (xml, re) => (xml.match(re) || []).length;

test.beforeAll(async () => {
  const { r, call } = api();
  for (const q of (await call('GET', `/api/projects/${r.projectId}/requests`)).body.requests.filter((x) => x.status === 'pending')) await call('POST', `/api/requests/${q.id}/withdraw`, {});
  await make(CODE, 'descript', '040', 'C');
  await make(PROC, 'proced', '520', 'B');
  const g = await getModule(CODE);
  await putXml(g.xml.replace(/<description\s*\/>|<description>[\s\S]*?<\/description>/, `<description>${BODY}</description>`));
  baseXml = await savedXml();
  await expectValid();
  // The procedure: the golden module's content in a module of its own.
  const golden = (await getModule('AGS-A-24-10-00-00A-520A-D')).xml;
  const p = await getModule(PROC);
  await putXml(p.xml.replace(/<content>[\s\S]*<\/content>/, golden.slice(golden.indexOf('<content>'), golden.indexOf('</content>') + 10)), PROC);
  await expectValid(PROC);
});

test('menus and keys insert what the schema allows: Enter in a title, Shift+Enter, Ctrl+Enter, sections, warnings, cautions, notes', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  await expect(page.getByTestId('page-menubar')).toBeVisible();
  // Enter at the end of a title: the first paragraph of the section, with the caret in it.
  await caretAtEnd(run_(page, 'Beta section'));
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-run]:focus')).toHaveCount(1);
  await page.keyboard.type('Typed under the title.');
  // Shift+Enter: a new section after this one; Ctrl+Alt+2 a section inside the current one.
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Gamma section');
  await page.keyboard.press('Control+Alt+2');
  await page.keyboard.type('Gamma one');
  // Ctrl+Enter from the title: a paragraph after it.
  await page.keyboard.press('Control+Enter');
  await page.keyboard.type('Under gamma one.');
  // Warnings, cautions and notes from the Insert menu and the toolbar, where the model allows them.
  await run_(page, 'Alpha text one.').click();
  await menu(page, 'Insert', 'Warning');
  await run_(page, 'Alpha text one.').click();
  await page.getByTestId('tool-caution').click();
  await run_(page, 'Alpha text one.').click();
  await page.keyboard.press('Control+Alt+N');
  await expect(view(page).locator('aside')).toHaveCount(3);
  await save(page);
  const xml = await savedXml();
  expect(xml).toMatch(/<title>Beta section<\/title>\s*<para>Typed under the title\.<\/para>/);
  expect(xml).toMatch(/<levelledPara><title>Gamma section<\/title>[\s\S]*<levelledPara><title>Gamma one<\/title>\s*<para>Under gamma one\.<\/para>/);
  expect(count(xml, /<warning>/g)).toBe(1);
  expect(count(xml, /<caution>/g)).toBe(1);
  expect(count(xml, /<note>/g)).toBe(1);
  await expectValid();
  await ctx.close();
});

test('Tab demotes a section into the one before and Shift+Tab promotes it back; steps nest the same way', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await putXml(baseXml);
  await openDesign(page);
  await run_(page, 'Beta section').click();
  await page.keyboard.press('Tab');
  await save(page);
  let xml = await savedXml();
  expect(xml).toMatch(/<levelledPara id="par-0001">[\s\S]*<levelledPara id="par-0002">[\s\S]*<\/levelledPara>\s*<\/levelledPara>\s*<\/description>/);
  await expectValid();
  await run_(page, 'Beta section').click();
  await page.keyboard.press('Shift+Tab');
  await save(page);
  xml = await savedXml();
  expect(xml).toBe(baseXml);
  // The toolbar says why when there is nothing to do.
  await run_(page, 'Alpha section').click();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('page-notice')).toContainText('Only a nested section or step can be promoted');
  await ctx.close();

  const p = await signedIn(browser, 'arjun.das');
  await openDesign(p.page, PROC);
  await run_(p.page, 'Loosen the two captive screws').click();
  await p.page.keyboard.press('Tab');
  await save(p.page);
  const proc = await savedXml(PROC);
  expect(proc).toMatch(/<proceduralStep id="stp-241520-01">[\s\S]*<proceduralStep id="stp-241520-02">[\s\S]*<\/proceduralStep>\s*<\/proceduralStep>/);
  await expectValid(PROC);
  await p.ctx.close();
});

test('bullets: Enter makes the next bullet; Enter on an empty last bullet ends the list with a paragraph', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await putXml(baseXml);
  await openDesign(page);
  await caretAtEnd(run_(page, 'First bullet'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second bullet');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('After the list.');
  await save(page);
  const xml = await savedXml();
  expect(xml).toMatch(/<listItem><para>First bullet<\/para><\/listItem>\s*<listItem><para>Second bullet<\/para><\/listItem><\/randomList><\/para>\s*<para>After the list\.<\/para>/);
  await expectValid();
  await ctx.close();
});

test('the context menu: attributes, another of the same kind, move into the previous sibling, delete only where valid', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await putXml(baseXml);
  await openDesign(page);
  await run_(page, 'Alpha text one.').click({ button: 'right' });
  const cm = page.getByTestId('context-menu');
  await expect(cm).toContainText('<para>');
  await cm.getByRole('menuitem', { name: 'Add another <para> after' }).click();
  // Insert… offers places before the element as well as after it.
  await run_(page, 'Alpha text one.').click({ button: 'right' });
  await cm.getByRole('menuitem', { name: 'Insert…' }).click();
  await expect(page.getByTestId('insert-options')).toContainText('before <para>');
  await page.keyboard.press('Escape');
  await run_(page, 'Alpha text one.').click({ button: 'right' });
  await cm.getByRole('menuitem', { name: 'Attributes of <para>…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Attributes of <para>' });
  await dlg.getByLabel('id', { exact: true }).fill('par-0001');
  await expect(dlg.getByText('Another element already has this id.')).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await dlg.getByLabel('id', { exact: true }).fill('para-alpha');
  await dlg.getByRole('button', { name: 'Apply' }).click();
  // A bullet needs its paragraph: deleting it is not offered (a section's title, optional in S1000D 4.2, may go).
  await run_(page, 'First bullet').click({ button: 'right' });
  await expect(cm.getByRole('menuitem', { name: 'Delete <para>' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await run_(page, 'Beta section').click({ button: 'right' });
  await expect(cm.getByRole('menuitem', { name: 'Delete <title>' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(cm).toHaveCount(0);
  // The second section moves into the first.
  // The second section, selected from the outline, moves into the first (the Edit menu has the same actions).
  await page.keyboard.press('Escape');
  await page.getByTestId('outline').getByRole('button', { name: /Beta section/ }).click();
  await menu(page, 'Edit', 'Move into previous sibling');
  await save(page);
  const xml = await savedXml();
  expect(xml).toMatch(/<para id="para-alpha">Alpha text one\.<\/para>\s*<para\/>/);
  expect(xml).toMatch(/<levelledPara id="par-0002">[\s\S]*<\/levelledPara>\s*<\/levelledPara>\s*<\/description>/);
  await expectValid();
  await ctx.close();
});

test('tables: a Shift+click range merges; cells align; columns are added in a table with merged cells; widths are set', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await putXml(baseXml);
  await openDesign(page);
  await cellOf(page, 'A').click();
  await cellOf(page, 'E').click({ modifiers: ['Shift'] });
  await expect(view(page).locator('td[data-in-range="true"]')).toHaveCount(4);
  await page.getByTestId('tbl-merge-range').click();
  await expect(view(page).locator('td[colspan="2"][rowspan="2"]')).toHaveText('ABDE');
  const merged = cellOf(page, 'ABDE');
  // A range that would leave a row with no cell is refused, with the reason.
  await cellOf(page, 'C').click();
  await cellOf(page, 'F').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('range-reason')).toContainText('no cell of its own');
  await expect(page.getByTestId('tbl-merge-range')).toBeDisabled();
  // Alignment from the Table menu.
  await cellOf(page, 'C').click();
  await menu(page, 'Table', 'Align centre');
  await expect(cellOf(page, 'C')).toHaveCSS('text-align', 'center');
  await menu(page, 'Table', 'Bottom');
  // A column in a table with merged cells: the merged cell widens over it.
  await cellOf(page, 'H').click();
  await page.getByTestId('tbl-col-left').click();
  await expect(view(page).locator('table').first().locator('th')).toHaveCount(4);
  await expect(merged).toHaveAttribute('colspan', '3');
  await cellOf(page, 'H').click();
  await menu(page, 'Table', 'Column widths…');
  const w = page.getByRole('dialog', { name: 'Column widths' });
  await w.getByLabel('Column 1').fill('wide');
  await expect(w.getByText('Use a number followed by')).toBeVisible();
  await w.getByLabel('Column 1').fill('2*');
  await w.getByLabel('Column 4').fill('30mm');
  await w.getByRole('button', { name: 'Apply' }).click();
  await save(page);
  const xml = await savedXml();
  expect(xml).toMatch(/<entry namest="c1" nameend="c2" morerows="1"><para>A<\/para><para>B<\/para><para>D<\/para><para>E<\/para><\/entry>/);
  expect(xml).toMatch(/<entry align="center" valign="bottom"><para>C<\/para><\/entry>/);
  expect(xml).toMatch(/<tgroup cols="4">/);
  expect(xml).toMatch(/<colspec colname="c1" colwidth="2\*"\/>/);
  expect(xml).toMatch(/<colspec colname="c3" colwidth="30mm"\/>/);
  await expectValid();
  await ctx.close();
});

test('references: a data module with its issue and title, the publication module, from the menu and Ctrl+K', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await putXml(baseXml);
  await openDesign(page);
  await caretAtEnd(run_(page, 'Beta text alpha.'));
  await page.keyboard.press('Control+k');
  const dlg = page.getByRole('dialog', { name: 'Insert a reference' });
  await dlg.getByRole('tab', { name: 'In this module' }).click();
  await dlg.getByLabel('Target type').selectOption('table');
  await expect(dlg.getByTestId('ref-targets').getByRole('button')).toHaveCount(1);
  await dlg.getByRole('tab', { name: 'Data module' }).click();
  await dlg.getByLabel('Technical and information name').check();
  await dlg.getByLabel('Issue').check();
  await dlg.getByLabel('Filter data modules').fill('030A');
  await dlg.getByTestId('ref-modules').getByRole('button').first().click();
  await expect(dlg).toHaveCount(0);
  await caretAtEnd(run_(page, 'Beta text alpha.'));
  await menu(page, 'Insert', 'Reference…');
  await dlg.getByRole('tab', { name: 'Publication module' }).click();
  await expect(dlg.getByTestId('ref-pm')).toContainText('PMC-AGS-0AGS1-00001-00');
  await dlg.getByRole('button', { name: 'Insert reference' }).click();
  await save(page);
  const xml = await savedXml();
  expect(xml).toMatch(/<dmRef><dmRefIdent><dmCode [^>]*infoCode="030"[^>]*\/><issueInfo issueNumber="\d{3}" inWork="\d{2}"\/><\/dmRefIdent><dmRefAddressItems><dmTitle><techName>[^<]+<\/techName>/);
  expect(xml).toMatch(/<pmRef><pmRefIdent><pmCode modelIdentCode="AGS" pmIssuer="0AGS1" pmNumber="00001" pmVolume="00"\/><\/pmRefIdent>/);
  await expectValid();
  await ctx.close();
});

test('tools: find and replace, word count, re-sequenced ids with references following, re-indent, print, shortcuts', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await putXml(baseXml);
  await page.addInitScript(() => { window.print = () => { window.top.__printed = document.body.innerText; }; });
  await openDesign(page);
  // The page's shortcuts work while it has the focus (the caret in its text).
  await run_(page, 'Alpha text one.').click();
  await page.keyboard.press('Control+h');
  const f = page.getByRole('dialog', { name: 'Find and replace' });
  await f.getByLabel('Find').fill('alpha');
  await expect(f.getByTestId('find-count')).toHaveText('1 of 3');
  await f.getByLabel('Match case').check();
  await expect(f.getByTestId('find-count')).toHaveText('1 of 1');
  await f.getByLabel('Match case').uncheck();
  await f.getByLabel('Replace with').fill('Delta');
  await f.getByRole('button', { name: 'Replace all' }).click();
  await expect(f.getByTestId('find-count')).toHaveText('No matches.');
  await f.getByRole('button', { name: 'Close' }).click();
  await menu(page, 'Tools', 'Word count…');
  await expect(page.getByTestId('word-count')).toContainText('Tables');
  await page.keyboard.press('Escape');
  await menu(page, 'Tools', 'Re-sequence table ids');
  await expect(page.getByTestId('page-notice')).toContainText('1 table id re-numbered');
  await menu(page, 'Tools', 'Re-indent the XML');
  await expect(page.getByTestId('page-notice')).toContainText('text was not touched');
  await menu(page, 'Tools', 'Print…');
  await expect.poll(() => page.evaluate(() => window.__printed || '')).toContain('Delta section');
  await menu(page, 'Help', 'Keyboard shortcuts');
  await expect(page.getByTestId('shortcuts')).toContainText('Ctrl+Alt+W');
  await page.keyboard.press('Escape');
  await save(page);
  const xml = await savedXml();
  expect(xml).toContain('<title>Delta section</title>');
  expect(xml).toContain('<para>Beta text Delta.</para>');
  expect(xml).toMatch(/<table id="tab-0001">/);
  expect(xml).toMatch(/<internalRef internalRefId="tab-0001" internalRefTargetType="irtt02"\/>/);
  // Re-indenting moved no text: the text of every element is what it was, with the replacements.
  const texts = (x) => [...x.matchAll(/<(title|para)\b[^>]*>([^<]+)</g)].map((m) => m[2]);
  expect(texts(xml)).toEqual(texts(baseXml.replace(/Alpha/g, 'Delta').replace(/alpha/g, 'Delta')));
  await expectValid();
  await ctx.close();
});

test('live checks show a broken reference and an undeclared ICN where they are; Ctrl+Z undoes a menu action', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await putXml(baseXml.replace('internalRefId="tab-0009"', 'internalRefId="tab-9999"').replace('<para>Beta text alpha.</para>', '<para>Beta text alpha.</para><figure id="fig-0001"><title>Loose</title><graphic infoEntityIdent="ICN-AGS-NOT-DECLARED-1"/></figure>'));
  await openDesign(page);
  await expect(view(page).getByTestId('live-check')).toHaveCount(1);
  await expect(view(page).getByTestId('live-check')).toContainText('ICN-AGS-NOT-DECLARED-1 is not declared');
  await menu(page, 'Review', 'Live checks (2)…');
  const list = page.getByTestId('checks-list');
  await expect(list).toContainText('points to tab-9999');
  await list.getByRole('button', { name: 'Go to' }).first().click();
  await expect(page.getByRole('navigation', { name: 'Element path' })).toBeVisible();
  // Undo from the keyboard (the caret not in a text box).
  await run_(page, 'Alpha text one.').click();
  await menu(page, 'Insert', 'Note');
  await expect(view(page).locator('aside')).toHaveCount(1);
  // Click on the menubar strip itself, away from any button, just to blur the
  // caret out of the text; `force` skips the overlap check since the menubar's
  // own row may now be narrower than it once was and not literally empty there.
  await page.getByTestId('page-menubar').click({ position: { x: 600, y: 5 }, force: true });
  await page.keyboard.press('Control+z');
  await expect(view(page).locator('aside')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(view(page).locator('aside')).toHaveCount(1);
  await ctx.close();
  await putXml(baseXml);
});

test('a procedure\'s requirements read as the build\'s tables, cells edited in place; the Tags view shows attributes and hides chosen tags', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page, PROC);
  const cond = view(page).getByTestId('req-reqCondGroup').first();
  await expect(cond).toContainText('Required conditions');
  await expect(cond.locator('th')).toHaveText(['Action/Condition', 'Data module/Technical publication']);
  await expect(view(page).getByTestId('req-reqSupportEquips')).toContainText('Torque screwdriver, 0.5 N.m to 3 N.m');
  await expect(view(page).getByTestId('req-reqSupportEquips')).toContainText('0AGS1 TS-0503');
  await expect(view(page).getByTestId('req-reqSupplies')).toContainText('None');
  await expect(view(page).getByTestId('req-reqPersons')).toContainText('Electrical technician');
  await caretAtEnd(run_(page, 'Torque screwdriver'));
  await page.keyboard.type(' (calibrated)');
  await save(page);
  expect(await savedXml(PROC)).toContain('<name>Torque screwdriver, 0.5 N.m to 3 N.m (calibrated)</name>');
  await expectValid(PROC);
  // Tags view options.
  await page.getByRole('radio', { name: 'Tags' }).click();
  await page.getByLabel('Attributes', { exact: true }).check();
  await expect(page.getByTestId('tag-attrs').filter({ hasText: 'id="stp-241520-01"' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Select proceduralStep' }).first().click();
  await page.getByTestId('hide-tags').click();
  await expect(page.getByRole('button', { name: 'Select proceduralStep' })).toHaveCount(1); // only the selected one shows its tag
  await page.getByRole('button', { name: 'Show <proceduralStep>' }).click();
  await expect(page.getByRole('button', { name: 'Select proceduralStep' })).toHaveCount(4);
  await page.getByLabel('Attributes', { exact: true }).uncheck();
  await page.getByRole('radio', { name: 'Design' }).click();
  await ctx.close();
});

test('read-only: menus offer finding and reading only; no context menu; others outside the project get nothing', async ({ browser }) => {
  const r = run();
  const pm = await signedIn(browser, 'priya.rao');
  await openDesign(pm.page, 'AGS-A-24-00-00-00A-040A-D', r.managedId);
  const bar = pm.page.getByTestId('page-menubar');
  await expect(bar.getByRole('menuitem', { name: 'Insert', exact: true })).toHaveCount(0);
  await expect(bar.getByRole('menuitem', { name: 'Table', exact: true })).toHaveCount(0);
  await bar.getByRole('menuitem', { name: 'Tools', exact: true }).click();
  await expect(pm.page.getByRole('menuitem', { name: 'Re-indent the XML' })).toBeDisabled();
  await expect(pm.page.getByRole('menuitem', { name: 'Word count…' })).toBeEnabled();
  await pm.page.keyboard.press('Escape');
  await view(pm.page).locator('p, div').filter({ hasText: /\w/ }).first().click({ button: 'right' });
  await expect(pm.page.getByTestId('context-menu')).toHaveCount(0);
  await view(pm.page).getByText('Function').first().click();
  await pm.page.keyboard.press('Control+h');
  await expect(pm.page.getByRole('dialog', { name: 'Find and replace' }).getByLabel('Replace with')).toHaveCount(0);
  await pm.ctx.close();

  const ad = await signedIn(browser, 'admin');
  await openDesign(ad.page);
  await expect(ad.page.getByTestId('override-offer')).toBeVisible();
  await expect(ad.page.getByTestId('page-menubar').getByRole('menuitem', { name: 'Insert', exact: true })).toHaveCount(0);
  await ad.ctx.close();

  const ctx = await browser.newContext({ baseURL: r.base });
  const page = await ctx.newPage();
  expect((await page.request.post('/api/auth/login', { data: { username: 'ravi.k', password: r.accounts['ravi.k'].password }, headers: { origin: r.base } })).status()).toBe(200);
  const g = await getModule(CODE);
  expect((await page.request.get(`/api/projects/${r.projectId}/dms/${g.m.id}`)).status()).toBe(404);
  await ctx.close();
});

test('two tabs: a context-menu change in a stale tab is refused, not merged over the newer save', async ({ browser }) => {
  await putXml(baseXml);
  const { ctx, page: tab1 } = await signedIn(browser, 'arjun.das');
  const tab2 = await ctx.newPage();
  for (const p of [tab1, tab2]) await openDesign(p);
  await run_(tab1, 'Alpha text one.').click();
  await menu(tab1, 'Insert', 'Warning');
  await save(tab1);
  await expect(tab2.getByText(/saved a newer version/)).toBeVisible();
  await run_(tab2, 'Alpha text one.').click({ button: 'right' });
  await tab2.getByTestId('context-menu').getByRole('menuitem', { name: 'Add another <para> after' }).click();
  await tab2.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(tab2.getByRole('dialog', { name: 'Someone else saved this module' })).toBeVisible();
  const xml = await savedXml();
  expect(count(xml, /<warning>/g)).toBe(1);
  expect(xml).not.toMatch(/Alpha text one\.<\/para>\s*<para\/>/);
  await ctx.close();
});
