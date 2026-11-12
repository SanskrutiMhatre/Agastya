'use strict';
// Shared helpers for the browser scenarios: the run's details, a page signed
// in as a given account, and each checked state shown in both themes (no screenshots are taken).
const fs = require('node:fs');
const path = require('node:path');
const { test: base, expect } = require('@playwright/test');

const STATE_DIR = path.join(__dirname, '.state');

function run() {
  return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'run.json'), 'utf8'));
}

// A new browser context signed in as `username`, in the given theme.
async function signedIn(browser, username, { theme = 'light' } = {}) {
  const ctx = await browser.newContext({
    baseURL: run().base,
    storageState: path.join(STATE_DIR, `${username}.json`),
    colorScheme: theme,
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript((t) => {
    try { localStorage.setItem('agastya-theme', t); } catch { /* blocked */ }
    window.__AGASTYA_E2E__ = true; // lets the scenarios read the XML panel's text
  }, theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.errors = errors;
  return { ctx, page };
}

/*
  The page in both themes. No screenshot is taken or stored (checkpoint 2d
  testing rule): the page is switched to light and to dark, and must still
  render its main content with no script error in each. The name says which
  state is being checked, for the failure message.
*/
async function shots(page, name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      try { localStorage.setItem('agastya-theme', t); } catch { /* blocked */ }
      document.documentElement.classList.toggle('dark', t === 'dark');
    }, theme);
    await expect(page.locator('main, [role="main"], body').first(), `${name} in the ${theme} theme`).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark')), `${name}: ${theme} theme applied`).toBe(theme === 'dark');
  }
  await page.evaluate(() => { document.documentElement.classList.remove('dark'); try { localStorage.setItem('agastya-theme', 'light'); } catch { /* blocked */ } });
  if (page.errors) expect(page.errors, `${name}: no script errors`).toEqual([]);
}

// An account's API session (from its saved browser state, so the browser session stays valid) for set-up steps.
function apiAs(username) {
  const r = run();
  const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${username}.json`), 'utf8'));
  const headers = { cookie: `agastya_session=${state.cookies[0].value}`, origin: r.base, 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const res = await fetch(r.base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { r, call };
}
const authorApi = () => apiAs('arjun.das');
// A new sign-in for an account whose saved session an earlier scenario may have ended (as 08 does for ravi.k).
async function freshApi(username) {
  const r = run();
  const login = await fetch(`${r.base}/api/auth/login`, { method: 'POST', headers: { origin: r.base, 'content-type': 'application/json' }, body: JSON.stringify({ username, password: r.accounts[username].password }) });
  if (login.status !== 200) throw new Error(`sign-in of ${username} failed: ${login.status}`);
  const cookie = /agastya_session=[^;]+/.exec(login.headers.get('set-cookie'))[0];
  const call = async (method, url, body) => {
    const res = await fetch(r.base + url, { method, headers: { cookie, origin: r.base, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { r, call };
}

// Make sure the Author's publication has a pending request; returns it.
async function ensurePending() {
  const { r, call } = authorApi();
  const list = (await call('GET', `/api/projects/${r.projectId}/requests`)).body.requests;
  const open = list.find((x) => x.status === 'pending');
  if (open) return open;
  const res = await call('POST', `/api/projects/${r.projectId}/requests`, { approverId: r.accounts['priya.rao'].id });
  if (res.status !== 201) throw new Error(`submit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.request;
}

// ---- the data module editor (checkpoint 2c) ----------------------------------

// Show the Monaco XML panel and wait until it is ready.
async function xmlView(page) {
  await page.getByRole('radio', { name: 'XML' }).click();
  await page.getByTestId('xml-panel').locator('.view-lines').waitFor();
  await expect.poll(() => page.evaluate(() => typeof window.__agastyaXml === 'function')).toBe(true);
}
const xmlValue = (page) => page.evaluate(() => (window.__agastyaXml ? window.__agastyaXml() : null));
// Type at the end of the XML, as an author would.
async function appendXml(page, text) {
  // `.view-lines` is sized to the (possibly very long, word-wrap-off) line
  // content, not the visible viewport, so its center can sit scrolled out of
  // view — click near its top-left corner, which is always on screen.
  await page.getByTestId('xml-panel').locator('.view-lines').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}
const expectXml = (page, re) => expect.poll(() => xmlValue(page), { timeout: 15000 }).toMatch(re);
// The editor offers no way to change the module: no editable text in the document view, a read-only panel.
async function expectEditorReadOnly(page) {
  await expect(page.locator('[contenteditable="plaintext-only"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Save|Saved)$/ })).toHaveCount(0);
  await xmlView(page);
  await expect(page.locator('[data-readonly]')).toHaveAttribute('data-readonly', 'true');
}

module.exports = { test: base, expect, run, signedIn, shots, ensurePending, authorApi, apiAs, freshApi, xmlView, xmlValue, appendXml, expectXml, expectEditorReadOnly };
