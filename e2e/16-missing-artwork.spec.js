'use strict';
// Missing artwork in the PDF (decisions.md PV39): a figure whose ICN file was
// never uploaded and a symbol whose ICN is not even declared still build with
// the Preview PDF button, and the PDF says what is missing where the artwork
// would be, with the figure title and the text around the symbol in place.
// No screenshots are taken.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect, run, signedIn, authorApi } = require('./fixtures');

const CODE = 'AGS-A-32-00-00-00A-041F-D';
const FIG = 'ICN-AGS-A-320000-A-0AGS1-09998-A-01-1';
const SYM = 'ICN-AGS-A-320000-A-0AGS1-09999-A-01-1';
const BODY = `
        <levelledPara id="par-0001">
          <title>Artwork</title>
          <para>Press <symbol infoEntityIdent="${SYM}"/> then continue.</para>
          <figure id="fig-0001">
            <title>Fan assembly</title>
            <graphic infoEntityIdent="${FIG}"/>
          </figure>
          <para>Text after the figure.</para>
        </levelledPara>
      `;

async function pdfText(buf) {
  const { extractPdfText } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'pdf-text.mjs')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agastya-e2e-pdf-'));
  try {
    fs.writeFileSync(path.join(dir, 'p.pdf'), buf);
    return (await extractPdfText(path.join(dir, 'p.pdf'))).pages.join('\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a missing figure and a missing symbol build to a PDF that names each missing file in its place', async ({ browser }) => {
  const { r, call } = authorApi();
  let m = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules.find((x) => x.dmc === CODE);
  if (!m) {
    const dmc = { modelIdentCode: 'AGS', systemDiffCode: 'A', systemCode: '32', subSystemCode: '0', subSubSystemCode: '0', assyCode: '00', disassyCode: '00', disassyCodeVariant: 'A', infoCode: '041', infoCodeVariant: 'F', itemLocationCode: 'D' };
    expect((await call('POST', `/api/projects/${r.projectId}/dms`, { dmc, techName: 'Missing artwork', infoName: 'Description', schemaType: 'descript' })).status).toBe(201);
    m = (await call('GET', `/api/projects/${r.projectId}/dms`)).body.modules.find((x) => x.dmc === CODE);
  }
  const g = (await call('GET', `/api/projects/${r.projectId}/dms/${m.id}`)).body;
  const xml = g.xml.replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>\s*/, '').replace(/<description\s*\/>|<description>[\s\S]*?<\/description>/, `<description>${BODY}</description>`)
    .replace(/^(<\?xml[^>]*\?>\s*)?/, (d) => `${d || ''}<!DOCTYPE dmodule [\n<!NOTATION png SYSTEM "png">\n<!ENTITY ${FIG} SYSTEM "${FIG}.png" NDATA png>\n]>\n`);
  expect((await call('PUT', `/api/projects/${r.projectId}/dms/${m.id}`, { xml, baseRevision: g.revision })).status).toBe(200);

  const { ctx, page } = await signedIn(browser, 'arjun.das');
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`/projects/${run().projectId}?tab=dms`);
  await page.getByRole('link', { name: CODE }).click();
  await expect(page.getByTestId('page-view')).toBeVisible();
  await expect(page.getByTestId('page-view').getByTestId('symbol-missing')).toHaveCount(1);
  const built = page.waitForResponse((res) => res.request().method() === 'POST' && /\/preview$/.test(new URL(res.url()).pathname), { timeout: 180000 });
  await page.getByRole('button', { name: 'Preview PDF' }).click();
  const res = await built;
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  await expect(page.locator(`iframe[title="Preview of DMC-${CODE}"]`)).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('build-log')).toContainText('"artwork not available" placeholder');

  const pdf = await page.request.get(`/api/projects/${r.projectId}/dms/${m.id}/preview.pdf`);
  expect(pdf.status()).toBe(200);
  const text = (await pdfText(await pdf.body())).replace(/\s+/g, ' ');
  expect(text).toContain(`Artwork not available: ${FIG}.png`);
  expect(text).toContain(`Artwork not available: ${SYM}.png`);
  // In place: the symbol's box between the words around it, the figure's box above its title.
  expect(text).toMatch(new RegExp(`Press Artwork not available: ${SYM}\\.png then continue\\.`));
  expect(text).toMatch(new RegExp(`Artwork not available: ${FIG}\\.png Figure [\\d-]+: Fan assembly Text after the figure\\.`));
  expect(errs).toEqual([]);
  await ctx.close();
});
