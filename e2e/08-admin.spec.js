'use strict';
// Phase 4 through the real UI: the Software Administrator's dashboard
// (oversight, workload, who is working on what, stuck requests), overrides
// with a written reason (decide, reassign, reset, members, content edits
// that make a pending request stale), the editing session ending when the
// administrator leaves, the audit log with filters and a CSV export holding
// no secret, system health with the real tool paths, the session list; and
// Project Managers and Authors kept out of every administrator screen.
const fs = require('node:fs');
const { test, expect, run, signedIn, shots, ensurePending, authorApi, apiAs, xmlView, appendXml } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

const REASON = 'Manager on leave this week; the release cannot wait.';
const reviewOf = async (page, id) => { await page.goto(`/approvals/${id}`); await expect(page.getByTestId('admin-overrides')).toBeVisible(); };

test('dashboard: every project, workload and who is working on what', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'admin');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Organisation overview' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Projects' })).toContainText('PDU-200 Manual');
  await expect(page.getByRole('table', { name: 'Projects' })).toContainText('Managed manual');
  await expect(page.getByRole('table', { name: 'Project Manager workload' })).toContainText('Priya Rao');
  await expect(page.getByRole('table', { name: 'Author workload' })).toContainText('Arjun Das');
  await expect(page.getByTestId('admin-working-on')).toContainText('Arjun Das');
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const name of ['Users', 'Approvals', 'Audit log', 'System health']) await expect(nav.getByRole('link', { name })).toBeVisible();
  await expect(nav.getByText('P4')).toHaveCount(0);
  await shots(page, '90-admin-dashboard');
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('decision override: refused without a reason; recorded as the real decision, labelled, told to the Author', async ({ browser }) => {
  const req = await ensurePending();
  const { ctx, page } = await signedIn(browser, 'admin');
  await reviewOf(page, req.id);
  await page.getByRole('button', { name: 'Decide as administrator' }).click();
  const dlg = page.getByRole('dialog', { name: 'Decide as administrator' });
  await expect(dlg.getByTestId('override-notice')).toContainText('The reason is recorded in the audit log and is visible to the people involved');
  await dlg.getByRole('radio', { name: /Request changes/ }).check();
  await dlg.getByLabel('Comment for the Author').fill('Please add the torque table to section 2.');
  await dlg.getByRole('button', { name: 'Record decision' }).click();
  await expect(dlg.getByText(/Write a reason of 10 to 1000 characters/)).toBeVisible();
  expect((await authorApi().call('GET', `/api/requests/${req.id}`)).body.request.status).toBe('pending');
  await dlg.getByLabel('Reason for this override').fill(REASON);
  await shots(page, '91-override-decision-dialog', { fullPage: false });
  await dlg.getByRole('button', { name: 'Record decision' }).click();
  await expect(page.getByTestId('override-note').first()).toContainText(REASON);
  await expect(page.getByRole('main').getByText('Changes requested').first()).toBeVisible();
  await expect(page.getByTestId('override-log')).toContainText('Decided as an override');
  await shots(page, '92-override-decided', { fullPage: false });
  await ctx.close();

  // The Author sees the decision, labelled, with the reason, and was told.
  const a = await signedIn(browser, 'arjun.das');
  await a.page.goto(`/projects/${run().projectId}?tab=publication`);
  await expect(a.page.getByTestId('current-request').getByTestId('override-note')).toContainText(REASON);
  await a.page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(a.page.getByText(/Decided by the administrator/).first()).toBeVisible();
  await a.ctx.close();
});

test('content override: the editing session needs a reason; saving a frozen module asks first, then makes the request stale', async ({ browser }) => {
  const r = run();
  const req = await ensurePending();
  const { ctx, page } = await signedIn(browser, 'admin');
  await page.goto(`/projects/${r.projectId}?tab=dms`);
  await page.getByRole('link', { name: 'AGS-A-24-10-00-00A-520A-D' }).click();
  await expect(page.getByTestId('override-offer')).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Save|Saved)$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit as administrator' }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit this data module as administrator' });
  await dlg.getByRole('button', { name: 'Start editing' }).click();
  await expect(dlg.getByText(/Write a reason/)).toBeVisible();
  const started = page.waitForResponse((res) => res.url().includes('/override-sessions') && res.request().method() === 'POST');
  await dlg.getByLabel('Reason for this override').fill('Fixing a wrong torque value before the audit visit.');
  await dlg.getByRole('button', { name: 'Start editing' }).click();
  const sessionId = (await (await started).json()).session.id;
  await expect(page.getByTestId('override-bar')).toContainText('Fixing a wrong torque value');
  await expect(page.getByTestId('lock-banner')).toContainText('Part of a pending request');
  await xmlView(page);
  await appendXml(page, '\n<!-- corrected by the administrator -->');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'This save makes a pending request out of date' });
  await expect(confirm).toBeVisible();
  await shots(page, '93-override-edit-confirm', { fullPage: false });
  await confirm.getByRole('button', { name: 'Save and make it out of date' }).click();
  await expect(page.getByText('A new revision was recorded.')).toBeVisible();
  const after = (await authorApi().call('GET', `/api/requests/${req.id}`)).body.request;
  expect(after.status).toBe('stale');
  expect(after.staleReason).toMatch(/edited by the administrator \(override\): Fixing a wrong torque value/);

  // Leaving the document ends the session: a save with it is refused.
  await page.getByRole('tab', { name: 'Data modules' }).first().click();
  await expect(page).toHaveURL(/tab=dms/);
  await expect.poll(async () => (await page.evaluate(async ({ projectId, sid }) => {
    const list = await (await fetch(`/api/projects/${projectId}/dms`)).json();
    const m = list.modules.find((x) => x.dmc.endsWith('520A-D'));
    const g = await (await fetch(`/api/projects/${projectId}/dms/${m.id}`)).json();
    const res = await fetch(`/api/projects/${projectId}/dms/${m.id}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'X-Agastya-Override-Session': sid }, body: JSON.stringify({ xml: g.xml, baseRevision: g.revision }) });
    return (await res.json()).code;
  }, { projectId: r.projectId, sid: sessionId }))).toBe('OVERRIDE_SESSION_ENDED');
  expect(page.errors).toEqual([]);
  await ctx.close();

  // The Author: unlocked at once, sees why, and resubmits.
  const a = await signedIn(browser, 'arjun.das');
  await a.page.goto(`/projects/${r.projectId}?tab=publication`);
  await expect(a.page.getByTestId('current-request')).toContainText('edited by the administrator (override)');
  await expect(a.page.getByTestId('lock-banner')).toHaveCount(0);
  await shots(a.page, '94-author-stale-by-override', { fullPage: false });
  await a.ctx.close();
  expect((await ensurePending()).status).toBe('pending');
});

test('reassign, a stuck request with a disabled manager, and reassigning it back', async ({ browser }) => {
  const r = run();
  const req = await ensurePending();
  const { ctx, page } = await signedIn(browser, 'admin');
  await reviewOf(page, req.id);
  await page.getByRole('button', { name: 'Reassign to another manager' }).click();
  const dlg = page.getByRole('dialog', { name: 'Reassign the request' });
  await dlg.getByLabel('Send to').selectOption({ label: 'Other Manager (other.pm)' });
  await dlg.getByLabel('Reason for this override').fill(REASON);
  await dlg.getByRole('button', { name: 'Reassign' }).click();
  await expect(page.getByTestId('override-log')).toContainText('Reassigned');

  const o = await signedIn(browser, 'other.pm');
  await o.page.goto('/approvals');
  await expect(o.page.getByRole('row', { name: /PDU-200 Manual/ })).toBeVisible();
  await o.ctx.close();

  // Disabling the manager it now sits with leaves nobody able to decide it: flagged on the dashboard.
  const admin = apiAs('admin');
  expect((await admin.call('POST', `/api/users/${r.accounts['other.pm'].id}/disable`, {})).status).toBe(200);
  await page.goto('/');
  await expect(page.getByTestId('stuck-requests')).toContainText('with a disabled Project Manager');
  await shots(page, '95-admin-stuck-request', { fullPage: false });
  await page.getByTestId('stuck-requests').getByRole('link').first().click();
  await page.getByRole('button', { name: 'Reassign to another manager' }).click();
  const back = page.getByRole('dialog', { name: 'Reassign the request' });
  await back.getByLabel('Send to').selectOption({ label: 'Priya Rao (priya.rao)' });
  await back.getByLabel('Reason for this override').fill('Back to the original manager; other.pm left the team.');
  await back.getByRole('button', { name: 'Reassign' }).click();
  await expect(page.getByTestId('override-log')).toContainText('Back to the original manager');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Organisation overview' })).toBeVisible();
  await expect(page.getByTestId('stuck-requests')).toHaveCount(0);
  await admin.call('POST', `/api/users/${r.accounts['other.pm'].id}/enable`, {});
  await ctx.close();
});

test('reset: the request goes stale with the reason and the Authors can resubmit', async ({ browser }) => {
  const req = await ensurePending();
  const { ctx, page } = await signedIn(browser, 'admin');
  await reviewOf(page, req.id);
  await page.getByRole('button', { name: 'Reset so the Authors can resubmit' }).click();
  const dlg = page.getByRole('dialog', { name: 'Reset the request' });
  await dlg.getByLabel('Reason for this override').fill('Submitted against the wrong revision of the BREX.');
  await dlg.getByRole('button', { name: 'Reset request' }).click();
  await expect(page.getByTestId('decision-closed')).toContainText('reset by the administrator: Submitted against the wrong revision');
  await ctx.close();
  expect((await authorApi().call('GET', `/api/requests/${req.id}`)).body.request.status).toBe('stale');
});

test('members: assigning and removing an Author as an override asks for a reason', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'admin');
  await page.goto(`/projects/${r.managedId}`);
  await page.getByRole('button', { name: 'Assign Author' }).click();
  const dlg = page.getByRole('dialog', { name: 'Assign an Author (override)' });
  await dlg.getByLabel('Author').selectOption({ label: 'Meera Iyer (meera.iyer)' });
  await dlg.getByRole('button', { name: 'Assign' }).click();
  await expect(dlg.getByText(/Write a reason/)).toBeVisible();
  await dlg.getByLabel('Reason for this override').fill('Second writer needed for the hydraulics chapter.');
  await dlg.getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByRole('table', { name: 'Assigned Authors' })).toContainText('Meera Iyer');
  await page.getByRole('button', { name: 'Remove Meera Iyer from Managed manual' }).click();
  const rm = page.getByRole('dialog', { name: 'Remove Author from project (override)' });
  await rm.getByLabel('Reason for this override').fill('Chapter finished; access no longer needed.');
  await rm.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('table', { name: 'Assigned Authors' })).not.toContainText('Meera Iyer');
  await ctx.close();
});

test('audit log: filters, override reasons shown, and a CSV export without secrets', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'admin');
  await page.goto('/audit');
  await expect(page.getByTestId('audit-table')).toBeVisible();
  await page.getByLabel('Category').selectOption({ label: 'Administrator overrides' });
  await expect(page.getByTestId('audit-row').first()).toContainText('admin.override');
  const rows = page.getByTestId('audit-row');
  expect(await rows.count()).toBeGreaterThanOrEqual(5);
  for (const text of await rows.allInnerTexts()) expect(text).toContain('admin.override');
  await expect(page.getByTestId('audit-table')).toContainText(REASON);
  await shots(page, '96-audit-log');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const file = await (await download).path();
  const csv = fs.readFileSync(file, 'utf8');
  expect(csv).toContain(REASON);
  for (const l of csv.trim().split(/\r?\n/).slice(1)) expect(l).toContain('"admin.override"');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  const all = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const full = fs.readFileSync(await (await all).path(), 'utf8');
  for (const a of Object.values(r.accounts)) expect(full.includes(a.password)).toBe(false);
  expect(full).not.toContain('Please add the torque table');
  expect(full).toContain('commentLength');
  await ctx.close();
});

test('system health: the real tool paths and versions, the build queue, storage, no backup configured', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'admin');
  await page.goto('/health');
  const tools = page.getByTestId('tool-table');
  await expect(tools).toContainText('Java runtime', { timeout: 60000 });
  await expect(tools).toContainText('xsltproc');
  await expect(tools).toContainText(/version|Version/);
  const h = (await apiAs('admin').call('GET', '/api/admin/health')).body;
  for (const t of h.toolchain.tools) await expect(tools).toContainText(t.realPath);
  if (h.toolchain.tools.some((t) => t.linked && !t.insideProject)) await expect(page.getByTestId('tools-outside')).toContainText('Re-run the golden build on the production machine');
  await expect(page.getByText('No backup configured')).toBeVisible();
  await expect(page.getByText('Submission snapshots')).toBeVisible();
  await expect(page.getByTestId('build-idle').or(page.getByTestId('build-active'))).toBeVisible();
  await shots(page, '97-system-health');
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('Project Managers and Authors reach no administrator screen or route', async ({ browser }) => {
  for (const who of ['priya.rao', 'arjun.das']) {
    const { ctx, page } = await signedIn(browser, who);
    for (const path of ['/audit', '/health']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
    }
    await page.goto('/users?tab=sessions');
    await expect(page.getByRole('tab', { name: 'Sessions' })).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'System health' })).toHaveCount(0);
    for (const url of ['/api/admin/oversight', '/api/admin/audit', '/api/admin/audit.csv', '/api/admin/health', '/api/admin/sessions']) {
      expect((await page.request.get(url)).status(), `${who} ${url}`).toBe(403);
    }
    await ctx.close();
  }
});

test('sessions: every live session, and ending one signs that account out', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'admin');
  await page.goto('/users?tab=sessions');
  const table = page.getByRole('table', { name: 'Active sessions' });
  await expect(table).toContainText('Ravi Kumar');
  await expect(table.getByText('This session')).toBeVisible();
  await shots(page, '98-sessions', { fullPage: false });
  await page.getByRole('button', { name: 'End the session of ravi.k' }).click();
  await page.getByRole('dialog', { name: 'End this session?' }).getByRole('button', { name: 'End session' }).click();
  await expect(table).not.toContainText('Ravi Kumar');
  await ctx.close();
  const rv = await signedIn(browser, 'ravi.k');
  await rv.page.goto('/');
  await expect(rv.page).toHaveURL(/signin/);
  await rv.ctx.close();
});
