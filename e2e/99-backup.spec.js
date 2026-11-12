'use strict';
// Phase 5 through the real UI: the Backups screen (create, verify, a damaged
// backup refused, delete), the health screen's backup status, other roles
// kept out, and a restore that brings the data back and signs everyone out.
// The restore ends every session, so it is the last scenario of the run.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, run, signedIn, shots, apiAs } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

const backupRoot = () => `${run().dataDir}-backups`;
let firstId;

test('Backups: create one with a note; it is listed, verified and shown on the health screen', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'admin');
  await page.goto('/backups');
  await expect(page.getByRole('heading', { name: 'Backups', level: 1 })).toBeVisible();
  await expect(page.getByTestId('backup-warnings')).toContainText('not encrypted');
  await expect(page.getByText('No backups yet')).toBeVisible();
  await page.getByLabel('Note (optional)').fill('Before the release review');
  await page.getByRole('button', { name: 'Create backup' }).click();
  await expect(page.getByText('Backup created and verified')).toBeVisible({ timeout: 60000 });
  const table = page.getByRole('table', { name: 'Backups' });
  await expect(table).toContainText('Before the release review');
  await expect(table).toContainText('Manual');
  firstId = (await table.locator('tbody tr').first().textContent()).match(/bk-\d{8}-\d{6}-[0-9a-f]{6}/)[0];
  await page.getByRole('button', { name: `Verify ${firstId}` }).click();
  await expect(page.getByText('Backup verified')).toBeVisible();
  await expect(table.getByText(/Verified/)).toBeVisible();
  await shots(page, '99a-backups');
  await page.goto('/health');
  await expect(page.getByTestId('health-backup')).toContainText('Last backup');
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('a damaged backup fails verification with the reasons, cannot be restored, and can be deleted', async ({ browser }) => {
  const { call } = apiAs('admin');
  const second = (await call('POST', '/api/admin/backups', { note: 'to be damaged' })).body.backup.id;
  const m = JSON.parse(fs.readFileSync(path.join(backupRoot(), second, 'manifest.json'), 'utf8'));
  const victim = path.join(backupRoot(), second, ...m.files.find((f) => f.path.endsWith('publication.xml')).path.split('/'));
  const b = fs.readFileSync(victim); b[5] ^= 1; fs.writeFileSync(victim, b);

  const { ctx, page } = await signedIn(browser, 'admin');
  await page.goto('/backups');
  await page.getByRole('button', { name: `Verify ${second}` }).click();
  const failed = page.getByRole('dialog', { name: 'This backup failed verification' });
  await expect(failed).toBeVisible();
  await expect(page.getByTestId('verify-problems')).toContainText('checksum mismatch');
  await shots(page, '99b-backup-damaged', { fullPage: false });
  await failed.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(failed).toHaveCount(0);
  const r = await call('POST', `/api/admin/backups/${second}/restore`, { confirm: second, password: run().accounts.admin.password, reason: 'Trying a damaged backup.' });
  expect(r.status).toBe(409);
  expect(r.body.code).toBe('BACKUP_INVALID');
  await page.getByRole('button', { name: `Delete ${second}` }).click();
  await page.getByRole('dialog', { name: 'Delete this backup?' }).getByRole('button', { name: 'Delete backup' }).click();
  await expect(page.getByRole('table', { name: 'Backups' })).not.toContainText(second);
  await ctx.close();
});

test('Project Managers and Authors reach no backup screen or route', async ({ browser }) => {
  for (const who of ['priya.rao', 'arjun.das']) {
    const { ctx, page } = await signedIn(browser, who);
    await page.goto('/backups');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Backups' })).toHaveCount(0);
    expect((await page.request.get('/api/admin/backups')).status()).toBe(403);
    expect((await page.request.post('/api/admin/backups', { data: {} })).status()).toBe(403);
    await ctx.close();
  }
});

test('restore: typed id, password and reason; the data goes back and everyone is signed out', async ({ browser }) => {
  const r = run();
  // A change made after the backup.
  const author = apiAs('arjun.das');
  const later = await author.call('POST', '/api/projects', { name: 'Made after the backup' });
  expect(later.status).toBe(201);

  const { ctx, page } = await signedIn(browser, 'admin');
  await page.goto('/backups');
  await page.getByRole('button', { name: `Restore ${firstId}` }).click();
  const dlg = page.getByRole('dialog', { name: 'Restore this backup' });
  await expect(dlg).toContainText('recovery point');
  await expect(dlg).toContainText('Everyone is signed out');
  await dlg.getByRole('button', { name: 'Restore and sign everyone out' }).click();
  await expect(dlg.getByText(/Type the backup id exactly/)).toBeVisible();
  await dlg.getByLabel(/Type the backup id to confirm/).fill(firstId);
  await dlg.getByLabel(/^Your password/).fill(r.accounts.admin.password);
  await dlg.getByLabel(/^Reason/).fill('Rolling back the release review changes.');
  await shots(page, '99c-restore-dialog', { fullPage: false });
  await dlg.getByRole('button', { name: 'Restore and sign everyone out' }).click();
  await expect(page).toHaveURL(/\/signin/, { timeout: 120000 });
  await ctx.close();

  // Every saved session is dead; signing in again shows the data as it was.
  expect((await author.call('GET', '/api/auth/me')).status).toBe(401);
  const fresh = await browser.newContext({ baseURL: r.base });
  const page2 = await fresh.newPage();
  await page2.goto('/signin');
  await page2.getByLabel('Username').fill('admin');
  await page2.getByLabel('Password', { exact: true }).fill(r.accounts.admin.password);
  await page2.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page2.getByRole('heading', { name: 'Organisation overview' })).toBeVisible();
  await page2.goto('/projects');
  await expect(page2.getByRole('link', { name: 'PDU-200 Manual' })).toBeVisible();
  await expect(page2.getByText('Made after the backup')).toHaveCount(0);
  await page2.goto('/backups');
  await expect(page2.getByRole('table', { name: 'Backups' })).toContainText('Recovery point');
  await page2.goto('/audit?category=backup');
  await expect(page2.getByTestId('audit-table')).toContainText('backup.restored');
  await shots(page2, '99d-audit-after-restore', { fullPage: false });
  await fresh.close();
});
