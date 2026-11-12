'use strict';
// Phase 3 through the real UI: the Project Manager's dashboard, queue and
// review of the frozen snapshot (PDF, sources read-only, revisions,
// validation, history); the three decisions with their comments; the rework
// loop from both sides; a decision blocked by a stale fingerprint; two tabs
// deciding the same request; team activity; the manager disabling and
// enabling an Author they created; and what another manager, the
// administrator and an Author see.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, run, signedIn, shots, ensurePending, authorApi, apiAs } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

const DM_030 = 'DMC-AGS-A-24-00-00-00A-030A-D.xml';
let first; // the request reviewed first

async function moduleStatuses() {
  const { r, call } = authorApi();
  return (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules.filter((m) => m.dmc !== 'AGS-A-31-00-00-00A-040A-D').map((m) => m.status);
}
async function touchModule(suffix = '030A-D') {
  const { r, call } = authorApi();
  const dm = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules.find((m) => m.dmc.endsWith(suffix) && m.dmc.startsWith('AGS-A-24-00'));
  const g = (await call('GET', `/api/projects/${r.projectId}/dms/${dm.id}`)).body;
  const res = await call('PUT', `/api/projects/${r.projectId}/dms/${dm.id}`, { xml: g.xml.replace('</dmodule>', '\n</dmodule>'), baseRevision: g.revision });
  if (res.status !== 200) throw new Error(`save failed: ${res.status} ${JSON.stringify(res.body)}`);
}
async function decideIn(page, outcome, comment) {
  await page.getByRole('radio', { name: new RegExp(`^${outcome}`) }).check();
  await page.getByLabel(/^Comment/).fill(comment);
  await page.getByRole('button', { name: 'Record decision' }).click();
}

test.beforeAll(async () => { first = await ensurePending(); });

test('Project Manager: dashboard shows the pending request, the approvals badge and team activity', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your projects and team' })).toBeVisible();
  await expect(page.getByTestId('approvals-badge')).toHaveText('1');
  await expect(page.getByTestId('dashboard-pending')).toContainText('PDU-200 Manual');
  await expect(page.getByTestId('dashboard-pending')).toContainText('Arjun Das');
  // Team activity covers the project the manager owns ("Managed manual") only.
  const activity = page.getByTestId('team-activity');
  await expect(activity).toContainText('Managed manual');
  await expect(activity).not.toContainText('PDU-200 Manual');
  await expect(page.getByTestId('team-authors')).toContainText('Arjun Das');
  await page.goto(`/projects/${r.managedId}`);
  await expect(page.getByRole('row', { name: /Arjun Das/ })).toContainText('imported a data module');
  await page.goto('/');
  await expect(page.getByText('Phase 3', { exact: true })).toHaveCount(0);
  await shots(page, '70-manager-dashboard');
  expect(page.errors).toEqual([]);
  await ctx.close();
  void r;
});

test('Project Manager: queue and review of the frozen snapshot, read-only', async ({ browser }) => {
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto('/approvals');
  await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
  const row = page.getByRole('row', { name: /PDU-200 Manual/ });
  await expect(row).toContainText('Pending approval');
  await shots(page, '71-approvals-queue');
  await row.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/approvals/${first.id}$`));
  await expect(page.getByTestId('decision-form')).toBeVisible();

  // PDF: the frozen build, framed from the snapshot.
  const frame = page.locator('iframe[title="Submitted publication (frozen)"]');
  await expect(frame).toHaveAttribute('src', new RegExp(`/api/requests/${first.id}/snapshot.pdf`));
  const pdf = await page.request.get(`/api/requests/${first.id}/snapshot.pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  await expect(page.getByTestId('review-modules')).toContainText('In review');
  await shots(page, '72-review-pdf', { fullPage: false });

  // Sources: the design, document and XML views, both read-only; the revision history up to submission.
  await page.getByRole('tab', { name: 'Sources' }).click();
  await expect(page.getByTestId('source-list')).toContainText('publication.xml');
  await page.getByTestId('source-list').getByRole('button', { name: new RegExp(DM_030.replace(/\./g, '\\.')) }).click();
  // The Design view opens first (spec 11); the tagged document view is one click away.
  await expect(page.getByTestId('source-design')).toBeVisible();
  await page.getByRole('button', { name: 'Tags', exact: true }).click();
  await expect(page.getByTestId('source-document')).toBeVisible();
  await expect(page.getByTestId('source-document')).toContainText('Technical data');
  await expect(page.locator('[contenteditable="plaintext-only"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);
  await expect(page.getByTestId('revision-list')).toBeVisible();
  await page.getByTestId('revision-list').getByRole('button', { name: 'View' }).first().click();
  await expect(page.getByTestId('revision-view')).toContainText('<dmodule');
  await shots(page, '73-review-sources');
  await page.getByRole('button', { name: 'XML', exact: true }).click();
  await page.getByTestId('xml-panel').locator('.view-lines').waitFor();
  await expect(page.locator('[data-readonly]')).toHaveAttribute('data-readonly', 'true');
  await page.getByTestId('xml-panel').locator('.view-lines').click();
  await page.keyboard.type('TYPED-INTO-READ-ONLY');
  await expect(page.getByTestId('xml-panel')).not.toContainText('TYPED-INTO-READ-ONLY');
  // A graphic from the snapshot.
  await page.getByTestId('source-list').getByRole('button', { name: /ICN-AGS-A-240000/ }).click();
  await expect(page.getByTestId('source-image')).toBeVisible();
  await expect.poll(() => page.getByTestId('source-image').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);

  // Validation and history.
  await page.getByRole('tab', { name: /Validation/ }).click();
  await expect(page.getByTestId('validation-report')).toBeVisible();
  await expect(page.getByText(/Frozen with the submission: 0 errors/)).toBeVisible();
  await shots(page, '74-review-validation', { fullPage: false });
  await page.getByRole('tab', { name: /History/ }).click();
  await expect(page.getByTestId('history-item').last()).toContainText('This request');
  expect(page.errors).toEqual([]);
  await ctx.close();
});

test('a decision needs a comment; requesting changes returns the modules to draft and tells the Author', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto(`/approvals/${first.id}`);
  await page.getByRole('radio', { name: /^Request changes/ }).check();
  await page.getByRole('button', { name: 'Record decision' }).click();
  await expect(page.getByTestId('decision-form')).toContainText('A comment is required for every decision.');
  await shots(page, '75-decision-comment-required', { fullPage: false });
  await decideIn(page, 'Request changes', 'Step 4 torque values are out of date. Please update them.');
  await expect(page.getByTestId('decision-closed')).toContainText('Changes requested by Priya Rao');
  await expect(page.getByTestId('decision-comment')).toContainText('Step 4 torque values');
  await expect(page.getByTestId('review-modules')).not.toContainText('In review');
  expect((await moduleStatuses()).every((s) => s === 'draft')).toBe(true);
  await expect(page.getByTestId('approvals-badge')).toHaveCount(0);
  await shots(page, '76-review-decided');
  await ctx.close();

  // The Author: notified, reads the comment on the project, and the lock has lifted.
  const a = await signedIn(browser, 'arjun.das');
  await a.page.goto('/');
  await a.page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(a.page.getByText(/Changes requested: /).first()).toBeVisible();
  await a.page.keyboard.press('Escape');
  await a.page.goto(`/projects/${r.projectId}?tab=publication`);
  const current = a.page.getByTestId('current-request');
  await expect(current).toContainText('Changes requested');
  await expect(current.getByTestId('request-decision')).toContainText('Step 4 torque values');
  await expect(current).toContainText('Make the changes, then submit again');
  await expect(a.page.getByTestId('lock-banner')).toHaveCount(0);
  await shots(a.page, '77-author-changes-requested');
  expect(a.page.errors).toEqual([]);
  await a.ctx.close();

  // A co-author on the project reads the comment too.
  const m = await signedIn(browser, 'meera.iyer');
  await m.page.goto(`/projects/${r.projectId}?tab=publication`);
  await expect(m.page.getByTestId('current-request').getByTestId('request-decision')).toContainText('Step 4 torque values');
  await m.ctx.close();
});

test('rework loop: the Author edits and resubmits to the same manager; the review shows the whole history; approval', async ({ browser }) => {
  const r = run();
  await touchModule();
  const a = await signedIn(browser, 'arjun.das');
  await a.page.goto(`/projects/${r.projectId}?tab=publication`);
  await a.page.getByRole('button', { name: 'Submit for approval' }).click();
  const dialog = a.page.getByRole('dialog', { name: 'Submit for approval' });
  await expect(dialog.getByLabel('Send to')).toHaveValue(r.accounts['priya.rao'].id);
  await dialog.getByLabel(/Note for the reviewer/).fill('Torque values updated in step 4.');
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(a.page.getByTestId('current-request')).toContainText('Pending approval', { timeout: 90000 });
  await a.page.getByText(/History: earlier requests/).click();
  await expect(a.page.getByText('Step 4 torque values').first()).toBeVisible();
  await a.ctx.close();

  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto('/');
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByText(/Resubmitted for approval/).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/approvals');
  const row = page.getByRole('row', { name: /PDU-200 Manual/ }).filter({ hasText: 'Pending approval' });
  await expect(row).toContainText('resubmission');
  await row.getByRole('link').click();
  await page.getByRole('tab', { name: /History/ }).click();
  // The whole chain for this publication (earlier scenarios may have added requests of their own).
  const all = (await authorApi().call('GET', `/api/projects/${r.projectId}/requests`)).body.requests;
  await expect(page.getByTestId('history-item')).toHaveCount(all.length);
  expect(all.length).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('history-item').nth(all.length - 2)).toContainText('Step 4 torque values');
  await expect(page.getByTestId('history-item').last()).toContainText('Torque values updated in step 4.');
  await shots(page, '78-review-history');
  await decideIn(page, 'Approve', 'Approved for issue 001.');
  await expect(page.getByTestId('decision-closed')).toContainText('Approved by Priya Rao');
  await expect(page.getByTestId('review-modules')).toContainText('Approved');
  expect((await moduleStatuses()).every((s) => s === 'approved')).toBe(true);
  await ctx.close();

  // Editing an approved module makes it a draft again.
  await touchModule('030A-D');
  const st = await moduleStatuses();
  expect(st.filter((s) => s === 'draft').length).toBe(1);
});

test('rejection: the modules return to draft; the Author sees the decision', async ({ browser }) => {
  const r = run();
  const req = await ensurePending();
  expect((await moduleStatuses()).every((s) => s === 'in_review')).toBe(true);
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto(`/approvals/${req.id}`);
  await decideIn(page, 'Reject', 'This issue is superseded by the new wiring layout.');
  await expect(page.getByTestId('decision-closed')).toContainText('Rejected by Priya Rao');
  expect((await moduleStatuses()).every((s) => s === 'draft')).toBe(true);
  await ctx.close();
  const a = await signedIn(browser, 'arjun.das');
  await a.page.goto(`/projects/${r.projectId}?tab=publication`);
  await expect(a.page.getByTestId('current-request')).toContainText('Rejected');
  await expect(a.page.getByTestId('current-request')).toContainText('superseded by the new wiring layout');
  await a.ctx.close();
});

test('a decision is blocked when the live content changed after submission; the request becomes out of date', async ({ browser }) => {
  const r = run();
  const req = await ensurePending();
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto(`/approvals/${req.id}`);
  await expect(page.getByTestId('decision-form')).toBeVisible();
  // A change made outside the application (so no lock and no listener sees it).
  const file = path.join(r.dataDir, 'projects', r.projectId, 'csdb', DM_030);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('</dmodule>', '<!-- edited on disk --></dmodule>'));
  await decideIn(page, 'Approve', 'Looks good.');
  await expect(page.getByTestId('decision-closed')).toContainText('Out of date');
  await expect(page.getByRole('main').getByText('Out of date').first()).toBeVisible();
  await shots(page, '79-review-stale', { fullPage: false });
  expect((await moduleStatuses()).every((s) => s === 'draft')).toBe(true);
  const { call } = apiAs('priya.rao');
  expect((await call('GET', `/api/requests/${req.id}`)).body.request.status).toBe('stale');
  await ctx.close();
});

test('two tabs: the second decision on the same request is refused', async ({ browser }) => {
  const req = await ensurePending();
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  const tab2 = await ctx.newPage();
  await page.goto(`/approvals/${req.id}`);
  await tab2.goto(`/approvals/${req.id}`);
  await expect(tab2.getByTestId('decision-form')).toBeVisible();
  await decideIn(page, 'Approve', 'Approved in tab one.');
  await expect(page.getByTestId('decision-closed')).toContainText('Approved by Priya Rao');
  await decideIn(tab2, 'Reject', 'Rejected in tab two.');
  await expect(tab2.getByRole('alert')).toContainText('already been decided');
  await expect(tab2.getByTestId('decision-closed')).toContainText('Approved in tab one.');
  await ctx.close();
});

test('another Project Manager, the administrator and Authors', async ({ browser }) => {
  const req = await ensurePending();
  // Another manager: nothing queued, and the review is not found.
  const o = await signedIn(browser, 'other.pm');
  await o.page.goto('/approvals');
  await expect(o.page.getByText('Nothing waiting for you')).toBeVisible();
  await o.page.goto(`/approvals/${req.id}`);
  await expect(o.page.getByText('This request was not found')).toBeVisible();
  await o.ctx.close();

  // The administrator: oversight of every request, can open the review, cannot decide.
  const ad = await signedIn(browser, 'admin');
  await ad.page.goto('/approvals');
  await expect(ad.page.getByRole('columnheader', { name: 'Sent to' })).toBeVisible();
  await ad.page.getByRole('row', { name: /PDU-200 Manual/ }).filter({ hasText: 'Pending approval' }).getByRole('link').click();
  await expect(ad.page.getByTestId('decision-closed')).toContainText('As administrator you can decide, reset or reassign it');
  await expect(ad.page.getByTestId('admin-overrides')).toBeVisible();
  await expect(ad.page.getByTestId('decision-form')).toHaveCount(0);
  await shots(ad.page, '80-admin-review', { fullPage: false });
  await ad.page.goto('/');
  await expect(ad.page.getByTestId('admin-submissions')).toContainText('Pending approval');
  await expect(ad.page.getByText('Submissions and decisions')).toBeVisible();
  await shots(ad.page, '82-admin-dashboard-submissions');
  await ad.ctx.close();

  // Authors have no approvals screen; an Author not on the project gets nothing from the API either.
  const rv = await signedIn(browser, 'ravi.k');
  await rv.page.goto('/approvals');
  await expect(rv.page).toHaveURL(/\/$/);
  await expect(rv.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Approvals' })).toHaveCount(0);
  expect((await rv.page.request.get(`/api/requests/${req.id}`)).status()).toBe(404);
  expect((await rv.page.request.get(`/api/requests/${req.id}/snapshot.pdf`)).status()).toBe(404);
  await rv.ctx.close();

  const { call } = authorApi();
  await call('POST', `/api/requests/${req.id}/withdraw`, {});
});

test('Project Manager: disables and enables an Author they created', async ({ browser }) => {
  const r = run();
  const { ctx, page } = await signedIn(browser, 'priya.rao');
  await page.goto(`/users/${r.accounts['sign.in'].id}`);
  await expect(page.getByRole('heading', { name: 'Sana Inamdar' })).toBeVisible();
  await page.getByRole('button', { name: 'Disable account' }).click();
  await expect(page.getByRole('dialog')).toContainText('The owners of other projects they work on are told.');
  await page.getByRole('dialog').getByRole('button', { name: 'Disable account' }).click();
  await expect(page.getByRole('button', { name: 'Enable account' })).toBeVisible();
  await shots(page, '81-manager-disabled-author', { fullPage: false });
  const signIn = await (await fetch(`${r.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: r.base }, body: JSON.stringify({ username: 'sign.in', password: r.accounts['sign.in'].password }) })).status;
  expect(signIn).toBe(401);
  await page.getByRole('button', { name: 'Enable account' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Enable account' }).click();
  await expect(page.getByRole('button', { name: 'Disable account' })).toBeVisible();
  // Another manager's view of the same Author: not found.
  const o = await signedIn(browser, 'other.pm');
  expect((await o.page.request.post(`/api/users/${r.accounts['sign.in'].id}/disable`, { data: {}, headers: { origin: r.base } })).status()).toBe(404);
  await o.ctx.close();
  expect(page.errors).toEqual([]);
  await ctx.close();
});
