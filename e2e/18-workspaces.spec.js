'use strict';
// Workspaces, folders and the project lifecycle in the browser (Phase 6.5,
// decisions.md WS1-WS6), by mouse and keyboard: a workspace with nested
// folders, a project created in a folder with its format and access chosen,
// a move that keeps its content and members, renaming and deleting folders,
// and a member who sees the workspace read-only. No screenshots are taken.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, signedIn, authorApi, freshApi, shots } = require('./fixtures');

test('an Author files projects into nested folders, moves one, and deletes a folder without losing anything', async ({ browser }) => {
  const stamp = Date.now();
  const W = `Fleet ${stamp}`;
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/projects');
  const tree = page.getByTestId('workspace-tree');

  // A workspace, typed and confirmed with Enter.
  await tree.getByRole('button', { name: 'New workspace' }).click();
  let dialog = page.getByRole('dialog', { name: 'New workspace' });
  await dialog.getByLabel('Workspace name').fill(W);
  await dialog.getByLabel('Workspace name').press('Enter');
  await expect(tree.getByRole('button', { name: W })).toBeVisible();

  // Manuals, and Radar inside it.
  await tree.getByRole('button', { name: 'New folder' }).click();
  dialog = page.getByRole('dialog', { name: /New folder in/ });
  await dialog.getByLabel('Folder name').fill('Manuals');
  await dialog.getByRole('button', { name: 'Create folder' }).click();
  await tree.getByRole('button', { name: 'Manuals' }).click();
  await tree.getByRole('button', { name: 'New folder' }).click();
  dialog = page.getByRole('dialog', { name: 'New folder in Manuals' });
  await dialog.getByLabel('Folder name').fill('Radar');
  await dialog.getByRole('button', { name: 'Create folder' }).click();
  await expect(tree.getByRole('button', { name: 'Radar' })).toBeVisible();

  // A project in Radar, S1000D, with Meera given access.
  await tree.getByRole('button', { name: 'Radar' }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog.getByRole('radio', { name: /JSG/ })).toBeDisabled();
  await expect(dialog.getByLabel('Workspace and folder')).toHaveValue(/\|fld-/);
  await dialog.getByLabel('Project name').fill(`Radar manual ${stamp}`);
  await dialog.getByLabel('Give Meera Iyer access').check();
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: new RegExp(`Radar manual ${stamp}`) });
  await expect(row).toContainText(`${W} / Manuals / Radar`);
  await expect(row).toContainText('S1000D');
  const { call } = authorApi();
  const project = (await call('GET', '/api/projects')).body.projects.find((p) => p.name === `Radar manual ${stamp}`);
  await call('POST', `/api/projects/${project.id}/dms/import`, { filename: 'a.xml', content: fs.readFileSync(path.join(__dirname, '..', 'samples', 'golden', 'csdb', 'DMC-AGS-A-24-00-00-00A-030A-D.xml'), 'utf8') });
  await shots(page, 'workspace tree');

  // Move it to the workspace's top level.
  await row.getByRole('button', { name: `Move Radar manual ${stamp}` }).click();
  dialog = page.getByRole('dialog', { name: `Move Radar manual ${stamp}` });
  await dialog.getByLabel('Move to').selectOption({ label: W });
  const movedRes = page.waitForResponse((res) => res.request().method() === 'POST' && /\/move$/.test(res.url()));
  await dialog.getByRole('button', { name: 'Move' }).click();
  const mres = await movedRes;
  expect(mres.status(), `${mres.request().postData()} -> ${await mres.text()}`).toBe(200);
  // It left the Radar folder (still selected in the tree), and shows at the workspace's top level.
  await expect(page.getByRole('row', { name: new RegExp(`Radar manual ${stamp}`) })).toHaveCount(0);
  await tree.getByRole('button', { name: W }).click();
  await expect(page.getByRole('row', { name: new RegExp(`Radar manual ${stamp}`) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`Radar manual ${stamp}`) })).not.toContainText('Manuals');
  const moved = (await call('GET', `/api/projects/${project.id}`)).body;
  expect(moved.authors.map((a) => a.username)).toEqual(['meera.iyer']);
  expect((await call('GET', `/api/projects/${project.id}/dms`)).body.modules).toHaveLength(1);

  // Back into Radar, then delete Manuals: the project and Radar move up, nothing is deleted.
  await call('POST', `/api/projects/${project.id}/move`, { workspaceId: project.workspaceId, folderId: project.folderId });
  await page.reload();
  await tree.getByRole('button', { name: 'Manuals' }).click();
  await tree.getByRole('button', { name: 'Rename' }).click();
  dialog = page.getByRole('dialog', { name: 'Rename folder' });
  await dialog.getByLabel('Folder name').fill('Handbooks');
  await dialog.getByRole('button', { name: 'Rename' }).click();
  await expect(tree.getByRole('button', { name: 'Handbooks' })).toBeVisible();
  await tree.getByRole('button', { name: 'Handbooks' }).click();
  await tree.getByRole('button', { name: 'Delete' }).click();
  dialog = page.getByRole('dialog', { name: 'Delete Handbooks' });
  await dialog.getByLabel('Type the folder name to confirm').fill('handbooks');
  await dialog.getByRole('button', { name: 'Delete folder' }).click();
  await expect(tree.getByRole('button', { name: 'Handbooks' })).toHaveCount(0);
  await expect(tree.getByRole('button', { name: 'Radar' })).toBeVisible();
  await tree.getByRole('button', { name: 'Radar' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`Radar manual ${stamp}`) })).toBeVisible();
  expect((await call('GET', `/api/projects/${project.id}/dms`)).body.modules).toHaveLength(1);
  expect(page.errors).toEqual([]);
  await ctx.close();

  // Meera sees the workspace, read-only, with only the project she is in.
  const m = await signedIn(browser, 'meera.iyer');
  await m.page.goto('/projects');
  const mt = m.page.getByTestId('workspace-tree');
  await expect(mt.getByRole('button', { name: new RegExp(W) })).toContainText('shared');
  await mt.getByRole('button', { name: new RegExp(W) }).click();
  await expect(mt.getByRole('button', { name: 'New folder' })).toHaveCount(0);
  await expect(m.page.getByRole('row', { name: new RegExp(`Radar manual ${stamp}`) })).toBeVisible();
  // Ravi, outside the project, does not see the workspace.
  const ravi = await (await freshApi('ravi.k')).call('GET', '/api/workspaces');
  expect(ravi.body.workspaces.some((w) => w.name === W)).toBe(false);
  await m.ctx.close();
});

test('a new project from an XML file: the format is checked, a mismatch is refused and nothing is created', async ({ browser }) => {
  const stamp = Date.now();
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByRole('radio', { name: /From an XML file/ }).check();
  await dialog.getByRole('radio', { name: /^JSS book/ }).check();
  await dialog.getByLabel('Project name').fill(`Wrong kind ${stamp}`);
  await dialog.getByLabel('Choose the source XML file').setInputFiles({ name: 'dm.xml', mimeType: 'application/xml', buffer: Buffer.from('<?xml version="1.0"?><dmodule><identAndStatusSection/></dmodule>') });
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog.getByRole('alert')).toContainText(/not JSS book|S1000D/);
  const { call } = authorApi();
  expect((await call('GET', '/api/projects')).body.projects.some((p) => p.name === `Wrong kind ${stamp}`)).toBe(false);
  // The right file: a JSS book.
  await dialog.getByLabel('Choose the source XML file').setInputFiles({ name: 'book.xml', mimeType: 'application/xml',
    buffer: Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<jssbook>\n  <bookmeta>\n    <bookName>Generator manual</bookName>\n  </bookmeta>\n  <body><chapter number="1"><title>Generator</title><section><title>General</title><para>The generator supplies 400 Hz power.</para></section></chapter></body>\n</jssbook>\n') });
  await dialog.getByLabel('Project name').fill(`Generator book ${stamp}`);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: new RegExp(`Generator book ${stamp}`) })).toContainText('JSS');
  expect(page.errors).toEqual([]);
  await ctx.close();
});
