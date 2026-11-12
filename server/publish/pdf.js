'use strict';
/*
  PDF output: the full publication build and the single-module preview.

  A thin orchestrator around the JSS engine vendored in vendor/engine (see
  vendor/PROVENANCE.md), following JSS's own /api/generate and /api/preview:

    project.json + house template  -> effective configuration
    publication.xml  -- dmRef -> xi:include, path repair, missing guard -->  _resolved-pm.xml
    buildJss (s1000dtojss -> jsstofo -> FOP)  or  buildS1000dToFo (direct)

  Everything runs from tools inside the project folder (vendor/engine/paths.js),
  through execFile with argument arrays, with xsltproc's --nonet. Builds of one
  project are serialised; a failed build never blocks the next. Errors are
  summarised by the engine's explainBuildFailure, which reduces absolute paths
  to project-relative ones; the raw tool output is logged on the server and
  never returned to a client (decisions.md C3).
*/

const fs = require('node:fs');
const path = require('node:path');
const engine = require('../../vendor/engine/build');
const config = require('../../vendor/engine/config');
const { resolveDmRefs, repairIncludePaths, guardMissingIncludes } = require('../../vendor/engine/resolveDmRefs');
const { explainBuildFailure } = require('../../vendor/engine/buildErrors');
const paths = require('../../vendor/engine/paths');
const { xincludeProblem } = require('../content/xinclude');
const watermarkEngine = require('../../vendor/engine/watermark');

const TEMPLATES_DIR = path.join(paths.ROOT, 'vendor', 'templates');
const FRONTMATTER_STENCILS = path.join(paths.PIPELINE, 'jss', 'frontmatter');
const STAGE1 = path.join(paths.PIPELINE, 's1000dtojss', 's1000dtojss.xsl');
const STAGE2 = path.join(paths.PIPELINE, 'jsstofo', 'jsstofo.xsl');
const DIRECT = path.join(paths.PIPELINE, 's1000dtofo', 's1000dtofo.xsl');

const OUTPUT = { pdf: 'output.pdf', fo: 'output.fo', book: 'jss-book.xml', resolvedPm: '_resolved-pm.xml' };
const PREVIEW = { pdf: '_preview.pdf', fo: '_preview.fo', book: '_preview-book.xml', pm: '_preview-pm.xml' };

// Stylesheets are named relative to the project directory, as JSS does: the
// generated driver stylesheet imports them by that path.
const relFrom = (dir, abs) => path.relative(dir, abs).split(path.sep).join('/');

function loadConfig(projectDir) {
  const project = config.loadProject(path.join(projectDir, 'project.json'));
  const templateRef = /^[a-z0-9_-]+$/i.test(project.templateRef || '') ? project.templateRef : 'agastya';
  const house = config.loadHouse(TEMPLATES_DIR, templateRef);
  return { project, effective: config.mergeConfig(house, project) };
}

// Static front-matter stencils, copied once and never overwritten (an edited
// page stays the author's).
function ensureFrontMatterStencils(projectDir) {
  const target = path.join(projectDir, 'jss', 'frontmatter');
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(FRONTMATTER_STENCILS)) {
    const dest = path.join(target, f);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(FRONTMATTER_STENCILS, f), dest);
  }
}

// One build at a time per project; a failure does not block the next.
const inFlight = new Map();
function serialise(key, fn) {
  const prev = inFlight.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  inFlight.set(key, next);
  next.finally(() => { if (inFlight.get(key) === next) inFlight.delete(key); }).catch(() => {});
  return next;
}

class BuildError extends Error {
  constructor(summary, { hint, file, line, code } = {}) {
    super(summary);
    this.code = code || 'BUILD_FAILED';
    this.hint = hint || null;
    this.file = file || null;
    this.line = line || null;
  }
}

function failure(err, projectDir, log) {
  const why = explainBuildFailure(err, { workDir: projectDir });
  log.error(`[pdf] build failed: ${why.summary}\n${why.raw || ''}`);
  return new BuildError(why.summary, { hint: why.hint, file: why.file, line: why.line });
}

/*
  XInclude containment at build time as well as on save (content/xinclude.js):
  files can change on disk outside Agastya, and xsltproc --xinclude follows
  includes recursively into every module it reads.
*/
function assertContainedIncludes(projectDir, csdbDir, pmText) {
  const pmProblem = xincludeProblem(pmText, 'pm');
  if (pmProblem) throw new BuildError(`publication.xml: ${pmProblem.message.replace(/^XML refused: /, '')}`, { code: 'UNSAFE_INCLUDE' });
  let files = [];
  try { files = fs.readdirSync(path.join(projectDir, csdbDir)).filter((f) => /\.xml$/i.test(f)); } catch { files = []; }
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(projectDir, csdbDir, f), 'utf8'); } catch { continue; }
    const p = xincludeProblem(text, 'dm');
    if (p) throw new BuildError(`${f}: ${p.message.replace(/^XML refused: /, '')}`, { code: 'UNSAFE_INCLUDE', file: `${csdbDir}/${f}`, line: p.line });
  }
}

/*
  Prepare the publication module for the engine: dmRef entries become
  xi:includes of the matching csdb files, bare paths are repointed into csdb/,
  and includes whose file is missing get an xi:fallback. Returns the input
  file name and human-readable notes.
*/
function preparePm(projectDir, project) {
  const pm = (project.input && project.input.pm) || 'publication.xml';
  const csdbDir = (project.input && project.input.csdbDir) || 'csdb';
  const pmPath = path.join(projectDir, pm);
  if (!fs.existsSync(pmPath)) throw new BuildError('The publication module (publication.xml) is missing.');
  const original = fs.readFileSync(pmPath, 'utf8');
  const isS1000D = !/<\s*jssbook[\s>]/.test(original);
  if (!isS1000D) return { input: pm, isS1000D, notes: [] };
  assertContainedIncludes(projectDir, csdbDir, original);

  const s1 = resolveDmRefs(original, path.join(projectDir, csdbDir), csdbDir);
  const s1b = repairIncludePaths(s1.text, projectDir, csdbDir);
  const s2 = guardMissingIncludes(s1b.text, projectDir);
  const notes = [];
  if (s1b.repaired) notes.push(`Repointed ${s1b.repaired} reference(s) to ${csdbDir}/`);
  if (s2.missing) notes.push(`${s2.missing} referenced data module(s) missing from disk were skipped`);
  for (const u of (s1.unresolved || []).slice(0, 10)) {
    notes.push(`No data module in this project matches ${u.title ? `"${u.title}" (${u.code})` : u.code}; nothing was published for it`);
  }
  fs.writeFileSync(path.join(projectDir, OUTPUT.resolvedPm), s2.text, 'utf8');
  return { input: OUTPUT.resolvedPm, isS1000D, notes, resolved: s1.resolved || 0, unresolved: (s1.unresolved || []).length };
}

/*
  The printable box (mm) a watermark may fill, from the page geometry the
  stylesheets read: the JSS PDF Publisher's printableBoxMm (server.js), with
  its per-pipeline defaults (vendor/PROVENANCE.md).
*/
const PAGE_GEOMETRY_DEFAULTS = {
  s1000dtofo: { width: 210, height: 297, marginTop: 11, marginBottom: 12, marginInner: 25, marginOuter: 15, bodyMarginTop: 25, bodyMarginBottom: 30, headerExtent: 15, footerExtent: 25 },
  s1000dtojss: { width: 210, height: 297, marginTop: 12, marginBottom: 12, marginInner: 25, marginOuter: 18, bodyMarginTop: 14, bodyMarginBottom: 14, headerExtent: 14, footerExtent: 14 },
};
function printableBoxMm(effective, pipeline) {
  const d = PAGE_GEOMETRY_DEFAULTS[pipeline] || PAGE_GEOMETRY_DEFAULTS.s1000dtojss;
  const p = (effective && effective.layout && effective.layout.page) || {};
  const get = (key) => { const n = parseFloat(p[key]); return Number.isFinite(n) ? n : d[key]; };
  const width = get('width') - get('marginInner') - get('marginOuter');
  const height = get('height') - get('marginTop') - get('marginBottom') - get('headerExtent') - get('footerExtent') - get('bodyMarginTop') - get('bodyMarginBottom');
  const fallbackW = d.width - d.marginInner - d.marginOuter;
  const fallbackH = d.height - d.marginTop - d.marginBottom - d.headerExtent - d.footerExtent - d.bodyMarginTop - d.bodyMarginBottom;
  return { w: width > 40 ? width : fallbackW, h: height > 40 ? height : fallbackH };
}

/*
  The marking of this build (decisions.md RL2), when the caller gives the
  release state: unreleased is always NOT RELEASED (no setting can switch it
  off), released uses the project's own watermark if it has one and prints
  "Release N" in the running head. Without a release state (the golden test,
  a conversion) nothing is marked.
*/
function markingOptions(projectDir, project, effective, release) {
  if (!release) {
    try { fs.rmSync(path.join(projectDir, watermarkEngine.WATERMARK_FILE), { force: true }); } catch { /* none */ }
    return { options: {}, marking: null };
  }
  const settings = project.watermark || {};
  const resolved = watermarkEngine.resolveWatermark({ settings: { enabled: !!settings.enabled, text: settings.text || '', style: settings.style }, released: !!release.released });
  const wm = watermarkEngine.writeWatermark(projectDir, resolved, printableBoxMm(effective, project.pipeline));
  const releaseLabel = release.released && release.releaseNumber ? `Release ${release.releaseNumber}` : '';
  return {
    options: { watermarkUri: wm ? wm.uri : undefined, watermarkRepeat: wm ? wm.repeat : undefined, releaseLabel: releaseLabel || undefined },
    marking: { released: !!release.released, releaseNumber: release.released ? release.releaseNumber : null, releaseLabel, watermark: wm ? { text: wm.text, style: wm.style, forced: !!resolved.forced } : null },
  };
}

function commonOptions(projectDir, project, effective) {
  return {
    workDir: projectDir,
    xsltproc: paths.XSLTPROC,
    classification: (effective.publication && effective.publication.securityClassification) || '',
    layoutParams: config.stage2Params(effective),
    csdbDir: (project.input && project.input.csdbDir) || 'csdb',
    mediaDir: (project.input && project.input.mediaDir) || 'Media',
  };
}

/*
  Full publication build. Resolves to { pdf, totalMs, messages, notes }.
  `onMessage` receives progress lines (already free of absolute paths).
*/
function buildPublication(projectDir, { onMessage = () => {}, warmFop = true, log = console, release = null } = {}) {
  return serialise(`${projectDir}|full`, async () => {
    const messages = [];
    const say = (m) => { const line = String(m).split(paths.ROOT).join('<app>').split(projectDir).join('.'); messages.push(line); onMessage(line); };
    let cfg;
    try { cfg = loadConfig(projectDir); } catch (e) { throw new BuildError(`project.json or its house template could not be read: ${e.message.split(projectDir).join('.')}`); }
    const { project, effective } = cfg;
    ensureFrontMatterStencils(projectDir);
    const prep = preparePm(projectDir, project);
    prep.notes.forEach(say);

    const direct = project.pipeline === 's1000dtofo' && prep.isS1000D;
    const mark = markingOptions(projectDir, project, effective, release);
    if (mark.marking && mark.marking.watermark) say(`Watermark: ${mark.marking.watermark.text} (${mark.marking.watermark.style})`);
    try {
      const result = direct
        ? await engine.buildS1000dToFo({
          ...commonOptions(projectDir, project, effective), ...mark.options,
          stylesheetXsl: relFrom(projectDir, DIRECT),
          inputXml: prep.input, foOut: OUTPUT.fo, pdfOut: OUTPUT.pdf,
          warmFop, onMessage: say,
        })
        : await engine.buildJss({
          ...commonOptions(projectDir, project, effective), ...mark.options,
          stage1Xsl: relFrom(projectDir, STAGE1),
          stage2Xsl: relFrom(projectDir, STAGE2),
          inputXml: prep.input, stage1Out: OUTPUT.book, foOut: OUTPUT.fo, pdfOut: OUTPUT.pdf,
          isS1000D: prep.isS1000D,
          stage1Params: config.stage1Params(effective),
          frontMatter: effective.frontMatter,
          branding: effective.branding,
          systemImage: (effective.frontMatter && effective.frontMatter.systemImage) || '',
          warmFop, onMessage: say,
        });
      return { pdf: path.join(projectDir, OUTPUT.pdf), totalMs: result.totalMs, messages, notes: prep.notes, unmapped: result.unmapped || [], marking: mark.marking };
    } catch (err) {
      throw failure(err, projectDir, log);
    }
  });
}

// A synthetic publication module wrapping one data module (no front matter).
function minimalPm(dmHref, classification) {
  const cls = /^\d{2}$/.test(classification) ? classification : '01';
  const href = String(dmHref).replace(/[<>&"]/g, '');
  return `<?xml version="1.0"?>
<pm xmlns:xi="http://www.w3.org/2001/XInclude">
  <identAndStatusSection>
    <pmAddress>
      <pmIdent>
        <pmCode modelIdentCode="PREVIEW" pmIssuer="00000" pmNumber="00000" pmVolume="00"/>
        <language countryIsoCode="US" languageIsoCode="en"/>
        <issueInfo issueNumber="001" inWork="00"/>
      </pmIdent>
      <pmAddressItems>
        <issueDate year="2026" month="01" day="01"/>
        <pmTitle>Preview</pmTitle>
        <shortPmTitle>PREVIEW</shortPmTitle>
      </pmAddressItems>
    </pmAddress>
    <pmStatus>
      <security securityClassification="${cls}"/>
      <responsiblePartnerCompany enterpriseCode="00000"><enterpriseName>PREVIEW</enterpriseName></responsiblePartnerCompany>
      <qualityAssurance><unverified/></qualityAssurance>
    </pmStatus>
  </identAndStatusSection>
  <content>
    <pmEntry>
      <pmEntryTitle>Preview</pmEntryTitle>
      <pmEntry><xi:include href="${href}"/></pmEntry>
    </pmEntry>
  </content>
</pm>
`;
}

/*
  Single data module preview through the project's configured engine.
  `dmRel` is a project-relative path already checked by the caller
  (csdb/DMC-....xml). Resolves to { pdf, totalMs }.
*/
function buildPreview(projectDir, dmRel, { onMessage = () => {}, warmFop = true, log = console, release = null } = {}) {
  return serialise(`${projectDir}|preview`, async () => {
    const { project, effective } = loadConfig(projectDir);
    const say = (m) => onMessage(String(m).split(paths.ROOT).join('<app>').split(projectDir).join('.'));
    const pmText = minimalPm(dmRel, (effective.publication && effective.publication.securityClassification) || '');
    assertContainedIncludes(projectDir, (project.input && project.input.csdbDir) || 'csdb', pmText);
    fs.writeFileSync(path.join(projectDir, PREVIEW.pm), pmText, 'utf8');
    const mark = markingOptions(projectDir, project, effective, release);
    try {
      const result = project.pipeline === 's1000dtofo'
        ? await engine.buildS1000dToFo({
          ...commonOptions(projectDir, project, effective), ...mark.options,
          stylesheetXsl: relFrom(projectDir, DIRECT),
          inputXml: PREVIEW.pm, foOut: PREVIEW.fo, pdfOut: PREVIEW.pdf, warmFop, onMessage: say,
        })
        : await engine.buildJss({
          ...commonOptions(projectDir, project, effective), ...mark.options,
          stage1Xsl: relFrom(projectDir, STAGE1),
          stage2Xsl: relFrom(projectDir, STAGE2),
          inputXml: PREVIEW.pm, stage1Out: PREVIEW.book, foOut: PREVIEW.fo, pdfOut: PREVIEW.pdf,
          isS1000D: true,
          stage1Params: [...config.stage1Params(effective), ['include.frontmatter', '0']],
          warmFop, onMessage: say,
        });
      return { pdf: path.join(projectDir, PREVIEW.pdf), totalMs: result.totalMs, marking: mark.marking };
    } catch (err) {
      throw failure(err, projectDir, log);
    }
  });
}

module.exports = { printableBoxMm, buildPublication, buildPreview, ensureFrontMatterStencils, loadConfig, BuildError, OUTPUT, PREVIEW, minimalPm };
