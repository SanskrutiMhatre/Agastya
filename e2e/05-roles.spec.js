'use strict';
// Role scenarios for checkpoint 2b: the Project Manager reads and builds only
// and hears about requests; the administrator oversees without writing; an
// Author not on the project sees nothing of it; a co-author edits but cannot
// withdraw someone else's request.
const { test, expect, run, signedIn, shots, ensurePending, expectEditorReadOnly } = require('./fixtures');

// Make sure the Author's publication has a pending request (when this file runs on its own).
test.beforeAll(async () => { await ensurePending(); });

test('Project Manager: notified of the request; reads and builds the managed project but cannot edit it', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto('/');
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByText(/Approval requested/).first()).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto(`/projects/${r.managedId}?tab=dms`);
  await expect(page.getByRole('link', { name: 'AGS-A-24-00-00-00A-040A-D' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New data module' })).toHaveCount(0);
  await page.getByRole('link', { name: 'AGS-A-24-00-00-00A-040A-D' }).click();
  await expect(page.getByText('You can read this data module but not edit it.')).toBeVisible();
  await expectEditorReadOnly(page);

  await page.goto(`/projects/${r.managedId}?tab=publication`);
  await expect(page.getByRole('tree', { name: 'Publication chapters' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add chapter' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Save publication|Saved/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
  await expect(page.getByLabel('Authority line')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Build PDF' })).toBeVisible();
  await shots(page, '40-manager-publication-read-only');
  expect(page.errors).toEqual([]);

  // The Author's own project stays invisible to the manager, request or not.
  await page.goto(`/projects/${r.projectId}?tab=publication`);
  await expect(page.getByText('Project not found')).toBeVisible();
  await ctx.close();
});

test('administrator: oversight of the Author\'s project, read-only, no submission', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'admin');
  await page.goto(`/projects/${r.projectId}?tab=publication`);
  await expect(page.getByTestId('pm-counts')).toHaveText(/modules/);
  await expect(page.getByRole('button', { name: 'Add chapter' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
  await expect(page.getByTestId('current-request')).toContainText('Pending approval');
  await expect(page.getByRole('button', { name: 'Build PDF' })).toBeVisible();
  await shots(page, '41-admin-publication-oversight');
  await ctx.close();
});

test('an Author not on the project sees none of it', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'ravi.k');
  await page.goto('/');
  await expect(page.getByText('Nothing opened yet')).toBeVisible();
  await page.goto(`/projects/${r.projectId}?tab=publication`);
  await expect(page.getByText('Project not found')).toBeVisible();
  await page.goto(`/projects/${r.projectId}/dms/00000000-0000-0000-0000-000000000000`);
  await expect(page.getByText('Data module not found')).toBeVisible();
  await page.goto('/publications');
  await expect(page.getByText('No publications yet')).toBeVisible();
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('another Project Manager sees none of it either', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'other.pm');
  await page.goto(`/projects/${r.projectId}`);
  await expect(page.getByText('Project not found')).toBeVisible();
  await page.goto(`/projects/${r.managedId}`);
  await expect(page.getByText('Project not found')).toBeVisible();
  await ctx.close();
});

test('a co-author sees the publication locked and cannot withdraw the request they did not submit', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'meera.iyer');
  await page.goto(`/projects/${r.projectId}?tab=publication`);
  await expect(page.getByTestId('lock-banner').first()).toContainText('Locked: pending approval');
  await expect(page.getByRole('button', { name: 'Add chapter' })).toHaveCount(0);
  await expect(page.getByTestId('current-request')).toContainText('Pending approval');
  await expect(page.getByTestId('current-request')).toContainText('Arjun Das');
  await expect(page.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0, { timeout: 2000 });
  await ctx.close();
});
