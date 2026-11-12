'use strict';
// Regression of Phase 1 and checkpoint 2a through the real UI: sign-in,
// role dashboards and navigation, users, and the 2a content screens.
const { test, expect, run, signedIn, shots } = require('./fixtures');

test('sign-in: a wrong password is refused neutrally; the right one opens the Author dashboard', async ({ browser }) => {
  const r = run();
  const ctx = await browser.newContext({ baseURL: r.base });
  const page = await ctx.newPage();
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Username').fill('sign.in');
  await page.getByLabel('Password', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText(/username or password/i);
  await page.getByLabel('Password', { exact: true }).fill(r.accounts['sign.in'].password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Sana' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Users' })).toHaveCount(0);
  await ctx.close();
});

test('administrator: dashboard and user directory', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'admin');
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Users' })).toBeVisible();
  await page.goto('/users');
  await expect(page.getByRole('cell', { name: /priya\.rao/ }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: /arjun\.das/ }).first()).toBeVisible();
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('Project Manager: dashboard, own project listed, no authoring navigation', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your projects and team' })).toBeVisible();
  await expect(page.getByText('Managed manual').first()).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Data modules' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Authors' })).toBeVisible();
  await ctx.close();
});

test('checkpoint 2a: data modules list, SNS tree, validation and graphics', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.projectId}?tab=dms`);
  await expect(page.getByRole('link', { name: 'AGS-A-24-10-00-00A-520A-D' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Standard numbering system' })).toContainText('All modules');
  await page.getByRole('link', { name: 'AGS-A-24-00-00-00A-040A-D' }).click();
  // The editor opens on the page view (Design) since checkpoint 2d.
  await expect(page.getByTestId('page-view')).toBeVisible();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Valid', { exact: true })).toBeVisible();
  await page.goto(`/projects/${r.projectId}?tab=graphics`);
  await expect(page.getByText('ICN-AGS-A-240000-A-0AGS1-00001-A-01-1').first()).toBeVisible();
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('checkpoint 2a: create a data module from a shell', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.projectId}?tab=dms`);
  await page.getByRole('button', { name: 'New data module' }).click();
  const dialog = page.getByRole('dialog', { name: 'New data module' });
  await dialog.getByLabel(/^System \(/).fill('31');
  await dialog.getByLabel('Technical name').fill('Cooling fan tray');
  await dialog.getByRole('button', { name: 'Create data module' }).click();
  await expect(page.getByRole('link', { name: 'AGS-A-31-00-00-00A-040A-D' })).toBeVisible();
  await ctx.close();
});

test('earlier screens render in light and dark', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'arjun.das');
  await page.goto(`/projects/${r.projectId}?tab=dms`);
  await expect(page.getByRole('link', { name: 'AGS-A-24-10-00-00A-520A-D' })).toBeVisible();
  await shots(page, '10-data-modules');
  await ctx.close();
});
