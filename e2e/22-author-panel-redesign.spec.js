'use strict';
// The Author Panel redesign, by mouse and keyboard: the redesigned
// dashboard (View Projects, Recently opened projects), the Workspace page,
// drag-and-drop in the Projects explorer, the central graphics library with
// its thumbnail grid and upload, project backup downloads, and opening a
// project straight into its focused editor workspace with the project menu
// and document switcher. No screenshots are taken.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, signedIn, authorApi } = require('./fixtures');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');

test('dashboard: View Projects opens the Projects page; an opened project appears in Recently opened', async ({ browser }) => {
  const stamp = Date.now();
  const { call } = authorApi();
  const project = (await call('POST', '/api/projects', { name: `Dashboard flow ${stamp}` })).body.project;
  await call('POST', `/api/projects/${project.id}/dms/import`, { filename: 'a.xml', content: fs.readFileSync(path.join(GOLDEN, 'csdb', 'DMC-AGS-A-24-00-00-00A-030A-D.xml'), 'utf8') });

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/');
  await page.getByRole('button', { name: 'View Projects' }).click();
  await expect(page).toHaveURL(/\/projects$/);

  // Open the project (its name): straight into the focused workspace, not the Overview dashboard.
  await page.getByRole('link', { name: `Dashboard flow ${stamp}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/workspace`));
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/dms/`));
  await expect(page.getByTestId('page-view')).toBeVisible();

  // It is now in "Recently opened projects" on the dashboard.
  await page.goto('/');
  const row = page.getByTestId('recently-opened').getByRole('link', { name: new RegExp(`Dashboard flow ${stamp}`) });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('href', `/projects/${project.id}/workspace`);
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('Workspace page: lists, searches, and Open selects the workspace in the Projects explorer', async ({ browser }) => {
  const stamp = Date.now();
  const { call } = authorApi();
  const ws = (await call('POST', '/api/workspaces', { name: `Fleet library ${stamp}` })).body.workspace;

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/workspaces');
  await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`Fleet library ${stamp}`) })).toBeVisible();
  await page.getByLabel('Search workspaces').fill('no such workspace at all');
  await expect(page.getByText('No workspaces match')).toBeVisible();
  await page.getByLabel('Search workspaces').fill(`Fleet library ${stamp}`);
  const row = page.getByRole('row', { name: new RegExp(`Fleet library ${stamp}`) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects\\?ws=${ws.id}`));
  await expect(page.getByTestId('workspace-tree').getByRole('treeitem', { name: new RegExp(`Fleet library ${stamp}`) })).toHaveAttribute('aria-selected', 'true');
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('Projects explorer: dragging a project onto a folder moves it, clearly highlighting the target first', async ({ browser }) => {
  const stamp = Date.now();
  const { call } = authorApi();
  const ws = (await call('POST', '/api/workspaces', { name: `Drag test ${stamp}` })).body.workspace;
  const folder = (await call('POST', `/api/workspaces/${ws.id}/folders`, { name: 'Manuals' })).body.folder;
  const project = (await call('POST', '/api/projects', { name: `Draggable ${stamp}` })).body.project;

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/projects');
  await page.getByTestId('workspace-tree').getByRole('button', { name: 'Not in a workspace' }).click();
  const source = page.getByRole('row', { name: new RegExp(`Draggable ${stamp}`) }).locator('[draggable="true"]');
  const target = page.getByTestId('workspace-tree').getByRole('button', { name: 'Manuals' });
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();

  // A real HTML5 drag: hover shows the drop target highlighted before release.
  const sb = await source.boundingBox();
  const tb = await target.boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 12 });
  await expect(target).toHaveClass(/ring-accent/);
  await page.mouse.up();

  await expect(page.getByText('Project moved')).toBeVisible();
  const moved = (await call('GET', `/api/projects/${project.id}`)).body.project;
  expect(moved.workspaceId).toBe(ws.id);
  expect(moved.folderId).toBe(folder.id);
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('graphics library: ICNs and symbols across projects, search, and upload asks which project first', async ({ browser }) => {
  const stamp = Date.now();
  const { call } = authorApi();
  const project = (await call('POST', '/api/projects', { name: `Graphics flow ${stamp}` })).body.project;
  await call('POST', `/api/projects/${project.id}/dms/import`, { filename: 'a.xml', content: fs.readFileSync(path.join(GOLDEN, 'csdb', 'DMC-AGS-A-24-00-00-00A-040A-D.xml'), 'utf8') });

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/graphics');
  await expect(page.getByRole('heading', { name: 'Graphics' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^ICNs/ })).toBeVisible();
  await expect(page.getByTestId('graphics-grid')).toBeVisible();
  await expect(page.getByText('ICN-AGS-A-240000-A-0AGS1-00001-A-01-1').first()).toBeVisible();
  await page.getByRole('tab', { name: /^Symbols/ }).click();
  await expect(page.getByTestId('graphics-grid').or(page.getByText('No symbols yet'))).toBeVisible();

  await page.getByRole('button', { name: 'Upload graphic' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload a graphic' });
  await expect(dialog.getByLabel('Project')).toBeVisible();
  await dialog.getByLabel('Project').selectOption({ label: `Graphics flow ${stamp}` });
  await dialog.getByLabel('ICN').fill(`ICN-AGS-A-240000-A-0AGS1-0${String(stamp).slice(-4)}-A-01-1`);
  await dialog.getByLabel('Choose image').setInputFiles({ name: 'x.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(GOLDEN, 'csdb', 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1.png')) });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog.getByText('Uploaded')).toBeVisible({ timeout: 15000 });
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('tab', { name: /^ICNs/ }).click();
  await expect(page.getByText(new RegExp(`ICN-AGS-A-240000-A-0AGS1-0${String(stamp).slice(-4)}`))).toBeVisible();
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('backup: a project downloads as a zip; "download all" bundles every visible project', async ({ browser }) => {
  const stamp = Date.now();
  const { call } = authorApi();
  const project = (await call('POST', '/api/projects', { name: `Backup flow ${stamp}` })).body.project;

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/backup');
  await expect(page.getByRole('heading', { name: 'Backup' })).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(`Backup flow ${stamp}`) });
  await expect(row).toBeVisible();
  const [dl1] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: 'Download' }).click()]);
  expect(dl1.suggestedFilename()).toMatch(/^CSDB-Backup_flow_\d+\.zip$/);

  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download all/ }).click()]);
  expect(dl2.suggestedFilename()).toMatch(/^AGASTYA-BACKUP-\d{4}-\d{2}-\d{2}\.zip$/);
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('opening a project goes straight to its editor; the project menu and document switcher work from there', async ({ browser }) => {
  const stamp = Date.now();
  const { call } = authorApi();
  const project = (await call('POST', '/api/projects', { name: `Workspace entry ${stamp}` })).body.project;
  const a = (await call('POST', `/api/projects/${project.id}/dms/import`, { filename: 'a.xml', content: fs.readFileSync(path.join(GOLDEN, 'csdb', 'DMC-AGS-A-24-00-00-00A-030A-D.xml'), 'utf8') })).body.module;
  const b = (await call('POST', `/api/projects/${project.id}/dms/import`, { filename: 'b.xml', content: fs.readFileSync(path.join(GOLDEN, 'csdb', 'DMC-AGS-A-24-00-00-00A-040A-D.xml'), 'utf8') })).body.module;

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${project.id}/workspace`);
  // The most recently edited module (b, imported last): straight into its editor.
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/dms/${b.id}`));
  await expect(page.getByTestId('page-view')).toBeVisible();

  await page.getByRole('tab', { name: 'Graphics' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=graphics`));
  await expect(page.getByTestId('assets-summary')).toBeVisible();

  await page.goBack();
  await expect(page.getByTestId('page-view')).toBeVisible();
  await page.getByLabel('Switch to another data module').selectOption(a.id);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/dms/${a.id}`));
  await expect(page.getByTestId('page-view')).toBeVisible();
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('delete project: archived from the sidebar, shown and restored from the Projects list', async ({ browser }) => {
  const stamp = Date.now();
  const { call } = authorApi();
  const project = (await call('POST', '/api/projects', { name: `Deletable ${stamp}` })).body.project;

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${project.id}`);
  await page.getByTestId('delete-project').click();
  await page.getByRole('dialog', { name: `Delete Deletable ${stamp}?` }).getByRole('button', { name: 'Delete project' }).click();
  await expect(page).toHaveURL(/\/projects$/);

  // Hidden from the active list by default; "Show deleted" brings it back, marked, with Restore in place of Move/Delete.
  await expect(page.getByRole('row', { name: new RegExp(`Deletable ${stamp}`) })).toHaveCount(0);
  await page.getByText('Show deleted').click();
  const row = page.getByRole('row', { name: new RegExp(`Deletable ${stamp}`) });
  await expect(row).toBeVisible();
  await expect(row.getByText('Deleted')).toBeVisible();
  await row.getByRole('button', { name: `Restore Deletable ${stamp}` }).click();
  await page.getByText('Show deleted').click();
  await expect(page.getByRole('row', { name: new RegExp(`Deletable ${stamp}`) })).toBeVisible();
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('delete a graphic from the central library when it is unused', async ({ browser }) => {
  const stamp = Date.now();
  const { call } = authorApi();
  const project = (await call('POST', '/api/projects', { name: `Graphics delete ${stamp}` })).body.project;
  const icn = `ICN-AGS-A-240000-A-0AGS1-0${String(stamp).slice(-4)}-A-01-1`;

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/graphics');
  await page.getByRole('button', { name: 'Upload graphic' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload a graphic' });
  await dialog.getByLabel('Project').selectOption({ label: `Graphics delete ${stamp}` });
  await dialog.getByLabel('ICN').fill(icn);
  await dialog.getByLabel('Choose image').setInputFiles({ name: 'x.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(GOLDEN, 'csdb', 'ICN-AGS-A-240000-A-0AGS1-00001-A-01-1.png')) });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog.getByText('Uploaded')).toBeVisible({ timeout: 15000 });
  await dialog.getByRole('button', { name: 'Done' }).click();

  const card = page.getByText(icn, { exact: true }).locator('xpath=ancestor::div[contains(@class, "group")]');
  await card.hover();
  await card.getByRole('button', { name: `Delete ${icn}` }).click();
  await page.getByRole('dialog', { name: 'Delete this graphic?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(icn)).toHaveCount(0);
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('a JSS project opens straight into the book, side by side with its PDF', async ({ browser }) => {
  const stamp = Date.now();
  const { call } = authorApi();
  const r = await call('POST', '/api/projects', { name: `Book entry ${stamp}`, format: 'jss' });
  expect(r.status).toBe(201);

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.body.project.id}/workspace`);
  await expect(page).toHaveURL(new RegExp(`/projects/${r.body.project.id}/workspace`));
  // The book opens in its Design view by default; the XML view is one click away.
  await expect(page.getByRole('radio', { name: 'Design' })).toBeVisible();
  await page.getByRole('radio', { name: 'XML' }).click();
  await expect(page.getByLabel('Publication module XML')).toBeVisible();
  await expect(page.getByTestId('split-pane')).toHaveAttribute('data-mode', 'split');
  await expect(page.getByRole('heading', { name: `Book entry ${stamp}` })).toBeVisible();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page).toHaveURL(new RegExp(`\\?tab=settings`));
  expect(page.errors).toEqual([]);
  await ctx.close();
});
