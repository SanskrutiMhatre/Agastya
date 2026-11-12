'use strict';
// The user guide done as an author does it: real mouse clicks, double clicks,
// right clicks and keys only (no scripted carets or synthetic events), so the
// keyboard focus is what a person would have. Each sequence is checked in the
// saved XML, by the server's validator and after reopening (decisions.md
// PV32-PV34). No screenshots are taken.
const { test, expect, run, signedIn, authorApi } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

const CODE = 'AGS-A-32-00-00-00A-040F-D';
const BODY = `
        <levelledPara id="par-0001">
          <title>Overview</title>
          <para>The fan cools the cabinet.</para>
          <para>Second paragraph here.</para>
          <table id="tab-0001">
            <title>Limits</title>
            <tgroup cols="3">
              <colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/>
              <tbody>
                <row><entry><para>A</para></entry><entry><para>B</para></entry><entry><para>C</para></entry></row>
                <row><entry><para>D</para></entry><entry><para>E</para></entry><entry><para>F</para></entry></row>
              </tbody>
            </tgroup>
          </table>
        </levelledPara>
        <levelledPara id="par-0002">
          <title>Details</title>
          <para>Details text.</para>
        </levelledPara>
      `;
const api = () => authorApi();
const getModule = async () => {
  const { r, call } = api();
  const m = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules.find((x) => x.dmc === CODE);
  return { m, ...(await call('GET', `/api/projects/${r.projectId}/dms/${m.id}`)).body };
};
const saved = async () => (await getModule()).xml;
async function putXml(xml) {
  const { r, call } = api();
  const g = await getModule();
  expect((await call('PUT', `/api/projects/${r.projectId}/dms/${g.m.id}`, { xml, baseRevision: g.revision })).status).toBe(200);
}
async function expectValid() {
  const { r, call } = api();
  const g = await getModule();
  const v = await call('POST', `/api/projects/${r.projectId}/dms/${g.m.id}/validate`, { xml: g.xml });
  expect(v.body.findings.filter((f) => f.sev === 'error' && f.kind !== 'brex'), JSON.stringify(v.body.findings)).toEqual([]);
}
let base;
const view = (p) => p.getByTestId('page-view');
const text = (p, t) => view(p).getByRole('textbox').filter({ hasText: t }).first();
const focused = (p) => p.locator('[data-run]:focus');
async function open(page) {
  await page.goto(`/projects/${run().projectId}?tab=dms`);
  await page.getByRole('link', { name: CODE }).click();
  await expect(view(page)).toBeVisible();
}
async function save(page) {
  const done = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/dms\/[0-9a-f-]+$/.test(new URL(r.url()).pathname));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await done).status()).toBe(200);
}

test.beforeAll(async () => {
  const { r, call } = api();
  for (const q of (await call('GET', `/api/projects/${r.projectId}/requests`)).body.requests.filter((x) => x.status === 'pending')) await call('POST', `/api/requests/${q.id}/withdraw`, {});
  const mods = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules;
  if (!mods.some((x) => x.dmc === CODE)) {
    const dmc = { modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '32', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: '00', disassyCodeVariant: 'A', infoCode: '040', infoCodeVariant: 'F', itemLocationCode: 'D' };
    expect((await call('POST', `/api/projects/${r.projectId}/dms`, { dmc, techName: 'User guide', infoName: 'Description', schemaType: 'descript' })).status).toBe(201);
  }
  const g = await getModule();
  await putXml(g.xml.replace(/<description\s*\/>|<description>[\s\S]*?<\/description>/, `<description>${BODY}</description>`));
  base = await saved();
});

test('writing a section from the keyboard leaves no stray empty paragraphs, and every key keeps the caret in the page', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await open(page);
  await text(page, 'The fan cools').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' It runs.');
  await page.keyboard.press('Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(focused(page)).toHaveText(' fan cools the cabinet. It runs.');
  await page.keyboard.type('X');
  await page.keyboard.press('Shift+Enter');
  await expect(focused(page)).toHaveText('');
  await page.keyboard.type('New section');
  // Enter at the end of the title goes into the section's own first paragraph (not a second one).
  await page.keyboard.press('Enter');
  await page.keyboard.type('Body of new.');
  await page.keyboard.press('Control+Alt+2');
  await page.keyboard.type('Sub one');
  // Ctrl+Enter after the sub-section's title uses its empty paragraph too.
  await page.keyboard.press('Control+Enter');
  await page.keyboard.type('Under sub.');
  await save(page);
  const x = await saved();
  expect(x).toMatch(/<para>The<\/para>\s*<para>X fan cools the cabinet\. It runs\.<\/para>/);
  expect(x).toMatch(/<title>New section<\/title>\s*<para>Body of new\.<\/para>\s*<levelledPara>\s*<title>Sub one<\/title>\s*<para>Under sub\.<\/para>\s*<\/levelledPara>\s*<\/levelledPara>/);
  expect(x).not.toMatch(/<para\/>|<para><\/para>/);
  await expectValid();
  await page.reload();
  await expect(text(page, 'Under sub.')).toBeVisible();
  await expect(text(page, 'X fan cools')).toBeVisible();
  await ctx.close();
});

test('after a reference from the dialog, typing carries on after it; a reference that ends a paragraph can be typed after; Ctrl+H works after a dialog', async ({ browser }) => {
  await putXml(base);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await open(page);
  await text(page, 'Details text.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' See ');
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Insert a reference' }).getByTestId('ref-targets').getByRole('button').filter({ hasText: 'Table 1' }).click();
  await expect(focused(page)).toHaveCount(1);
  await page.keyboard.type('for the limits.');
  // Ctrl+H from the keyboard, right after the dialog closed.
  await page.keyboard.press('Control+h');
  const f = page.getByRole('dialog', { name: 'Find and replace' });
  await expect(f).toBeVisible();
  await f.getByLabel('Find').fill('fan');
  await f.getByLabel('Replace with').fill('blower');
  await f.getByRole('button', { name: 'Replace all' }).click();
  await f.getByRole('button', { name: 'Close' }).click();
  // Nothing focused now: Ctrl+H still opens find.
  await page.keyboard.press('Control+h');
  await expect(f).toBeVisible();
  await page.keyboard.press('Escape');
  await save(page);
  let x = await saved();
  expect(x).toContain('<para>Details text. See <internalRef internalRefId="tab-0001" internalRefTargetType="irtt02"/>for the limits.</para>');
  expect(x).toContain('<para>The blower cools the cabinet.</para>');
  // A reference already at the end of a paragraph: click after it and type.
  await putXml(x.replace('<para>Second paragraph here.</para>', '<para>Second paragraph, see <internalRef internalRefId="tab-0001" internalRefTargetType="irtt02"/></para>'));
  await page.reload();
  // A click to the right of the reference, in the paragraph's empty space.
  const para = view(page).locator('[data-element="para"]').filter({ has: page.getByTestId('ref-pill') }).filter({ hasText: 'Second paragraph' }).locator('div').first();
  await para.scrollIntoViewIfNeeded(); // as a person scrolls to it
  const box = await para.boundingBox();
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
  await expect(focused(page)).toHaveCount(1);
  await page.keyboard.type(' for limits.');
  await save(page);
  x = await saved();
  expect(x).toContain('<para>Second paragraph, see <internalRef internalRefId="tab-0001" internalRefTargetType="irtt02"/> for limits.</para>');
  await expectValid();
  await ctx.close();
});

test('bold from the keyboard on a double-clicked word, then typing goes on after the bold; the caret stays in the page after table tools', async ({ browser }) => {
  await putXml(base);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await open(page);
  await text(page, 'Details text.').dblclick({ position: { x: 8, y: 6 } });
  await page.keyboard.press('Control+b');
  await page.keyboard.type('!');
  await view(page).locator('td').filter({ hasText: /^A$/ }).click();
  await page.getByTestId('tbl-row-below').click();
  await expect(focused(page)).toHaveText('');
  await page.keyboard.type('new row');
  await page.keyboard.press('Tab');
  await page.keyboard.type('next cell');
  await save(page);
  const x = await saved();
  expect(x).toContain('<para><emphasis>Details</emphasis>! text.</para>');
  expect(x).toMatch(/<row><entry><para>new row<\/para><\/entry><entry><para>next cell<\/para><\/entry><entry><para\/><\/entry><\/row>/);
  await expectValid();
  await ctx.close();
});

// ---- found with real modules (decisions.md PV35-PV38) ------------------------------------------

test('a cell range survives a click on the cell\'s padding and the release of Shift, and merges', async ({ browser }) => {
  await putXml(base.replace('<para>A</para>', '<para>Ab</para>'));
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await open(page);
  const td = (t) => view(page).locator('td').filter({ hasText: new RegExp(`^${t}$`) });
  // A click beside the short text of a cell (on its padding), then Shift+click another cell.
  const box = await td('Ab').boundingBox();
  await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4);
  await td('E').click({ modifiers: ['Shift'] });
  await page.waitForTimeout(600);
  await expect(view(page).locator('td[data-in-range="true"]')).toHaveCount(4);
  await expect(page.getByTestId('tbl-merge-range')).toBeEnabled();
  await page.getByTestId('tbl-merge-range').click();
  await save(page);
  expect(await saved()).toMatch(/<entry namest="c1" nameend="c2" morerows="1"><para>Ab<\/para><para>B<\/para><para>D<\/para><para>E<\/para><\/entry>/);
  await expectValid();
  await ctx.close();
});

test('an action that is refused leaves the caret where it was: typing goes on in the same place', async ({ browser }) => {
  await putXml(base);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await open(page);
  // Shift+Tab in a top-level section: refused, with the reason.
  await text(page, 'Second paragraph').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('page-notice')).toContainText('Only a nested section or step can be promoted');
  await expect(focused(page)).toHaveText('Second paragraph here.');
  await page.keyboard.type(' Still typing.');
  await page.keyboard.press('Control+s');
  await expect.poll(saved).toContain('<para>Second paragraph here. Still typing.</para>');
  await ctx.close();
});

test('a data module reference with its issue and title, typed straight after at full speed, lands in order', async ({ browser }) => {
  await putXml(base);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await open(page);
  await text(page, 'Details text.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' See ');
  await page.keyboard.press('Control+k');
  const dlg = page.getByRole('dialog', { name: 'Insert a reference' });
  await dlg.getByRole('tab', { name: 'Data module' }).click();
  await dlg.getByLabel('Technical and information name').check();
  await dlg.getByLabel('Issue').check();
  await dlg.getByLabel('Filter data modules').fill('030A');
  await dlg.getByTestId('ref-modules').getByRole('button').first().click();
  // No pause: the dialog has closed and the caret is back in the text.
  await page.keyboard.type('for the data.');
  await expect(dlg).toHaveCount(0);
  await expect(view(page).getByTestId('ref-pill')).toHaveCount(1);
  await save(page);
  const x = await saved();
  expect(x).toMatch(/<para>Details text\. See <dmRef><dmRefIdent><dmCode [^>]*infoCode="030"[^>]*\/><issueInfo issueNumber="\d{3}" inWork="\d{2}"\/><\/dmRefIdent><dmRefAddressItems><dmTitle><techName>[^<]+<\/techName>(<infoName>[^<]*<\/infoName>)?<\/dmTitle><\/dmRefAddressItems><\/dmRef>for the data\.<\/para>/);
  await expectValid();
  await ctx.close();
});

test('Ctrl+S pressed while a reference\'s issue is still being read saves the issue; the page is not left unsaved; typing goes on in order', async ({ browser }) => {
  await putXml(base);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await open(page);
  // The target module's read is held until after Ctrl+S, so the save certainly comes first.
  let release;
  const gate = new Promise((res) => { release = res; });
  const held = /\/api\/projects\/[\w-]+\/dms\/[0-9a-f-]+$/;
  await page.route(held, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await gate;
    return route.fallback();
  });
  await text(page, 'Details text.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' See ');
  await page.keyboard.press('Control+k');
  const dlg = page.getByRole('dialog', { name: 'Insert a reference' });
  await dlg.getByRole('tab', { name: 'Data module' }).click();
  await dlg.getByLabel('Issue').check();
  await dlg.getByLabel('Filter data modules').fill('030A');
  const read = page.waitForRequest((r) => r.method() === 'GET' && /\/dms\/[0-9a-f-]+$/.test(new URL(r.url()).pathname));
  await dlg.getByTestId('ref-modules').getByRole('button').first().click();
  await read;
  let puts = 0;
  page.on('request', (r) => { if (r.method() === 'PUT' && /\/dms\/[0-9a-f-]+$/.test(new URL(r.url()).pathname)) puts++; });
  const put = page.waitForRequest((r) => r.method() === 'PUT' && /\/dms\/[0-9a-f-]+$/.test(new URL(r.url()).pathname));
  await page.keyboard.press('Control+s');
  await page.keyboard.type('for the data.');
  // Nothing is sent while the issue is being read; then the one save carries it.
  await page.waitForTimeout(300);
  expect(puts).toBe(0);
  release();
  expect((await put).postDataJSON().xml).toMatch(/<dmCode [^>]*infoCode="030"[^>]*\/><issueInfo issueNumber="\d{3}" inWork="\d{2}"\/><\/dmRefIdent>/);
  await expect(page.getByTestId('editor-status')).not.toContainText('unsaved');
  expect(await saved()).toMatch(/<issueInfo issueNumber="\d{3}" inWork="\d{2}"\/><\/dmRefIdent><\/dmRef>/);
  // The caret stayed in the text: what was typed during the save lands after the reference, then saves.
  await expect(focused(page)).toHaveCount(1);
  await page.keyboard.type(' Done.');
  await page.unroute(held);
  await save(page);
  expect(await saved()).toMatch(/<\/dmRef>for the data\. Done\.<\/para>/);
  await expect(page.getByTestId('editor-status')).not.toContainText('unsaved');
  await expectValid();
  await ctx.close();
});

test('symbols in the text are drawn as their artwork (or say it is missing), never as bare tags; an undeclared one is flagged', async ({ browser }) => {
  await putXml(base.replace('<para>Details text.</para>', '<para>Press <symbol infoEntityIdent="ICN-AGS-A-240000-A-0AGS1-00001-A-01-1"/> then <symbol infoEntityIdent="ICN-AGS-A-NOT-THERE-1"/></para>'));
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await open(page);
  await expect(view(page).getByTestId('symbol-image').or(view(page).getByTestId('symbol-missing'))).toHaveCount(2);
  await expect(view(page).getByTestId('symbol-missing')).toHaveCount(1);
  await expect(view(page).getByText('<symbol>', { exact: true })).toHaveCount(0);
  await expect(view(page).locator('[data-check]').filter({ has: page.getByTestId('symbol-missing') })).toHaveAttribute('title', /ICN-AGS-A-NOT-THERE-1 is not declared in the DOCTYPE/);
  // Typing after the last symbol: a click to its right.
  const para = view(page).locator('[data-element="para"]').filter({ hasText: 'Press' }).locator('div').first();
  await para.scrollIntoViewIfNeeded(); // as a person scrolls to it
  const box = await para.boundingBox();
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
  await page.keyboard.type(' twice');
  await save(page);
  expect(await saved()).toContain('then <symbol infoEntityIdent="ICN-AGS-A-NOT-THERE-1"/> twice</para>');
  await ctx.close();
  await putXml(base);
});
