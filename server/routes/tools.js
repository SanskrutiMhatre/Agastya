'use strict';
/*
  Standalone author tools: no project is needed first.

  DMC creator: typed-in rows (code, title, schema - what a piece of work
  needs), or a DMRL spreadsheet someone already has, both built into a zip
  of shell XML files the same way "Import from a DMRL spreadsheet"
  (routes/content.js dmrl/preview, dmrl/import) builds one project's new
  modules - just with no project to write into yet. Download the zip, then
  bring it into any project later (New project -> From a package, or a
  project's own "Import package").

    POST /api/tools/dmc/shells.zip    typed-in rows, as a zip of shells
    POST /api/tools/dmrl/preview      read a spreadsheet, list its rows
    POST /api/tools/dmrl/shells.zip   its chosen rows, as a zip of shells
*/

const multer = require('multer');
const JSZip = require('jszip');
const { validateObject } = require('../http/validate');
const { sendError } = require('../http/errors');
const { ContentError } = require('../content/xmlcheck');
const dmrl = require('../content/dmrl');
const { renderShell, SCHEMA_TYPES } = require('../content/shells');
const { dmcFilename, parseDmcString } = require('../content/dmc');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10, fieldSize: 64 * 1024 } }).single('file');
const DMRL_FIELDS = { schemaType: { type: 'string', enum: ['descript', 'proced', 'ipd', 'auto'], label: 'Schema' } };
const NEW_DM_DEFAULTS = { languageIsoCode: 'en', countryIsoCode: 'IN', securityClassification: '01', issueNumber: '001', inWork: '00' };

function register({ app, authz, now }) {
  const { can } = authz;
  const wrap = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof ContentError) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  };

  async function readUpload(req) {
    if (!req.file) throw new ContentError(400, 'VALIDATION', 'Choose a DMRL spreadsheet (.xlsx) to upload.');
    try { return await dmrl.readDmrl(req.file.buffer); } catch { throw new ContentError(400, 'UNREADABLE', 'The spreadsheet could not be read. Save it as an Excel .xlsx workbook and try again.'); }
  }

  /*
    The direct path (decisions.md UI9): type the data modules a piece of
    work actually needs - code, title, schema, one row per module - rather
    than first building a spreadsheet elsewhere to upload. The DMRL routes
    below stay for the other direction: a spreadsheet someone already has.
  */
  app.post('/api/tools/dmc/shells.zip',
    can('project.import'),
    wrap(async (req, res) => {
      const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
      if (!rows || !rows.length) throw new ContentError(400, 'VALIDATION', 'Add at least one data module.');
      if (rows.length > 500) throw new ContentError(400, 'VALIDATION', 'No more than 500 at once.');
      const zip = new JSZip();
      const seen = new Set();
      let made = 0;
      for (const [i, row] of rows.entries()) {
        const codeIn = String((row && row.dmc) || '').trim();
        const dmc = parseDmcString(codeIn);
        if (!dmc) throw new ContentError(400, 'BAD_DMC', `Row ${i + 1}: "${codeIn || '(empty)'}" is not a valid data module code (e.g. AGS-A-24-00-00-00A-040A-D).`);
        const schemaType = (row && row.schemaType) || 'descript';
        if (!SCHEMA_TYPES[schemaType]) throw new ContentError(400, 'VALIDATION', `Row ${i + 1}: unknown schema "${schemaType}".`);
        const techName = String((row && row.techName) || '').trim();
        if (!techName) throw new ContentError(400, 'VALIDATION', `Row ${i + 1}: a technical name is required.`);
        const name = dmcFilename(dmc);
        if (seen.has(name)) throw new ContentError(400, 'DUPLICATE_DMC', `Row ${i + 1}: ${codeIn} is also used by an earlier row.`);
        seen.add(name);
        const xml = renderShell({ ...NEW_DM_DEFAULTS, schemaType, dmc, techName, infoName: String((row && row.infoName) || '').trim(), brex: null, date: now() });
        zip.file(`csdb/${name}`, xml);
        made++;
      }
      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="dmc-shells-${made}.zip"` });
      res.send(buf);
    }));

  app.post('/api/tools/dmrl/preview',
    can('project.import'),
    upload,
    wrap(async (req, res) => {
      const fields = validateObject(DMRL_FIELDS, req.body || {});
      if (!fields.ok) return sendError(res, 400, fields.code, fields.error);
      const sheet = await readUpload(req);
      const choice = fields.value.schemaType || 'descript';
      res.json({
        sheetName: sheet.sheetName, columns: sheet.columns, skipped: sheet.skipped,
        rows: sheet.rows.map((r) => ({ row: r.row, dmc: r.dmcString, techName: r.techName, infoName: r.infoName, schemaType: dmrl.schemaFor(choice, r.dmc) })),
      });
    }));

  app.post('/api/tools/dmrl/shells.zip',
    can('project.import'),
    upload,
    wrap(async (req, res) => {
      const fields = validateObject({ ...DMRL_FIELDS, rows: { type: 'string', max: 20000, pattern: /^\d+(,\d+)*$/ } }, req.body || {});
      if (!fields.ok) return sendError(res, 400, fields.code, fields.error);
      const sheet = await readUpload(req);
      const wanted = fields.value.rows ? new Set(fields.value.rows.split(',').map(Number)) : null;
      const choice = fields.value.schemaType || 'descript';
      const zip = new JSZip();
      const seen = new Set();
      let made = 0;
      for (const r of sheet.rows) {
        if (wanted && !wanted.has(r.row)) continue;
        const name = dmcFilename(r.dmc);
        if (seen.has(name)) continue; // two rows naming the same module: the first wins, as a project import would refuse the second
        seen.add(name);
        const xml = renderShell({
          ...NEW_DM_DEFAULTS, schemaType: dmrl.schemaFor(choice, r.dmc), dmc: r.dmc,
          techName: r.techName || 'Untitled', infoName: r.infoName, brex: null, date: now(),
        });
        zip.file(`csdb/${name}`, xml);
        made++;
      }
      if (!made) throw new ContentError(400, 'NOTHING_TO_CREATE', 'No rows were chosen, or the spreadsheet has none Agastya can read.');
      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="dmc-shells.zip"' });
      res.send(buf);
    }));
}

module.exports = { register };
