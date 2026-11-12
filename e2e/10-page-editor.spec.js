'use strict';
// Checkpoint 2d through the real UI: the page view ("Design") of the data
// module editor. The page as it reads (numbering, boxes, figures with their
// artwork, tables, references), editing in place with nothing else in the
// file changed, formats, schema-aware insertion, references, figures, tables,
// lists, the outline, validation feedback, drafts, Ctrl+S while typing, two
// tabs, the lock, read-only roles, the administrator's editing session, an
// Author outside the project, paste and markup safety, and content the view
// does not model kept exactly. No screenshots are taken.
const { test, expect, run, signedIn, shots, authorApi, apiAs, ensurePending, expectEditorReadOnly } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

const CODE = 'AGS-A-32-00-00-00A-040A-D';
const ICN = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';
const BODY = `
        <levelledPara id="par-0001">
          <title>Overview</title>
          <para>Start text for the page view.</para>
          <para>Second paragraph.</para>
          <figure id="fig-0001">
            <title>Fan tray</title>
            <graphic infoEntityIdent="${ICN}"/>
          </figure>
          <table id="tab-0001">
            <title>Limits</title>
            <tgroup cols="2">
              <colspec colname="c1"/>
              <colspec colname="c2"/>
              <thead><row><entry><para>Item</para></entry><entry><para>Value</para></entry></row></thead>
              <tbody><row><entry><para>Speed</para></entry><entry><para>1200</para></entry></row></tbody>
            </tgroup>
          </table>
          <para>See <internalRef internalRefId="fig-0001" internalRefTargetType="irtt01"/> and <internalRef internalRefId="tab-0001" internalRefTargetType="irtt02"/>.</para>
          <levelledPara>
            <title>Details</title>
            <para>Nested text.</para>
          </levelledPara>
        </levelledPara>
      `;
let moduleId;
let baseXml;

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
const withBody = (xml, body) => xml.replace(/<description\s*\/>|<description>[\s\S]*?<\/description>/, `<description>${body}</description>`);
// A graphic's ICN is declared in the DOCTYPE, as in every real module (and as the page view's figure dialog does).
const withDoctype = (xml) => (/<!DOCTYPE/.test(xml) ? xml : xml.replace(/^(<\?xml[^>]*\?>\s*)?/, (d) => `${d || ''}<!DOCTYPE dmodule [\n<!NOTATION png SYSTEM "png">\n<!ENTITY ${ICN} SYSTEM "${ICN}.png" NDATA png>\n]>\n`));

async function openDesign(page, code = CODE, project = run().projectId) {
  await page.goto(`/projects/${project}?tab=dms`);
  await page.getByRole('link', { name: code }).click();
  await expect(page.getByRole('radio', { name: 'Design' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('page-view')).toBeVisible();
}
const run_ = (page, text) => page.getByTestId('page-view').getByRole('textbox').filter({ hasText: text }).first();
// Put a selection inside a text run, as a mouse drag would.
async function selectIn(locator, from, to) {
  await locator.evaluate((el, [a, b]) => {
    el.focus();
    const t = el.firstChild;
    const r = document.createRange();
    r.setStart(t, a); r.setEnd(t, b);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, [from, to]);
}
async function caretAtEnd(locator) {
  await locator.evaluate((el) => {
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}
// Save, and wait for the server's answer (a toast from an earlier save may still be on screen).
const putDone = (page) => page.waitForResponse((r) => r.request().method() === 'PUT' && /\/dms\/[0-9a-f-]+$/.test(new URL(r.url()).pathname));
async function save(page) {
  const done = putDone(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await done).status()).toBe(200);
}
async function ctrlS(page) {
  const done = putDone(page);
  await page.keyboard.press('Control+s');
  expect((await done).status()).toBe(200);
}

test.beforeAll(async () => {
  const { r, call } = api();
  // Nothing pending on the project, so modules are editable.
  for (const q of (await call('GET', `/api/projects/${r.projectId}/requests`)).body.requests.filter((x) => x.status === 'pending')) await call('POST', `/api/requests/${q.id}/withdraw`, {});
  const mods = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules;
  if (!mods.some((x) => x.dmc === CODE)) {
    const dmc = { modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '32', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: '00', disassyCodeVariant: 'A', infoCode: '040', infoCodeVariant: 'A', itemLocationCode: 'D' };
    expect((await call('POST', `/api/projects/${r.projectId}/dms`, { dmc, techName: 'Fan tray', infoName: 'Description', schemaType: 'descript' })).status).toBe(201);
  }
  const g = await getModule();
  moduleId = g.m.id;
  await putXml(withBody(withDoctype(g.xml), BODY));
  baseXml = await savedXml(CODE);
  // The starting point is schema-valid, so the edits below can be checked to keep it so.
  const v = await call('POST', `/api/projects/${r.projectId}/dms/${moduleId}/validate`, { xml: baseXml });
  expect(v.body.findings.filter((f) => f.sev === 'error' && f.kind !== 'brex'), JSON.stringify(v.body.findings)).toEqual([]);
});

test('the page reads like the publication: numbering, figure artwork, table, reference labels, outline', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  const view = page.getByTestId('page-view');
  await expect(page.getByTestId('page-ident')).toContainText(`DMC-${CODE}`);
  await expect(view.locator('[data-element="levelledPara"]').first()).toContainText('1Overview');
  await expect(view.getByText('1.1', { exact: true })).toBeVisible();
  await expect(view.locator('[data-element="figure"]').getByText('Fig 1', { exact: true })).toBeVisible();
  await expect(view.locator('[data-element="table"]').getByText('Table 1', { exact: true })).toBeVisible();
  const img = view.getByTestId('figure-image');
  await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth > 0), { timeout: 15000 }).toBe(true);
  await expect(view.locator('table thead th')).toHaveCount(2);
  await expect(view.locator('table tbody td')).toHaveCount(2);
  await expect(view.getByTestId('ref-pill')).toHaveText(['Fig 1', 'Table 1']);
  // The outline moves around the module.
  const outline = page.getByTestId('outline');
  await expect(outline).toContainText('Para 1');
  await expect(outline).toContainText('Para 1.1');
  await outline.getByRole('button', { name: /Table 1/ }).click();
  await expect(page.getByRole('navigation', { name: 'Element path' })).toContainText('table');
  // A reference pill selects; a double click goes to its target.
  await view.getByTestId('ref-pill').first().dblclick();
  await expect(page.getByRole('navigation', { name: 'Element path' })).toContainText('figure');
  // The other views show the same module.
  await page.getByRole('radio', { name: 'Tags' }).click();
  await expect(page.getByTestId('structured-view')).toContainText('Start text for the page view.');
  await page.getByRole('radio', { name: 'Design' }).click();
  await page.getByRole('radio', { name: 'Split' }).click();
  await expect(page.getByTestId('page-view')).toBeVisible();
  await expect(page.getByTestId('xml-panel')).toBeVisible();
  await page.getByRole('radio', { name: 'Design' }).click();
  await shots(page, 'page view');
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('editing text in place changes only that text in the saved file', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  const t = run_(page, 'Second paragraph.');
  await t.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Added in Design.');
  await page.getByTestId('page-view').getByText('Overview').click();
  await expect(page.getByTestId('editor-status')).toContainText('unsaved');
  await save(page);
  const after = await savedXml(CODE);
  expect(after).toBe(baseXml.replace('<para>Second paragraph.</para>', '<para>Second paragraph. Added in Design.</para>'));
  baseXml = after;
  await ctx.close();
});

test('formats apply to the selected characters only; clearing a format unwraps it', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  const t = run_(page, 'Start text for the page view.');
  await expect(page.getByTestId('fmt-bold')).toBeDisabled();
  await selectIn(t, 0, 5);
  await expect(page.getByTestId('fmt-bold')).toBeEnabled();
  await page.getByTestId('fmt-bold').click();
  await expect(page.getByTestId('page-view').locator('[title="<emphasis>"]').first()).toHaveText('Start');
  await selectIn(run_(page, ' text for the page view.'), 1, 5);
  await page.getByTestId('fmt-italic').click();
  await save(page);
  let xml = await savedXml(CODE);
  // The run after the bold is " text for the page view.": characters 1 to 5 are "text".
  expect(xml).toContain('<para><emphasis>Start</emphasis> <emphasis emphasisType="em02">text</emphasis> for the page view.</para>');
  // Clear the bold.
  await page.getByTestId('page-view').locator('[title="<emphasis>"]').first().click();
  await page.getByTestId('fmt-clear').click();
  await save(page);
  xml = await savedXml(CODE);
  expect(xml).toContain('<para>Start <emphasis emphasisType="em02">text</emphasis> for the page view.</para>');
  await ctx.close();
});

test('insertion offers only what the schema allows; Enter makes the next paragraph; "/" opens the palette', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  // Palette after a paragraph: blocks of a description, never procedural steps.
  await run_(page, 'Nested text.').click();
  await page.getByTestId('tool-insert').click();
  const options = page.getByTestId('insert-options');
  await expect(options).toContainText('<note>');
  await expect(options).toContainText('<emphasis>');
  await expect(options).not.toContainText('<proceduralStep>');
  await page.getByLabel('Filter elements').fill('zzz-nothing');
  await expect(options).toContainText('Nothing matches.');
  await page.getByLabel('Filter elements').fill('note');
  await options.getByRole('button').filter({ hasText: /^<note>after <para>$/ }).click();
  await expect(page.getByTestId('page-view').locator('aside').filter({ hasText: 'NOTE' })).toBeVisible();
  // The keyboard: filter, Enter takes the first (here the only) choice.
  await run_(page, 'Nested text.').click();
  await page.getByTestId('tool-insert').click();
  await page.getByLabel('Filter elements').fill('warning');
  await expect(options.getByRole('option').first()).toContainText('<warning>');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('page-view').locator('aside').filter({ hasText: 'WARNING' })).toBeVisible();
  // Enter at the end of a paragraph: a new one, with the caret in it; "/" there opens the palette.
  const last = run_(page, 'Nested text.');
  await last.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-run]:focus')).toHaveCount(1);
  await page.keyboard.type('Typed after Enter.');
  // Ctrl+S while still typing saves what was typed.
  await ctrlS(page);
  const xml = await savedXml(CODE);
  expect(xml).toMatch(/<para>Nested text\.<\/para>\s*<para>Typed after Enter\.<\/para>/);
  expect(xml).toMatch(/<note><notePara\/><\/note>/);
  expect(xml).toMatch(/<warning><warningAndCautionPara\/><\/warning>/);
  // "/" in an empty line opens the palette there.
  await page.getByTestId('page-view').locator('aside').filter({ hasText: 'NOTE' }).getByRole('textbox').click();
  await page.keyboard.press('/');
  await expect(page.getByRole('dialog', { name: 'Insert' })).toBeVisible();
  await expect(page.getByTestId('insert-options')).toContainText('at the cursor');
  await page.keyboard.press('Escape');
  await ctx.close();
});

test('references to a figure, a table, another data module and an external publication', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  await caretAtEnd(run_(page, 'Second paragraph'));
  await page.getByTestId('tool-reference').click();
  const dlg = page.getByRole('dialog', { name: 'Insert a reference' });
  await dlg.getByTestId('ref-targets').getByRole('button', { name: /Table 1/ }).click();
  await expect(page.getByTestId('ref-pill').filter({ hasText: 'Table 1' })).toHaveCount(2);
  await caretAtEnd(run_(page, 'Second paragraph'));
  await page.getByTestId('tool-reference').click();
  await dlg.getByRole('tab', { name: 'Data module' }).click();
  await dlg.getByLabel('Filter data modules').fill('520A');
  await dlg.getByTestId('ref-modules').getByRole('button').first().click();
  await expect(page.getByTestId('ref-pill').filter({ hasText: 'DMC-AGS-A-24-10-00-00A-520A-D' })).toBeVisible();
  await caretAtEnd(run_(page, 'Second paragraph'));
  await page.getByTestId('tool-reference').click();
  await dlg.getByRole('tab', { name: 'External publication' }).click();
  await dlg.getByLabel('Publication code').fill('AMM-24');
  await dlg.getByLabel('Title').fill('Aircraft maintenance manual');
  await dlg.getByRole('button', { name: 'Insert reference' }).click();
  await expect(page.getByTestId('ref-pill').filter({ hasText: 'Aircraft maintenance manual' })).toBeVisible();
  await save(page);
  const xml = await savedXml(CODE);
  expect(xml).toContain('<internalRef internalRefId="tab-0001" internalRefTargetType="irtt02"/>');
  expect(xml).toMatch(/<dmRef><dmRefIdent><dmCode modelIdentCode="AGS" systemDiffCode="A" systemCode="24" subSystemCode="1" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="520" infoCodeVariant="A" itemLocationCode="D"\/><\/dmRefIdent><\/dmRef>/);
  expect(xml).toContain('<externalPubRef><externalPubRefIdent><externalPubCode>AMM-24</externalPubCode><externalPubTitle>Aircraft maintenance manual</externalPubTitle></externalPubRefIdent></externalPubRef>');
  await ctx.close();
});

test('a figure from the project\'s artwork and a table; table rows and columns change; bad table sizes are refused', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  await run_(page, 'Nested text.').click();
  await page.getByTestId('tool-figure').click();
  const fig = page.getByRole('dialog', { name: 'Insert a figure' });
  await fig.getByRole('button', { name: 'Insert figure' }).click();
  await expect(fig.getByText('Choose artwork, or upload an image.')).toBeVisible();
  await fig.getByLabel('Title').fill('Fan detail');
  await fig.getByLabel('Artwork in this project').selectOption(ICN);
  await fig.getByRole('button', { name: 'Insert figure' }).click();
  await expect(page.getByTestId('page-view').locator('[data-element="figure"]').getByText('Fig 2', { exact: true })).toBeVisible();
  await expect(page.getByTestId('figure-image')).toHaveCount(2);

  await run_(page, 'Nested text.').click();
  await page.getByTestId('tool-table').click();
  const tbl = page.getByRole('dialog', { name: 'Insert a table' });
  await tbl.getByLabel('Rows').fill('0');
  await expect(tbl.getByText('Between 1 and 100 rows')).toBeVisible();
  await expect(tbl.getByRole('button', { name: 'Insert table' })).toBeDisabled();
  await tbl.getByLabel('Rows').fill('2');
  await tbl.getByLabel('Columns').fill('2');
  await tbl.getByLabel(/Title/).fill('Settings');
  await tbl.getByRole('button', { name: 'Insert table' }).click();
  const newTable = page.getByTestId('page-view').locator('table').nth(1);
  await expect(newTable.locator('th')).toHaveCount(2);
  await expect(newTable.locator('tbody tr')).toHaveCount(2);
  await newTable.locator('tbody td').first().click();
  await page.getByTestId('tbl-row-below').click();
  await expect(newTable.locator('tbody tr')).toHaveCount(3);
  await newTable.locator('tbody td').first().click();
  await page.getByTestId('tbl-col-right').click();
  await expect(newTable.locator('th')).toHaveCount(3);
  await newTable.locator('tbody td').first().click();
  await page.getByTestId('tbl-col-delete').click();
  await expect(newTable.locator('th')).toHaveCount(2);
  await save(page);
  const xml = await savedXml(CODE);
  expect(xml).toMatch(/<figure id="fig-0002"><title>Fan detail<\/title><graphic infoEntityIdent="ICN-AGS-A-240000-A-0AGS1-00001-A-01-1"\/><\/figure>/);
  expect(xml).toMatch(/<table id="tab-0002"><title>Settings<\/title><tgroup cols="2">/);
  await ctx.close();
});

test('lists: a bulleted list in a paragraph, items added, indented and outdented', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  await caretAtEnd(run_(page, 'Nested text.'));
  await page.getByTestId('tool-ulist').click();
  const list = page.getByTestId('page-view').locator('ul').first();
  await expect(list.locator('li')).toHaveCount(2);
  await page.keyboard.type('First item');
  await list.locator('li').nth(1).getByRole('textbox').click();
  await page.keyboard.type('Second item');
  await page.getByTestId('page-view').getByText('Overview').click();
  await list.locator('li').nth(1).getByRole('textbox').click();
  await page.getByTestId('list-indent').click();
  await expect(list.locator('ul li')).toHaveCount(1);
  await save(page);
  let xml = await savedXml(CODE);
  expect(xml).toMatch(/<randomList><listItem><para>First item<randomList><listItem><para>Second item<\/para><\/listItem><\/randomList><\/para><\/listItem><\/randomList>/);
  await page.getByTestId('page-view').locator('ul ul li').getByRole('textbox').click();
  await page.getByTestId('list-outdent').click();
  await page.getByTestId('page-view').locator('ul li').last().getByRole('textbox').click();
  await page.getByTestId('list-add').click();
  await expect(page.getByTestId('page-view').locator('ul').first().locator('li')).toHaveCount(3);
  await save(page);
  xml = await savedXml(CODE);
  expect(xml).toMatch(/<listItem><para>First item<\/para><\/listItem><listItem><para>Second item<\/para><\/listItem><listItem><para\/><\/listItem>/);
  await ctx.close();
});

test('everything edited in the page view is still schema-valid S1000D', async () => {
  const { r, call } = api();
  const xml = await savedXml(CODE);
  const v = await call('POST', `/api/projects/${r.projectId}/dms/${moduleId}/validate`, { xml });
  expect(v.body.findings.filter((f) => f.sev === 'error' && f.kind !== 'brex'), JSON.stringify(v.body.findings)).toEqual([]);
});

test('validation feedback: a content-model problem is outlined where it is; a finding selects its element', async ({ browser }) => {
  await putXml(withBody(await savedXml(CODE), `${BODY}<figure id="fig-0099"><title>No artwork</title></figure>`));
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  const problem = page.getByTestId('page-view').locator('[data-problem]').filter({ hasText: 'needs' });
  await expect(problem.first()).toContainText('<figure> is incomplete');
  await page.getByRole('button', { name: 'Validate' }).click();
  const finding = page.locator('button').filter({ hasText: /^XSDL\d+/ }).first();
  await expect(finding).toBeVisible({ timeout: 30000 });
  await finding.click();
  await expect(page.getByRole('navigation', { name: 'Element path' })).toContainText('figure');
  await ctx.close();
  await putXml(withBody(await savedXml(CODE), BODY));
});

test('drafts: unsaved page edits are autosaved and offered back after a reload', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  await run_(page, 'Nested text.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Draft words.');
  await page.getByTestId('page-view').getByText('Overview').click();
  await expect(page.getByTestId('editor-status')).toContainText('draft autosaved', { timeout: 10000 });
  page.on('dialog', (d) => d.accept());
  await page.reload();
  await expect(page.getByText('You have an unsaved draft of this module')).toBeVisible();
  await page.getByRole('button', { name: 'Restore draft' }).click();
  await expect(run_(page, 'Nested text. Draft words.')).toBeVisible();
  await save(page);
  expect(await savedXml(CODE)).toContain('<para>Nested text. Draft words.</para>');
  await ctx.close();
});

test('two tabs: the page view is told of the other tab\'s save, and its own stale save is refused', async ({ browser }) => {
  const { ctx, page: tab1 } = await signedIn(browser, 'arjun.das');
  const tab2 = await ctx.newPage();
  for (const p of [tab1, tab2]) await openDesign(p);
  await run_(tab2, 'Second paragraph').click();
  await tab2.keyboard.press('End');
  await tab2.keyboard.type(' from tab two');
  await tab2.getByTestId('page-view').getByText('Overview').click();
  await run_(tab1, 'Second paragraph').click();
  await tab1.keyboard.press('End');
  await tab1.keyboard.type(' from tab one');
  await ctrlS(tab1);
  await expect(tab2.getByText(/saved a newer version/)).toBeVisible();
  await tab2.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(tab2.getByRole('dialog', { name: 'Someone else saved this module' })).toBeVisible();
  expect(await savedXml(CODE)).toContain('from tab one');
  expect(await savedXml(CODE)).not.toContain('from tab two');
  await ctx.close();
});

test('read-only: a Project Manager, the administrator without an editing session, and a locked module', async ({ browser }) => {
  const r = run();
  const pm = await signedIn(browser, 'priya.rao');
  await openDesign(pm.page, 'AGS-A-24-00-00-00A-040A-D', r.managedId);
  await expect(pm.page.getByTestId('page-toolbar')).toHaveCount(0);
  await expect(pm.page.getByTestId('page-view').locator('[contenteditable="plaintext-only"]')).toHaveCount(0);
  await expectEditorReadOnly(pm.page);
  await pm.ctx.close();

  const ad = await signedIn(browser, 'admin');
  await openDesign(ad.page);
  await expect(ad.page.getByTestId('override-offer')).toBeVisible();
  await expect(ad.page.getByTestId('page-toolbar')).toHaveCount(0);
  await expect(ad.page.getByTestId('page-view').locator('[contenteditable="plaintext-only"]')).toHaveCount(0);
  await ad.ctx.close();

  // A module frozen in a pending request is read-only for the Authors.
  const req = await ensurePending();
  const au = await signedIn(browser, 'meera.iyer');
  await openDesign(au.page, 'AGS-A-24-10-00-00A-520A-D');
  await expect(au.page.getByTestId('lock-banner')).toContainText('Locked: pending approval');
  await expect(au.page.getByTestId('page-toolbar')).toHaveCount(0);
  await expect(au.page.getByTestId('page-view').locator('[contenteditable="plaintext-only"]')).toHaveCount(0);
  await au.ctx.close();
  await api().call('POST', `/api/requests/${req.id}/withdraw`, {});
});

test('the administrator edits in the page view inside an editing session with a reason', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'admin');
  await openDesign(page);
  await page.getByRole('button', { name: 'Edit as administrator' }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit this data module as administrator' });
  await dlg.getByLabel('Reason for this override').fill('Correcting the overview wording for the audit.');
  await dlg.getByRole('button', { name: 'Start editing' }).click();
  await expect(page.getByTestId('override-bar')).toBeVisible();
  await expect(page.getByTestId('page-toolbar')).toBeVisible();
  await run_(page, 'Nested text.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Admin note.');
  await ctrlS(page);
  expect(await savedXml(CODE)).toContain('Admin note.');
  const audit = await apiAs('admin').call('GET', '/api/admin/audit?action=admin.override');
  expect(audit.body.entries[0].details.reason).toBe('Correcting the overview wording for the audit.');
  await ctx.close();
});

test('an Author who is not on the project reaches neither the page nor the module', async ({ browser }) => {
  const r = run();
  // A fresh sign-in: the saved session of this account is ended by the session scenario of spec 08.
  const ctx = await browser.newContext({ baseURL: r.base });
  const page = await ctx.newPage();
  const login = await page.request.post('/api/auth/login', { data: { username: 'ravi.k', password: r.accounts['ravi.k'].password }, headers: { origin: r.base } });
  expect(login.status()).toBe(200);
  await page.goto(`/projects/${r.projectId}/dms/${moduleId}`);
  await expect(page.getByText('Data module not found')).toBeVisible();
  await expect(page.getByTestId('page-view')).toHaveCount(0);
  expect((await page.request.get(`/api/projects/${r.projectId}/dms/${moduleId}`)).status()).toBe(404);
  expect((await page.request.put(`/api/projects/${r.projectId}/dms/${moduleId}`, { data: { xml: '<dmodule/>', baseRevision: 1 } })).status()).toBe(404);
  await ctx.close();
});

test('safety: markup in text is shown as text, and a paste brings plain text only', async ({ browser }) => {
  await putXml(withBody(await savedXml(CODE), `${BODY}<para>&lt;img src=x onerror="window.__pwned=1"&gt; &lt;script&gt;window.__pwned=2&lt;/script&gt;</para>`));
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs++; d.dismiss(); });
  await openDesign(page);
  const view = page.getByTestId('page-view');
  await expect(view).toContainText('<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script>');
  expect(await view.locator('img:not([data-testid="figure-image"]), script').count()).toBe(0);
  const t = run_(page, 'Second paragraph');
  await caretAtEnd(t);
  await t.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', ' pasted words');
    dt.setData('text/html', '<b>bold</b><img src=x onerror="window.__pwned=3">');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(t).toContainText('pasted words');
  expect(await t.locator('b, img').count()).toBe(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(dialogs).toBe(0);
  await ctx.close();
  await putXml(withBody(await savedXml(CODE), BODY));
});

test('content the page view does not model is shown locked and saved exactly as it was', async ({ browser }) => {
  const odd = `${BODY}<para>Keep <!-- a comment --> this<?agastya-pi keep="yes"?> &#x2013; &#176;C</para>`;
  await putXml(withBody(await savedXml(CODE), odd));
  const before = await savedXml(CODE);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openDesign(page);
  const view = page.getByTestId('page-view');
  await expect(view.getByText('comment', { exact: true })).toBeVisible();
  await expect(view.getByText('<?agastya-pi?>', { exact: true })).toBeVisible();
  await run_(page, 'Nested text').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' changed');
  await ctrlS(page);
  const after = await savedXml(CODE);
  expect(after).toBe(before.replace(/<para>Nested text\.([^<]*)<\/para>/, (m, rest) => `<para>Nested text.${rest} changed</para>`));
  expect(after).toContain('<para>Keep <!-- a comment --> this<?agastya-pi keep="yes"?> &#x2013; &#176;C</para>');
  await ctx.close();
});
