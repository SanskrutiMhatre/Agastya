'use strict';
// Checkpoint 2c through the real UI: the structured, schema-aware document
// view with its inspector, and the Monaco XML panel, alone and side by side.
// Runs on modules the publication does not lock.
const { test, expect, run, signedIn, shots, authorApi, xmlView, xmlValue, appendXml, expectXml, expectEditorReadOnly } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

// The figure module (040A) is placed in the publication: withdraw any pending request so it is editable.
test.beforeAll(async () => {
  const { r, call } = authorApi();
  const list = (await call('GET', `/api/projects/${r.projectId}/requests`)).body.requests;
  for (const q of list.filter((x) => x.status === 'pending')) await call('POST', `/api/requests/${q.id}/withdraw`, {});
  // A module outside the publication (spec 01 creates it; create it when this file runs alone).
  const mods = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules;
  if (!mods.some((x) => x.dmc === 'AGS-A-31-00-00-00A-040A-D')) {
    const dmc = { modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '31', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: '00', disassyCodeVariant: 'A', infoCode: '040', infoCodeVariant: 'A', itemLocationCode: 'D' };
    await call('POST', `/api/projects/${r.projectId}/dms`, { dmc, techName: 'Cooling fan tray', schemaType: 'descript' });
  }
});

async function openModule(page, code) {
  const r = run();
  await page.goto(`/projects/${r.projectId}?tab=dms`);
  await page.getByRole('link', { name: code }).click();
  // The 2c structured view is the "Tags" view since checkpoint 2d (Design, the page, is the default).
  await page.getByRole('radio', { name: 'Tags' }).click();
  await expect(page.getByTestId('structured-view')).toBeVisible();
}
const savedXml = async (code) => {
  const { r, call } = authorApi();
  const m = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules.find((x) => x.dmc === code);
  return (await call('GET', `/api/projects/${r.projectId}/dms/${m.id}`)).body.xml;
};
// Put markup at the start of <description>, whether it is written <description>...</description> or <description/>.
const intoDescription = (xml, markup) => xml.replace(/<description\s*\/>|<description>/, (t) => (t.endsWith('/>') ? `<description>${markup}</description>` : `<description>${markup}`));
const select = (page, path, name) => page.getByTestId(`node-${path}`).getByRole('button', { name: `Select ${name}`, exact: true }).first();

test('document view: the module reads as a document; Split shows the XML beside it', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openModule(page, 'AGS-A-24-00-00-00A-040A-D');
  const view = page.getByTestId('structured-view');
  await expect(view).toContainText('General');
  await expect(view).toContainText('The PDU-200 power distribution unit receives three-phase mains power');
  await expect(view).toContainText('fig-240040-01', { message: 'a reference shows its target' });
  await expect(page.getByTestId('editor-status')).toContainText('4.2/descript');
  await expect(page.getByTestId('inspector')).toContainText('Every element follows its S1000D content model.');
  await shots(page, '60-document-view', { fullPage: false });
  await page.getByRole('radio', { name: 'Split' }).click();
  await expect(page.getByTestId('xml-panel').locator('.view-lines')).toBeVisible();
  await expect(page.getByTestId('structured-view')).toBeVisible();
  await page.waitForTimeout(500);
  await shots(page, '61-split-view', { fullPage: false });
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('document view: text is edited in place and reaches the XML and the saved file', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openModule(page, 'AGS-A-24-00-00-00A-040A-D');
  const text = page.getByTestId('text-1.0.0.1-0');
  await text.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('The PDU-200 unit distributes regulated power to the radar cabinet. Refer to ');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('editor-status')).toContainText('unsaved');
  await page.getByRole('radio', { name: 'Split' }).click();
  await expectXml(page, /<para>The PDU-200 unit distributes regulated power to the radar cabinet\. Refer to <internalRef/);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('A new revision was recorded.')).toBeVisible();
  expect(await savedXml('AGS-A-24-00-00-00A-040A-D')).toContain('<para>The PDU-200 unit distributes regulated power to the radar cabinet. Refer to <internalRef internalRefId="fig-240040-01"');
  await ctx.close();
});

test('inspector: only what the schema allows is offered, at each position', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openModule(page, 'AGS-A-24-00-00-00A-040A-D');
  // After the figure's graphic: another graphic or a legend, nothing else.
  await select(page, '1.0.1.2.1', 'graphic').click();
  const after = page.getByTestId('insert-after');
  await expect(after.locator('option')).toHaveText(['Choose (2)', 'graphic', 'legend']);
  // Inside <content> of a descriptive module, no procedure is ever offered.
  await select(page, '1', 'content').click();
  const inside = page.getByTestId('insert-inside');
  await expect(inside.locator('option', { hasText: 'procedure' })).toHaveCount(0);
  // The figure's title cannot go: the figure needs it.
  await select(page, '1.0.1.2.0', 'title').click();
  await expect(page.getByTestId('inspector').getByRole('button', { name: 'Delete' })).toBeDisabled();
  await shots(page, '62-inspector', { fullPage: false });
  await ctx.close();
});

test('inspector: insert, attributes, inline insert at the cursor, move, delete and undo', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openModule(page, 'AGS-A-24-00-00-00A-030A-D');
  const inspector = page.getByTestId('inspector');
  // Insert a levelledPara after the first one: it comes with a title and a paragraph.
  await select(page, '1.0.0', 'levelledPara').click();
  await page.getByTestId('insert-after').selectOption('levelledPara');
  await expect(page.getByTestId('node-1.0.1')).toHaveAttribute('data-element', 'levelledPara');
  await expect(page.getByTestId('node-1.0.1.0')).toHaveAttribute('data-element', 'title');
  await expect(page.getByTestId('node-1.0.1.1')).toHaveAttribute('data-element', 'para');
  await expect(inspector.getByRole('navigation', { name: 'Element path' })).toContainText('levelledPara');
  // Type its title and paragraph in place.
  await page.getByTestId('text-1.0.1.0-new').click();
  await page.keyboard.type('Added in the document view');
  await page.keyboard.press('Enter');
  await page.getByTestId('text-1.0.1.1-new').click();
  await page.keyboard.type('Turn the selector off before you start.');
  await page.keyboard.press('Enter');
  // An attribute with permitted values from the schema.
  await select(page, '1.0.1.1', 'para').click();
  await inspector.getByLabel('Attribute changeType').selectOption('add');
  // Emphasis at the cursor, after "Turn the ".
  const t = page.getByTestId('text-1.0.1.1-0');
  await t.click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 'Turn the '.length; i++) await page.keyboard.press('ArrowRight');
  await page.getByTestId('insert-caret').selectOption('emphasis');
  await page.getByRole('radio', { name: 'Split' }).click();
  await expectXml(page, /<levelledPara>\s*<title>Added in the document view<\/title>\s*<para changeType="add">Turn the <emphasis\/>selector off before you start\.<\/para>\s*<\/levelledPara>/);
  // Move it up above the original, then back down; delete it; undo the delete.
  await select(page, '1.0.1', 'levelledPara').click();
  await inspector.getByRole('button', { name: 'Move up' }).click();
  await expect(page.getByTestId('node-1.0.0')).toContainText('Added in the document view');
  await inspector.getByRole('button', { name: 'Move down' }).click();
  await expect(page.getByTestId('node-1.0.1')).toContainText('Added in the document view');
  await inspector.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('structured-view')).not.toContainText('Added in the document view');
  await page.getByRole('button', { name: 'Undo the last edit' }).click();
  await expect(page.getByTestId('structured-view')).toContainText('Added in the document view');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('A new revision was recorded.')).toBeVisible();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Valid', { exact: true })).toBeVisible();
  expect(await savedXml('AGS-A-24-00-00-00A-030A-D')).toMatch(/<para changeType="add">Turn the <emphasis\/>selector off/);
  await ctx.close();
});

test('XML panel: schema-aware completion, live sync both ways, and a broken document is reported', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openModule(page, 'AGS-A-24-10-00-00A-310A-D');
  await xmlView(page);
  const text = await xmlValue(page);
  const line = text.split('\n').findIndex((l) => /<mainProcedure>/.test(l)) + 1;
  expect(line).toBeGreaterThan(1);
  // Go to the line after <mainProcedure> and ask for elements.
  await page.getByTestId('xml-panel').locator('.view-lines').click();
  await page.keyboard.press('Control+G');
  await page.keyboard.type(String(line));
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('<');
  const suggest = page.locator('.suggest-widget');
  await expect(suggest).toBeVisible();
  await expect(suggest.locator('.monaco-list-row', { hasText: 'proceduralStep' }).first()).toBeVisible();
  await expect(suggest.locator('.monaco-list-row', { hasText: 'levelledPara' })).toHaveCount(0);
  await shots(page, '63-xml-completion', { fullPage: false });
  await page.keyboard.press('Escape');
  // Typed XML appears in the document view.
  await page.keyboard.type('proceduralStep><para>Step typed in the XML panel</para></proceduralStep>');
  await page.getByRole('radio', { name: 'Tags' }).click();
  await expect(page.getByTestId('structured-view')).toContainText('Step typed in the XML panel');
  // A broken document: the document view says where, the panel marks it.
  await page.getByRole('radio', { name: 'Split' }).click();
  await appendXml(page, '\n<unclosed');
  await expect(page.getByText('The XML cannot be shown as a document')).toBeVisible();
  await expect(page.getByTestId('xml-panel').locator('.squiggly-error').first()).toBeVisible();
  for (let i = 0; i < 6 && await page.getByText('The XML cannot be shown as a document').count(); i++) {
    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(150);
  }
  await expect(page.getByText('The XML cannot be shown as a document')).toHaveCount(0);
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('validation findings become markers in the XML panel, and a finding opens its line', async ({ browser }) => {
  const { r, call } = authorApi();
  const m = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules.find((x) => x.dmc === 'AGS-A-31-00-00-00A-040A-D');
  const g = (await call('GET', `/api/projects/${r.projectId}/dms/${m.id}`)).body;
  expect((await call('PUT', `/api/projects/${r.projectId}/dms/${m.id}`, { xml: intoDescription(g.xml, '<bogusElement/>'), baseRevision: g.revision })).status).toBe(200);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await openModule(page, 'AGS-A-31-00-00-00A-040A-D');
  await expect(page.getByTestId('model-problems')).toContainText('<bogusElement> is not allowed here in <description>');
  await page.getByRole('button', { name: 'Validate' }).click();
  await page.getByRole('button', { name: /XSD L\d+/ }).first().click();
  await expect(page.getByRole('radio', { name: 'Split' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('xml-panel').locator('.squiggly-error').first()).toBeVisible();
  await shots(page, '64-validation-markers', { fullPage: false });
  // Put it right through the inspector: select the stray element and delete it.
  await select(page, '1.0.0', 'bogusElement').click();
  await page.getByTestId('inspector').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('inspector')).toContainText('Every element follows its S1000D content model.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('A new revision was recorded.')).toBeVisible();
  await ctx.close();
});

test('content that looks like markup is shown as text in both views, never run', async ({ browser }) => {
  const { r, call } = authorApi();
  const m = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules.find((x) => x.dmc === 'AGS-A-31-00-00-00A-040A-D');
  const g = (await call('GET', `/api/projects/${r.projectId}/dms/${m.id}`)).body;
  const hostile = '<para>&lt;img src=x onerror="window.__pwned=1"&gt; &lt;script&gt;window.__pwned=2&lt;/script&gt;</para><!-- <script>window.__pwned=3</script> -->';
  expect((await call('PUT', `/api/projects/${r.projectId}/dms/${m.id}`, { xml: intoDescription(g.xml, hostile), baseRevision: g.revision })).status).toBe(200);
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs++; d.dismiss(); });
  await openModule(page, 'AGS-A-31-00-00-00A-040A-D');
  await expect(page.getByTestId('structured-view')).toContainText('<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script>');
  await page.getByRole('radio', { name: 'Split' }).click();
  await expectXml(page, /&lt;script&gt;/);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator('[data-testid="structured-view"] img, [data-testid="structured-view"] script').count()).toBe(0);
  expect(dialogs).toBe(0);
  await ctx.close();
});

test('read-only: a Project Manager reads the structured view but cannot change anything', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto(`/projects/${r.managedId}?tab=dms`);
  await page.getByRole('link', { name: 'AGS-A-24-00-00-00A-040A-D' }).click();
  await page.getByRole('radio', { name: 'Tags' }).click();
  await expect(page.getByTestId('structured-view')).toContainText('General');
  await select(page, '1.0.0', 'levelledPara').click();
  await expect(page.getByTestId('insert-after')).toHaveCount(0);
  await expect(page.getByTestId('inspector').getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expectEditorReadOnly(page);
  await ctx.close();
});
