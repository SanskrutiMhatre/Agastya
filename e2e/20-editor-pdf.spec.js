'use strict';
// The editor and its PDF side by side (Phase 9, decisions.md SW1-SW4), by
// mouse and keyboard: the divider dragged and moved with the arrow keys, the
// preview built on request and again after each save (never while typing),
// the saved/unsaved state said in the pane, the page of the selection found,
// the PDF alone and back without losing the edit, and a narrow window that
// stacks the panes. No screenshots are taken.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, signedIn, authorApi, appendXml, expectXml, xmlView, shots } = require('./fixtures');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');
const CODE = 'AGS-A-24-00-00-00A-040A-D';
const ICN = 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1';

test('beside the editor: resize, refresh, saved and unsaved, refresh after save, page of the selection, PDF alone', async ({ browser }) => {
  test.setTimeout(300000);
  const { call } = authorApi();
  const project = (await call('POST', '/api/projects', { name: `Side by side ${Date.now()}` })).body.project;
  const dm = (await call('POST', `/api/projects/${project.id}/dms/import`, { filename: 'a.xml', content: fs.readFileSync(path.join(GOLDEN, 'csdb', `DMC-${CODE}.xml`), 'utf8') })).body.module;
  const { r } = authorApi();
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(path.join(GOLDEN, 'csdb', `${ICN}.png`))]), `${ICN}.png`);
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, '.state', 'arjun.das.json'), 'utf8'));
  await fetch(`${r.base}/api/projects/${project.id}/graphics`, { method: 'POST', body: form, headers: { cookie: `agastya_session=${state.cookies[0].value}`, origin: r.base } });

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${project.id}/dms/${dm.id}`);
  await expect(page.getByTestId('page-view')).toBeVisible();
  await page.getByRole('radio', { name: 'Beside' }).click();
  const split = page.getByTestId('split-pane');
  await expect(split).toHaveAttribute('data-mode', 'split');
  const status = page.getByTestId('pdf-status');
  await expect(status).toHaveAttribute('data-state', 'none');

  // Drag the divider to the left with the mouse, then nudge it with the keyboard.
  const sep = page.getByRole('separator', { name: 'Resize the editor and the PDF' });
  const box = await sep.boundingBox();
  const start = Number(await split.getAttribute('data-share'));
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y + 40, { steps: 8 });
  await page.mouse.up();
  const dragged = Number(await split.getAttribute('data-share'));
  expect(dragged).toBeLessThan(start);
  await sep.focus();
  await page.keyboard.press('ArrowRight');
  await expect(sep).toHaveAttribute('aria-valuenow', String(Math.min(75, dragged + 2)));

  // Build on request: the pane shows the saved version.
  await page.getByTestId('pdf-pane').getByRole('button', { name: 'Refresh' }).click();
  await expect(status).toHaveAttribute('data-state', 'current', { timeout: 120000 });
  await expect(page.getByTestId('pdf-pane').locator('iframe')).toBeVisible();
  const first = await status.textContent();

  // Typing: no build, and the pane says the edits are not in it.
  await xmlView(page);
  const builds = [];
  page.on('request', (req) => { if (req.method() === 'POST' && /\/preview$/.test(req.url())) builds.push(req.url()); });
  await appendXml(page, '<!-- side by side -->');
  await expect(status).toHaveAttribute('data-state', 'unsaved');
  await page.waitForTimeout(1500);
  expect(builds).toEqual([]);

  // Save: the preview is rebuilt once, from the new revision.
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  await expect.poll(() => builds.length, { timeout: 30000 }).toBe(1);
  await expect(status).toHaveAttribute('data-state', 'current', { timeout: 120000 });
  expect(await status.textContent()).not.toBe(first);

  // The selection's page: a section in the outline, found in the PDF.
  await page.getByRole('radio', { name: 'Design' }).click();
  await page.getByRole('navigation', { name: 'Document outline' }).getByRole('button', { name: /Function$/ }).first().click();
  await expect(page.getByTestId('pdf-page')).toContainText(/Selection on page \d+ of \d+/, { timeout: 30000 });
  await expect(page.getByTestId('pdf-pane').locator('iframe')).toHaveAttribute('src', /#page=\d+/);
  await shots(page, 'editor beside the PDF');

  // The PDF alone, and back: the editor kept its text.
  await page.getByRole('radio', { name: 'PDF' }).click();
  await expect(split).toHaveAttribute('data-mode', 'right');
  await expect(page.getByTestId('page-view')).toBeHidden();
  await page.getByTestId('pdf-pane').getByRole('button', { name: 'Back to the editor' }).click();
  await expect(page.getByTestId('page-view')).toBeVisible();
  await xmlView(page);
  await expectXml(page, /<!-- side by side -->/);

  // A narrow window: the panes stack, no divider, both usable.
  await page.getByRole('radio', { name: 'Beside' }).click();
  await page.setViewportSize({ width: 820, height: 900 });
  await expect(page.getByRole('separator', { name: 'Resize the editor and the PDF' })).toHaveCount(0);
  await expect(page.getByTestId('pdf-pane')).toBeVisible();
  await expect(page.getByTestId('xml-panel')).toBeVisible();
  expect(page.errors).toEqual([]);
  await ctx.close();
});
