'use strict';
/*
  Publication settings (Phase 8, decisions.md ST1-ST7): the parts of
  project.json the JSS engine reads (vendor/engine/config.js mergeConfig and
  stage1Params / stage2Params), as the PDF Publisher's settings drawer
  groups them, each value checked before it is stored:

    identity    publication.*            (Settings > Identity)
    publishers  publishers[]             (Settings > Publishers; logos in Media/)
    page        overrides.layout.page    (page size and margins: "Resize Pages")
    type        overrides.layout.fonts, .blankVersos, .toc.sectionDepth
    pipeline    pipeline                 (S1000D: Customize via JSS, or S1000D default)
    watermark   watermark                (released publications; decisions.md RL2)

  Nothing else in project.json can be set through here, so `input` (the
  paths the build reads) and `templateRef` are never taken from a request or
  a package (ST3).
*/

const fs = require('node:fs');
const path = require('node:path');
const { DOCUMENT_TYPES } = require('./jssDocTypes');

const TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
const LENGTH = /^\d{1,4}(\.\d{1,3})?(mm|cm|in|pt)$/;
const IDENTITY = {
  bookName: 'Book name', systemName: 'System name', publicationNo: 'Publication number', inbrNo: 'INBR number',
  nsn: 'NSN', contractNo: 'Contract number', projectCode: 'Project code', ltDocumentNo: 'Document number',
  month: 'Month', year: 'Year', securityClassification: 'Security classification',
  documentType: 'Document type (JSS0251)',
  // Read back for the Identity form's own state (GET enriches it from
  // bookmeta), so a save round-trips it even though nothing renders an
  // input for it; the PUT handler always recomputes it from documentType
  // right after validation, discarding whatever a client sent here.
  documentTypeHeader: 'Document type (running head)',
};
// Page presets (mm), as the reference's figure caps assume: A4 portrait and landscape, A3 landscape (README "Image and icon sizing").
const PAGE_SIZES = {
  'A4 portrait': { width: '210mm', height: '297mm' },
  'A4 landscape': { width: '297mm', height: '210mm' },
  'A3 portrait': { width: '297mm', height: '420mm' },
  'A3 landscape': { width: '420mm', height: '297mm' },
  'Letter portrait': { width: '215.9mm', height: '279.4mm' },
};
const PAGE_FIELDS = ['width', 'height', 'marginTop', 'marginBottom', 'marginInner', 'marginOuter', 'bodyMarginTop', 'bodyMarginBottom', 'headerExtent', 'footerExtent'];
const FONTS = ['Helvetica', 'Times', 'Courier'];
const PIPELINES = ['s1000dtojss', 's1000dtofo'];
const WATERMARK_STYLES = ['horizontal', 'diagonal', 'tiled']; // vendor/engine/watermark.js STYLES in the reference
const CLASSIFICATIONS = ['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET'];

class SettingsError extends Error {
  constructor(field, message) { super(message); this.field = field; this.status = 400; this.code = 'VALIDATION'; }
}
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const str = (field, v, max = 200) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > max || !TEXT.test(v)) throw new SettingsError(field, `${field}: text of at most ${max} characters.`);
  return v.trim();
};
const mm = (len) => {
  const m = /^([\d.]+)(mm|cm|in|pt)$/.exec(len);
  if (!m) return NaN;
  return Number(m[1]) * { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72 }[m[2]];
};

// The current settings, in the shape the API uses, from project.json and the house template under it.
function read(pj, house = {}) {
  const lay = (pj.overrides && pj.overrides.layout) || {};
  const hl = house.layout || {};
  const page = { ...(hl.page || {}), ...(lay.page || {}) };
  const size = Object.entries(PAGE_SIZES).find(([, s]) => mm(s.width) === mm(page.width || '') && mm(s.height) === mm(page.height || ''));
  return {
    identity: Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, String((pj.publication || {})[k] || '')])),
    publishers: (pj.publishers || ((house.branding || {}).publishers) || []).slice(0, 2).map((p) => ({ name: p.name || '', addressLines: p.addressLines || [], logo: p.logo || '' })),
    publishersFromTemplate: !pj.publishers,
    page: { size: size ? size[0] : 'Custom', ...Object.fromEntries(PAGE_FIELDS.map((k) => [k, page[k] || ''])) },
    type: {
      fontFamily: (lay.fonts && lay.fonts.family) || (hl.fonts && hl.fonts.family) || 'Helvetica',
      bodySize: (lay.fonts && lay.fonts.bodySize) || (hl.fonts && hl.fonts.bodySize) || '11pt',
      blankVersos: lay.blankVersos !== undefined ? !!lay.blankVersos : hl.blankVersos !== false,
      tocDepth: Number((lay.toc && lay.toc.sectionDepth) || (hl.toc && hl.toc.sectionDepth) || 1),
    },
    pipeline: PIPELINES.includes(pj.pipeline) ? pj.pipeline : 's1000dtojss',
    watermark: { enabled: !!(pj.watermark && pj.watermark.enabled), text: String((pj.watermark && pj.watermark.text) || ''), style: WATERMARK_STYLES.includes(pj.watermark && pj.watermark.style) ? pj.watermark.style : 'diagonal' },
  };
}

/*
  Apply one group of settings to project.json (a copy is returned). Throws
  SettingsError naming the field. `mediaDir` is the project's Media folder,
  for logo checks.
*/
function apply(pj, group, value, { mediaDir = null } = {}) {
  const out = JSON.parse(JSON.stringify(pj || {}));
  // Publishers are a list; over the API they come as { publishers: [...] }.
  if (group === 'publishers' && isObj(value) && Array.isArray(value.publishers)) value = value.publishers;
  if (!isObj(value) && group !== 'publishers') throw new SettingsError(group, `${group}: expected an object.`);
  out.overrides = isObj(out.overrides) ? out.overrides : {};
  out.overrides.layout = isObj(out.overrides.layout) ? out.overrides.layout : {};
  const lay = out.overrides.layout;
  if (group === 'identity') {
    out.publication = isObj(out.publication) ? out.publication : {};
    for (const [k, v] of Object.entries(value)) {
      if (!IDENTITY[k]) throw new SettingsError(k, `Unknown identity field "${String(k).slice(0, 40)}".`);
      const s = str(IDENTITY[k], v);
      if (k === 'securityClassification' && s && !CLASSIFICATIONS.includes(s.toUpperCase())) throw new SettingsError(k, `Security classification: one of ${CLASSIFICATIONS.join(', ')}.`);
      if (k === 'documentType' && s && !DOCUMENT_TYPES[s]) throw new SettingsError(k, `Document type: one of ${Object.keys(DOCUMENT_TYPES).join(', ')}.`);
      out.publication[k] = k === 'securityClassification' ? s.toUpperCase() : s;
    }
  } else if (group === 'publishers') {
    if (!Array.isArray(value) || value.length > 2) throw new SettingsError('publishers', 'At most two publishers (a joint title page).');
    out.publishers = value.map((p, i) => {
      if (!isObj(p)) throw new SettingsError('publishers', 'Each publisher is an object.');
      const lines = Array.isArray(p.addressLines) ? p.addressLines : [];
      if (lines.length > 4) throw new SettingsError(`publishers.${i}.addressLines`, 'At most four address lines.');
      const logo = str(`Publisher ${i + 1} logo`, p.logo, 120);
      if (logo) {
        if (!/^Media\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|gif)$/i.test(logo)) throw new SettingsError(`publishers.${i}.logo`, 'A logo is an image in Media/ (PNG, JPEG or GIF).');
        if (mediaDir && !fs.existsSync(path.join(mediaDir, path.basename(logo)))) throw new SettingsError(`publishers.${i}.logo`, `${logo} is not in the project. Upload it first.`);
      }
      return { name: str(`Publisher ${i + 1} name`, p.name, 120), addressLines: lines.map((l) => str('Address line', l, 120)).filter(Boolean), logo };
    });
  } else if (group === 'page') {
    lay.page = isObj(lay.page) ? lay.page : {};
    if (value.size && value.size !== 'Custom') {
      if (!PAGE_SIZES[value.size]) throw new SettingsError('size', `Page size: one of ${Object.keys(PAGE_SIZES).join(', ')} or Custom.`);
      Object.assign(lay.page, PAGE_SIZES[value.size]);
    }
    for (const k of PAGE_FIELDS) {
      if (value[k] === undefined || value[k] === '' || (value.size && value.size !== 'Custom' && (k === 'width' || k === 'height'))) continue;
      const v = String(value[k]).trim();
      if (!LENGTH.test(v)) throw new SettingsError(k, `${k}: a length such as 25mm.`);
      lay.page[k] = v;
    }
    const w = mm(lay.page.width || '210mm'), h = mm(lay.page.height || '297mm');
    if (!(w >= 100 && w <= 600 && h >= 100 && h <= 600)) throw new SettingsError('size', 'The page must be between 100 mm and 600 mm each way.');
    const side = ['marginInner', 'marginOuter'].reduce((n, k) => n + (lay.page[k] ? mm(lay.page[k]) : 0), 0);
    if (side >= w - 40) throw new SettingsError('marginInner', 'The side margins leave less than 40 mm of text width.');
  } else if (group === 'type') {
    lay.fonts = isObj(lay.fonts) ? lay.fonts : {};
    if (value.fontFamily !== undefined) {
      if (!FONTS.includes(value.fontFamily)) throw new SettingsError('fontFamily', `Font: one of ${FONTS.join(', ')} (the PDF base fonts).`);
      lay.fonts.family = value.fontFamily;
    }
    if (value.bodySize !== undefined) {
      if (!/^\d{1,2}(\.\d)?pt$/.test(value.bodySize) || parseFloat(value.bodySize) < 6 || parseFloat(value.bodySize) > 16) throw new SettingsError('bodySize', 'Body text size: 6pt to 16pt.');
      lay.fonts.bodySize = value.bodySize;
    }
    if (value.blankVersos !== undefined) lay.blankVersos = !!value.blankVersos;
    if (value.tocDepth !== undefined) {
      const d = Number(value.tocDepth);
      if (!Number.isInteger(d) || d < 1 || d > 4) throw new SettingsError('tocDepth', 'Contents depth: 1 to 4.');
      lay.toc = { ...(isObj(lay.toc) ? lay.toc : {}), sectionDepth: d };
    }
  } else if (group === 'pipeline') {
    if (!PIPELINES.includes(value.pipeline)) throw new SettingsError('pipeline', 'Pipeline: s1000dtojss (customisable) or s1000dtofo (S1000D default).');
    out.pipeline = value.pipeline;
  } else if (group === 'watermark') {
    const text = str('Watermark text', value.text, 40);
    if (value.style !== undefined && !WATERMARK_STYLES.includes(value.style)) throw new SettingsError('style', `Watermark style: ${WATERMARK_STYLES.join(', ')}.`);
    if (value.enabled && !text) throw new SettingsError('text', 'Give the watermark text, or switch it off.');
    out.watermark = { enabled: !!value.enabled, text, style: value.style || 'diagonal' };
  } else {
    throw new SettingsError(group, `Unknown settings group "${String(group).slice(0, 40)}".`);
  }
  return out;
}

const GROUPS = ['identity', 'publishers', 'page', 'type', 'pipeline', 'watermark'];

/*
  The settings a package's project.json may carry into a new project: each
  group read and re-applied through apply(), so anything unknown or invalid
  is dropped and reported, never stored (ST3).
*/
function fromPackage(incoming, base, { mediaDir } = {}) {
  let pj = base;
  const dropped = [];
  if (!isObj(incoming)) return { pj, applied: [], dropped: ['project.json is not an object'] };
  const cur = read(incoming);
  const groups = {
    identity: incoming.publication ? cur.identity : null,
    publishers: Array.isArray(incoming.publishers) ? cur.publishers : null,
    page: incoming.overrides && incoming.overrides.layout && incoming.overrides.layout.page ? cur.page : null,
    pipeline: incoming.pipeline ? { pipeline: incoming.pipeline } : null,
    watermark: incoming.watermark ? cur.watermark : null,
  };
  const applied = [];
  for (const [g, v] of Object.entries(groups)) {
    if (!v) continue;
    try { pj = apply(pj, g, g === 'page' ? { ...v, size: 'Custom' } : v, { mediaDir }); applied.push(g); } catch (e) {
      if (!(e instanceof SettingsError)) throw e;
      dropped.push(`${g}: ${e.message}`);
    }
  }
  return { pj, applied, dropped };
}

module.exports = { read, apply, fromPackage, GROUPS, PAGE_SIZES, PIPELINES, WATERMARK_STYLES, FONTS, CLASSIFICATIONS, IDENTITY, DOCUMENT_TYPES, SettingsError, mm };
