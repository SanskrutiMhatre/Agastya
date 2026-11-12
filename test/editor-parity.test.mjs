// Editor parity with the Agastya original (decisions.md PV15-PV24): the
// commands of client/src/editor/commands.js, run on the golden modules and
// small tables in Node. Each checks the result is valid for the S1000D 4.2
// content model and that nothing outside what the command touched changed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xmldom from '@xmldom/xmldom';
import { contentModelFor } from '../client/src/schema/contentModel.js';
import * as X from '../client/src/editor/xmlDoc.js';
import * as O from '../client/src/editor/ops.js';
import * as C from '../client/src/editor/commands.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const impl = {
  DOMParser: xmldom.DOMParser, XMLSerializer: xmldom.XMLSerializer,
  errorHandler: (report) => ({ warning: () => {}, error: report, fatalError: report }),
};
const parse = (t) => { const p = X.parseXml(t, impl); assert.ok(!p.error, p.error && p.error.message); return p; };
const out = (p) => X.serializeXml(p, impl);
const DESCRIPT = contentModelFor('4.2', 'descript');
const PROCED = contentModelFor('4.2', 'proced');
const golden = (f) => fs.readFileSync(path.join(ROOT, 'samples', 'golden', 'csdb', f), 'utf8');
const D040 = golden('DMC-AGS-A-24-00-00-00A-040A-D.xml');
// Small fixtures have no identification section, so the root itself is not judged.
const valid = (doc, model) => X.contentProblems(doc, model).filter((x) => x.path.length > 0 || doc.getElementsByTagName('identAndStatusSection').length);
const byId = (doc, id) => X.pathOf(Array.from(doc.getElementsByTagName('*')).find((e) => e.getAttribute('id') === id));
const titleOf = (doc, p) => X.elementChildren(X.elementAt(doc, p)).find((c) => c.nodeName === 'title').textContent;

// ---- blocks -----------------------------------------------------------------------------------

test('a block after a title is a paragraph; after a bullet it leaves the list; before is the same, before', () => {
  const p = parse(D040);
  const sec = byId(p.doc, 'par-240040-03');
  const at = C.blockAround(p, DESCRIPT, [...sec, 0], 'after');
  assert.deepEqual(at, [...sec, 1]);
  assert.equal(X.elementAt(p.doc, at).nodeName, 'para');
  assert.deepEqual(valid(p.doc, DESCRIPT), []);
  const before = C.blockAround(p, DESCRIPT, [...sec, 1], 'before');
  assert.deepEqual(before, [...sec, 1]);
  assert.equal(X.elementAt(p.doc, [...sec, 2]).nodeName, 'para');
  const r = out(p);
  assert.equal(r.slice(0, r.indexOf('<levelledPara id="par-240040-03">')), D040.slice(0, D040.indexOf('<levelledPara id="par-240040-03">')), 'nothing before it changed');

  const q = parse('<dmodule><content><description><levelledPara><title>T</title><para>x<randomList><listItem><para>one</para></listItem></randomList></para></levelledPara></description></content></dmodule>');
  const bullet = X.pathOf(q.doc.getElementsByTagName('para')[1]);
  const np = C.blockAround(q, DESCRIPT, bullet, 'after');
  assert.deepEqual(np, [0, 0, 0, 2], 'a paragraph after the one holding the list, not inside the bullet');
});

test('warnings, cautions and notes go to the nearest place the model allows', () => {
  const p = parse(D040);
  const lastPara = [...byId(p.doc, 'par-240040-02'), 3];
  for (const name of ['warning', 'caution', 'note']) {
    const at = C.insertNamed(p, DESCRIPT, lastPara, name);
    assert.ok(at, name);
    assert.equal(X.elementAt(p.doc, at).nodeName, name);
  }
  assert.deepEqual(valid(p.doc, DESCRIPT), []);
});

// ---- sections and steps -------------------------------------------------------------------------

test('sections: new, nested, demoted into the one before and promoted back, reading order kept, valid', () => {
  const p = parse(D040);
  const s3 = byId(p.doc, 'par-240040-03');
  assert.equal(C.canDemote(p.doc, DESCRIPT, s3, 'levelledPara'), true);
  assert.equal(C.canPromote(p.doc, DESCRIPT, s3, 'levelledPara'), false, 'a top-level section has nowhere to go');
  const moved = C.demote(p, DESCRIPT, [...s3, 1], 'levelledPara');
  assert.equal(titleOf(p.doc, moved), 'Indicators');
  assert.equal(X.elementAt(p.doc, moved.slice(0, -1)).getAttribute('id'), 'par-240040-02');
  assert.deepEqual(valid(p.doc, DESCRIPT), []);
  const back = C.promote(p, DESCRIPT, moved, 'levelledPara');
  assert.equal(titleOf(p.doc, back), 'Indicators');
  assert.equal(out(p), D040, 'demote then promote restores the file exactly');

  const sub = C.newSubSection(p, DESCRIPT, [...byId(p.doc, 'par-240040-01'), 0]);
  assert.equal(X.elementAt(p.doc, sub.slice(0, -1)).getAttribute('id'), 'par-240040-01');
  const next = C.newSection(p, DESCRIPT, sub);
  assert.deepEqual(next, [...sub.slice(0, -1), sub[sub.length - 1] + 1], 'a sibling of the nested section');
  assert.deepEqual(valid(p.doc, DESCRIPT), []);
});

test('promoting a section takes the sections after it along as its own, so nothing is reordered', () => {
  const src = '<dmodule><content><description><levelledPara><title>A</title><para>a</para><levelledPara><title>B</title><para>b</para></levelledPara><levelledPara><title>C</title><para>c</para></levelledPara></levelledPara></description></content></dmodule>';
  const p = parse(src);
  const b = [0, 0, 0, 2];
  assert.equal(titleOf(p.doc, b), 'B');
  const at = C.promote(p, DESCRIPT, b, 'levelledPara');
  assert.equal(out(p), '<dmodule><content><description><levelledPara><title>A</title><para>a</para></levelledPara><levelledPara><title>B</title><para>b</para><levelledPara><title>C</title><para>c</para></levelledPara></levelledPara></description></content></dmodule>');
  assert.deepEqual(at, [0, 0, 1]);
  assert.deepEqual(valid(p.doc, DESCRIPT), []);
});

test('steps nest under the step before and come back out', () => {
  const src = '<dmodule><content><procedure><preliminaryRqmts><reqCondGroup><noConds/></reqCondGroup><reqSupportEquips><noSupportEquips/></reqSupportEquips><reqSupplies><noSupplies/></reqSupplies><reqSpares><noSpares/></reqSpares><reqSafety><noSafety/></reqSafety></preliminaryRqmts><mainProcedure><proceduralStep><para>one</para></proceduralStep><proceduralStep><para>two</para></proceduralStep></mainProcedure><closeRqmts><reqCondGroup><noConds/></reqCondGroup></closeRqmts></procedure></content></dmodule>';
  const p = parse(src);
  const two = X.pathOf(p.doc.getElementsByTagName('proceduralStep')[1]);
  const at = C.demote(p, PROCED, two, 'proceduralStep');
  assert.equal(X.elementAt(p.doc, at.slice(0, -1)).nodeName, 'proceduralStep');
  assert.deepEqual(valid(p.doc, PROCED), []);
  C.promote(p, PROCED, at, 'proceduralStep');
  assert.equal(out(p), src);
});

// ---- moving any element -------------------------------------------------------------------------

test('move into the previous sibling and add another of the same kind, only where the model allows', () => {
  const p = parse(D040);
  const s2 = byId(p.doc, 'par-240040-02');
  const s3 = byId(p.doc, 'par-240040-03');
  assert.equal(C.canMoveIntoPrevious(p.doc, DESCRIPT, s3), true);
  assert.equal(C.canMoveIntoPrevious(p.doc, DESCRIPT, [...s2, 1]), false, 'a paragraph cannot go into a title');
  assert.equal(C.canAddSibling(p.doc, DESCRIPT, [...s2, 0]), false, 'a second title is not allowed');
  const added = C.addSibling(p, DESCRIPT, [...s2, 1]);
  assert.equal(X.elementAt(p.doc, added).nodeName, 'para');
  const at = C.moveIntoPrevious(p, DESCRIPT, byId(p.doc, 'par-240040-03'));
  assert.equal(X.elementAt(p.doc, at.slice(0, -1)).getAttribute('id'), 'par-240040-02');
  assert.deepEqual(valid(p.doc, DESCRIPT), []);
});

// ---- lists --------------------------------------------------------------------------------------

test('Enter on an empty last bullet ends the list with a paragraph after it; in a nested list it moves out', () => {
  const src = '<dmodule><content><description><levelledPara><title>T</title><para>x<randomList><listItem><para>one</para></listItem><listItem><para/></listItem></randomList></para></levelledPara></description></content></dmodule>';
  const p = parse(src);
  const empty = X.pathOf(p.doc.getElementsByTagName('para')[2]);
  assert.equal(C.exitList(p, DESCRIPT, X.pathOf(p.doc.getElementsByTagName('para')[1]), O.outdentItem), null, 'not for a bullet with text');
  const at = C.exitList(p, DESCRIPT, empty, O.outdentItem);
  assert.equal(out(p), '<dmodule><content><description><levelledPara><title>T</title><para>x<randomList><listItem><para>one</para></listItem></randomList></para><para/></levelledPara></description></content></dmodule>');
  assert.deepEqual(at, [0, 0, 0, 2]);

  const n = parse('<dmodule><content><description><para>x<randomList><listItem><para>one<randomList><listItem><para>a</para></listItem><listItem><para/></listItem></randomList></para></listItem></randomList></para></description></content></dmodule>');
  const inner = X.pathOf(n.doc.getElementsByTagName('para')[3]);
  assert.ok(C.exitList(n, DESCRIPT, inner, O.outdentItem));
  assert.equal(n.doc.getElementsByTagName('randomList')[0].getElementsByTagName('listItem').length, 3);
  assert.deepEqual(valid(n.doc, DESCRIPT), []);
});

// ---- tables -------------------------------------------------------------------------------------

const TABLE = (rows, cols = 3) => `<dmodule><content><description><para>before</para><table id="t"><tgroup cols="${cols}">${Array.from({ length: cols }, (_, i) => `<colspec colname="c${i + 1}"/>`).join('')}<tbody>${rows}</tbody></tgroup></table><para>after</para></description></content></dmodule>`;
const R = (...cells) => `<row>${cells.map((c) => (typeof c === 'string' ? `<entry><para>${c}</para></entry>` : `<entry${Object.entries(c.a).map(([k, v]) => ` ${k}="${v}"`).join('')}><para>${c.t}</para></entry>`)).join('')}</row>`;
const cellOf = (doc, text) => X.pathOf(Array.from(doc.getElementsByTagName('entry')).find((e) => e.textContent === text));
const grid = (doc) => O.tableGrid(doc.getElementsByTagName('tgroup')[0]).cells.map((c) => `${c.entry.textContent}@r${c.r}c${c.start}-${c.end}x${c.rows}`).join(' ');

test('cell alignment: only values the schema permits; removing it lets the column decide', () => {
  const p = parse(TABLE(R('A', 'B', 'C')));
  const opts = C.cellAlignOptions(DESCRIPT);
  assert.ok(opts.align.includes('center') && opts.valign.includes('middle'), JSON.stringify(opts));
  C.setCellAttr(p, DESCRIPT, cellOf(p.doc, 'A'), 'align', 'center');
  C.setCellAttr(p, DESCRIPT, cellOf(p.doc, 'A'), 'valign', 'bottom');
  assert.equal(C.setCellAttr(p, DESCRIPT, cellOf(p.doc, 'A'), 'align', 'sideways'), null);
  assert.match(out(p), /<entry align="center" valign="bottom"><para>A<\/para><\/entry>/);
  C.setCellAttr(p, DESCRIPT, cellOf(p.doc, 'A'), 'align', null);
  assert.match(out(p), /<entry valign="bottom"><para>A<\/para><\/entry>/);
});

test('a range of cells merges into its top-left cell; a range cutting a merged cell, or emptying a row, is refused', () => {
  const p = parse(TABLE(R('A', 'B', 'C') + R('D', 'E', 'F') + R('G', 'H', 'I')));
  const at = C.mergeRange(p, cellOf(p.doc, 'E'), cellOf(p.doc, 'A'));
  assert.ok(at);
  const q = parse(out(p));
  assert.equal(grid(q.doc), 'ABDE@r0c0-1x2 C@r0c2-2x1 F@r1c2-2x1 G@r2c0-0x1 H@r2c1-1x1 I@r2c2-2x1');
  assert.deepEqual(valid(q.doc, DESCRIPT), []);
  assert.match(C.cellRange(q.doc, cellOf(q.doc, 'H'), cellOf(q.doc, 'G')).reason || '', /^$/);
  assert.match(C.cellRange(q.doc, cellOf(q.doc, 'ABDE'), cellOf(q.doc, 'H')).reason || 'ok', /^ok$/, 'a range including the whole merged cell is fine');
  // C over F would leave the second row (D and E are already in the merged cell) with no cell of its own.
  const cut = parse(out(p));
  assert.match(C.cellRange(cut.doc, cellOf(cut.doc, 'C'), cellOf(cut.doc, 'F')).reason, /no cell of its own/);
  const two = parse(TABLE(R('A', 'B') + R('C', 'D'), 2));
  assert.equal(C.cellRange(two.doc, cellOf(two.doc, 'A'), cellOf(two.doc, 'C')).reason, undefined, 'D keeps the second row');
  assert.match(C.cellRange(two.doc, cellOf(two.doc, 'A'), cellOf(two.doc, 'D')).reason, /no cell of its own/, 'the whole table would empty the second row');
  const part = parse(TABLE(R({ a: { namest: 'c1', nameend: 'c2' }, t: 'AB' }, 'C') + R('D', 'E', 'F')));
  assert.match(C.cellRange(part.doc, cellOf(part.doc, 'C'), cellOf(part.doc, 'E')).reason, /partly outside/);
});

test('columns are added and deleted in tables with merged cells: spans widen and narrow, the grid stays whole', () => {
  const src = TABLE(R({ a: { namest: 'c1', nameend: 'c2' }, t: 'AB' }, 'C') + R('D', 'E', 'F') + R({ a: { morerows: 1 }, t: 'G' }, 'H', 'I') + R('K', 'L'));
  const p = parse(src);
  assert.equal(grid(p.doc), 'AB@r0c0-1x1 C@r0c2-2x1 D@r1c0-0x1 E@r1c1-1x1 F@r1c2-2x1 G@r2c0-0x2 H@r2c1-1x1 I@r2c2-2x1 K@r3c1-1x1 L@r3c2-2x1');
  C.addColumnSpanned(p, cellOf(p.doc, 'E'), -1);
  let q = parse(out(p));
  assert.equal(q.doc.getElementsByTagName('tgroup')[0].getAttribute('cols'), '4');
  assert.equal(grid(q.doc), 'AB@r0c0-2x1 C@r0c3-3x1 D@r1c0-0x1 @r1c1-1x1 E@r1c2-2x1 F@r1c3-3x1 G@r2c0-0x2 @r2c1-1x1 H@r2c2-2x1 I@r2c3-3x1 @r3c1-1x1 K@r3c2-2x1 L@r3c3-3x1');
  assert.deepEqual(valid(q.doc, DESCRIPT), []);
  // And out again: the spanning cell narrows back; the new single cells go.
  const back = C.deleteColumnSpanned(q, X.pathOf(Array.from(q.doc.getElementsByTagName('entry')).find((e) => e.getAttribute('colname') && !e.textContent && X.elementChildren(e.parentNode).indexOf(e) === 1)));
  assert.ok(back);
  const r = parse(out(q));
  assert.equal(grid(r.doc), 'AB@r0c0-1x1 C@r0c2-2x1 D@r1c0-0x1 E@r1c1-1x1 F@r1c2-2x1 G@r2c0-0x2 H@r2c1-1x1 I@r2c2-2x1 K@r3c1-1x1 L@r3c2-2x1');
  assert.deepEqual(valid(r.doc, DESCRIPT), []);
  // A column whose removal would leave a row with no cell is refused.
  const lone = parse(TABLE(R({ a: { namest: 'c1', nameend: 'c2' }, t: 'AB' }) + R('C', 'D'), 2));
  assert.equal(C.canDeleteColumnSpanned(lone.doc, cellOf(lone.doc, 'C')), true, 'the merged cell narrows');
  const single = parse(TABLE(R('A') + R('B'), 1));
  assert.equal(C.canDeleteColumnSpanned(single.doc, cellOf(single.doc, 'A')), false);
});

test('column widths are read and written on the colspecs; malformed widths are refused', () => {
  const p = parse(D040);
  const cellPath = cellOf(p.doc, 'OUT 1');
  assert.deepEqual(C.columnWidths(p.doc, cellPath), ['25mm', '1*', '30mm']);
  assert.equal(C.setColumnWidths(p, cellPath, ['25mm', 'wide', '30mm']), null);
  assert.ok(C.setColumnWidths(p, cellPath, ['20mm', '2*', '']));
  const r = out(p);
  assert.match(r, /<colspec colname="c1" colwidth="20mm"\/>\s*<colspec colname="c2" colwidth="2\*"\/>\s*<colspec colname="c3"\/>/);
  assert.equal(r.replace(/<colspec[^>]*\/>/g, ''), D040.replace(/<colspec[^>]*\/>/g, ''), 'only the colspecs changed');
});

// ---- references ---------------------------------------------------------------------------------

test('data module references carry the target\'s issue and title when asked; publication module references are built from its code', () => {
  const base = O.dmRefSpec('AGS-A-24-00-00-00A-030A-D');
  const spec = C.fullDmRefSpec(base, { issueNumber: '002', inWork: '01', techName: 'PDU <200>', infoName: 'Data' }, { withTitle: true, withIssue: true });
  const p = parse('<dmodule><content><description><para>See </para></description></content></dmodule>');
  O.insertInlineSpec(p, [0, 0, 0], 0, 4, spec);
  assert.match(out(p), /<dmRef><dmRefIdent><dmCode [^>]*\/><issueInfo issueNumber="002" inWork="01"\/><\/dmRefIdent><dmRefAddressItems><dmTitle><techName>PDU &lt;200&gt;<\/techName><infoName>Data<\/infoName><\/dmTitle><\/dmRefAddressItems><\/dmRef>/);
  assert.deepEqual(valid(p.doc, DESCRIPT), []);
  const pm = C.pmCodeOf(fs.readFileSync(path.join(ROOT, 'samples', 'golden', 'publication.xml'), 'utf8'));
  assert.equal(pm.label, 'PMC-AGS-0AGS1-00001-00');
  const q = parse('<dmodule><content><description><para>See </para></description></content></dmodule>');
  O.insertInlineSpec(q, [0, 0, 0], 0, 4, C.pmRefSpec(pm, { withTitle: true }));
  assert.match(out(q), /<pmRef><pmRefIdent><pmCode modelIdentCode="AGS" pmIssuer="0AGS1" pmNumber="00001" pmVolume="00"\/><\/pmRefIdent><pmRefAddressItems><pmTitle>[^<]+<\/pmTitle><\/pmRefAddressItems><\/pmRef>/);
  assert.deepEqual(valid(q.doc, DESCRIPT), []);
  assert.equal(C.pmCodeOf('<pm><pmCode modelIdentCode="AGS"/></pm>'), null, 'an incomplete code builds nothing');
});

// ---- tools --------------------------------------------------------------------------------------

test('find and replace works on the content text only, keeps entities, and changes only the matching text', () => {
  const src = '<dmodule><identAndStatusSection><dmTitle><techName>Fan</techName></dmTitle></identAndStatusSection><content><description><para>The fan &deg; and the FAN <emphasis>fan</emphasis>.</para></description></content></dmodule>';
  const p = parse(src);
  assert.equal(C.findText(p.doc, 'fan').length, 3);
  assert.equal(C.findText(p.doc, 'fan', { matchCase: true }).length, 2);
  assert.equal(C.replaceMatches(p, C.findText(p.doc, 'fan'), 'blower'), 3);
  assert.equal(out(p), '<dmodule><identAndStatusSection><dmTitle><techName>Fan</techName></dmTitle></identAndStatusSection><content><description><para>The blower &deg; and the blower <emphasis>blower</emphasis>.</para></description></content></dmodule>');
  const q = parse(src);
  C.replaceMatches(q, C.findText(q.doc, 'and'), '<&>');
  assert.match(out(q), /The fan &deg; &lt;&amp;&gt; the FAN/);
});

test('word count, ids given where missing, and re-sequencing ids with every reference following', () => {
  const p = parse(D040);
  const wc = C.wordCount(p.doc);
  assert.equal(wc.figures, 1);
  assert.equal(wc.tables, 1);
  assert.equal(wc.sections, 3);
  assert.ok(wc.words > 100);
  const r = C.resequenceIds(p, 'figure');
  assert.deepEqual(r, { changed: 1 });
  C.resequenceIds(p, 'table');
  const x = out(p);
  assert.match(x, /<figure id="fig-0001">/);
  assert.match(x, /<internalRef internalRefId="fig-0001" internalRefTargetType="irtt01"\/>/);
  assert.match(x, /<table id="tab-0001">/);
  assert.match(x, /<internalRef internalRefId="tab-0001" internalRefTargetType="irtt02"\/>/);
  assert.deepEqual(C.liveChecks(parse(x)).filter((c) => /points to/.test(c.message)), []);
  const clash = parse('<dmodule><content><description><para id="fig-0001">x</para><figure id="f9"><title>t</title><graphic infoEntityIdent="ICN-A"/></figure></description></content></dmodule>');
  assert.equal(C.resequenceIds(clash, 'figure'), null, 'an id already used elsewhere is not taken');
  const bare = parse('<dmodule><content><description><levelledPara><title>a</title><para>x</para></levelledPara><levelledPara id="par-0001"><title>b</title><para>y</para></levelledPara></description></content></dmodule>');
  assert.equal(C.assignIds(bare, DESCRIPT), 1);
  assert.match(out(bare), /<levelledPara id="par-0002"><title>a/);
});

test('re-indenting lays out element-only content, leaves text and mixed content exactly, and is stable', () => {
  const src = '<dmodule><content><description>\n<levelledPara><title>T  x</title><para>a <emphasis>b</emphasis>   c<randomList><listItem><para>z</para></listItem></randomList></para></levelledPara><!-- c --></description></content></dmodule>';
  const p = parse(src);
  assert.ok(C.reindent(p, DESCRIPT) > 0);
  const r = out(p);
  assert.equal(r, '<dmodule>\n  <content>\n    <description>\n      <levelledPara>\n        <title>T  x</title>\n        <para>a <emphasis>b</emphasis>   c<randomList><listItem><para>z</para></listItem></randomList></para>\n      </levelledPara>\n      <!-- c -->\n    </description>\n  </content>\n</dmodule>');
  const again = parse(r);
  assert.equal(C.reindent(again, DESCRIPT), 0, 'a second pass changes nothing');
  for (const f of fs.readdirSync(path.join(ROOT, 'samples', 'golden', 'csdb')).filter((x) => x.endsWith('.xml'))) {
    const g = parse(golden(f));
    const texts = (doc) => Array.from(doc.getElementsByTagName('*')).filter((e) => DESCRIPT.holdsText(e.nodeName) || PROCED.holdsText(e.nodeName)).map((e) => e.textContent);
    const before = texts(g.doc);
    C.reindent(g, f.includes('520A') || f.includes('310A') || f.includes('720A') || f.includes('320A') ? PROCED : DESCRIPT);
    const h = parse(out(g));
    assert.deepEqual(texts(h.doc), before, f);
    assert.ok(out(g).startsWith(golden(f).slice(0, golden(f).indexOf('<dmodule'))), `${f}: the prolog is kept`);
  }
});

test('live checks: a graphic with no ICN or an undeclared one, a broken reference, an id used twice, an empty title', () => {
  const p = parse('<!DOCTYPE dmodule [\n<!ENTITY ICN-OK SYSTEM "ICN-OK.png" NDATA png>\n]>\n<dmodule><content><description><levelledPara id="a"><title/><para>See <internalRef internalRefId="nope"/> and <internalRef internalRefId="f1"/></para><figure id="f1"><title>x</title><graphic infoEntityIdent="ICN-OK"/><graphic infoEntityIdent="ICN-NOT"/><graphic/></figure><para id="a">dup</para></levelledPara></description></content></dmodule>');
  const msgs = C.liveChecks(p).map((c) => `${c.sev}: ${c.message}`);
  assert.deepEqual(msgs.sort(), [
    'error: ICN-NOT is not declared in the DOCTYPE; insert the figure again from the Figure dialog, or declare it in the XML view.',
    'error: The id a is used twice.',
    'error: This graphic has no ICN.',
    'error: This reference points to nope, which is not in this module.',
    'warning: This title is empty; it prints as a blank line.',
  ]);
  assert.deepEqual(C.liveChecks(parse(D040)), [], 'the golden module is clean');
});

// ---- functional repair: defects reproduced in the browser (audit A1-A11) ----------------------

const PL = new Set(['para', 'notePara', 'warningAndCautionPara', 'simplePara']);

test('Enter in the middle of a paragraph splits it; the second half keeps its inline markup; nothing is dropped', () => {
  const src = '<dmodule><content><description><levelledPara><title>T</title><para>Split me <emphasis>here</emphasis> please.</para></levelledPara></description></content></dmodule>';
  const p = parse(src);
  const at = C.splitBlock(p, DESCRIPT, [0, 0, 0, 1], 0, 6);
  assert.deepEqual(at, [0, 0, 0, 2]);
  assert.equal(out(p), '<dmodule><content><description><levelledPara><title>T</title><para>Split </para><para>me <emphasis>here</emphasis> please.</para></levelledPara></description></content></dmodule>');
  // At the very end: an empty paragraph follows; at the start: the whole text moves.
  const q = parse(src);
  C.splitBlock(q, DESCRIPT, [0, 0, 0, 1], 2, 8);
  assert.match(out(q), /please\.<\/para><para\/>/);
  // A title splits into a paragraph after it.
  const t = parse(src);
  C.splitBlock(t, DESCRIPT, [0, 0, 0, 0], 0, 0, { name: 'para', slot: { parentPath: [0, 0, 0], index: 1 } });
  assert.match(out(t), /<title><\/title><para>T<\/para><para>Split me/, 'an emptied element keeps its open and close tags');
  // A bullet splits into a new bullet.
  const l = parse('<dmodule><content><description><para>x<randomList><listItem><para>one two</para></listItem></randomList></para></description></content></dmodule>');
  C.splitBlock(l, DESCRIPT, [0, 0, 0, 0, 0, 0], 0, 3, { name: 'para', wrap: 'listItem', slot: { parentPath: [0, 0, 0, 0], index: 1 } });
  assert.match(out(l), /<listItem><para>one<\/para><\/listItem><listItem><para> two<\/para><\/listItem>/);
  // Entities survive the split on both sides.
  const e = parse('<dmodule><content><description><para>10 &deg;C to 20 &deg;C</para></description></content></dmodule>');
  C.splitBlock(e, DESCRIPT, [0, 0, 0], 0, 10); // offsets count the entity as the page shows it, &deg; (5 characters)
  assert.equal(out(e), '<dmodule><content><description><para>10 &deg;C </para><para>to 20 &deg;C</para></description></content></dmodule>');
});

test('Backspace at the start: an empty paragraph goes, a paragraph joins the one before; never where the model needs it', () => {
  const p = parse('<dmodule><content><description><levelledPara><title>T</title><para>one</para><para/><para>two <emphasis>x</emphasis></para></levelledPara></description></content></dmodule>');
  const r1 = C.backspaceAtStart(p, DESCRIPT, [0, 0, 0, 2], PL);
  assert.deepEqual(r1, { path: [0, 0, 0, 1], focus: 'end' });
  const r2 = C.backspaceAtStart(p, DESCRIPT, [0, 0, 0, 2], PL);
  assert.deepEqual(r2, { path: [0, 0, 0, 1], focus: { nodeIndex: 0, offset: 3 } });
  assert.equal(out(p), '<dmodule><content><description><levelledPara><title>T</title><para>onetwo <emphasis>x</emphasis></para></levelledPara></description></content></dmodule>');
  const only = parse('<dmodule><content><description><para>x<randomList><listItem><para/></listItem></randomList></para></description></content></dmodule>');
  assert.equal(C.backspaceAtStart(only, DESCRIPT, [0, 0, 0, 0, 0, 0], PL), null, 'a bullet needs its paragraph, a list its bullet');
  const two = parse('<dmodule><content><description><para>x<randomList><listItem><para>a</para></listItem><listItem><para/></listItem></randomList></para></description></content></dmodule>');
  assert.ok(C.backspaceAtStart(two, DESCRIPT, [0, 0, 0, 0, 1, 0], PL));
  assert.match(out(two), /<randomList><listItem><para>a<\/para><\/listItem><\/randomList>/);
});

test('rows in tables with merged cells: a row inside a span is spanned too; deleting a spanning cell\'s row keeps its content below', () => {
  const src = TABLE(R({ a: { morerows: 1 }, t: 'A' }, 'B', 'C') + R('E', 'F') + R('G', 'H', 'I'));
  const p = parse(src);
  C.addRowSpanned(p, cellOf(p.doc, 'B'), 1);
  let q = parse(out(p));
  assert.equal(grid(q.doc), 'A@r0c0-0x3 B@r0c1-1x1 C@r0c2-2x1 @r1c1-1x1 @r1c2-2x1 E@r2c1-1x1 F@r2c2-2x1 G@r3c0-0x1 H@r3c1-1x1 I@r3c2-2x1');
  assert.deepEqual(valid(q.doc, DESCRIPT), []);
  // Below the spanned rows: a full row.
  C.addRowSpanned(q, cellOf(q.doc, 'E'), 1);
  q = parse(out(q));
  assert.match(grid(q.doc), /F@r2c2-2x1 @r3c0-0x1 @r3c1-1x1 @r3c2-2x1 G@r4c0/);
  const d = parse(src);
  C.deleteRowSpanned(d, cellOf(d.doc, 'B'));
  const dq = parse(out(d));
  assert.equal(grid(dq.doc), 'A@r0c0-0x1 E@r0c1-1x1 F@r0c2-2x1 G@r1c0-0x1 H@r1c1-1x1 I@r1c2-2x1');
  assert.match(out(d), /<row><entry colname="c1"><para>A<\/para><\/entry><entry><para>E<\/para><\/entry>/);
  // Deleting a row a span crosses shortens the span.
  const s = parse(src);
  C.deleteRowSpanned(s, cellOf(s.doc, 'E'));
  assert.equal(grid(parse(out(s)).doc), 'A@r0c0-0x1 B@r0c1-1x1 C@r0c2-2x1 G@r1c0-0x1 H@r1c1-1x1 I@r1c2-2x1');
  assert.equal(C.deleteRowSpanned(parse(TABLE(R('A', 'B', 'C'))), [0, 0, 1, 1, 3, 0, 0]), null, 'a body keeps a row');
});

test('change into another element keeps content; "None" is replaced by an item; content is never thrown away', () => {
  const p = parse('<dmodule><content><description><para>x<randomList><listItem><para>a</para></listItem></randomList></para></description></content></dmodule>');
  const list = [0, 0, 0, 0];
  const opts = C.replacements(p.doc, DESCRIPT, list);
  assert.ok(opts.some((o) => o.name === 'sequentialList' && o.kind === 'change'), JSON.stringify(opts));
  C.replaceElement(p, DESCRIPT, list, 'sequentialList');
  assert.equal(out(p), '<dmodule><content><description><para>x<sequentialList><listItem><para>a</para></listItem></sequentialList></para></description></content></dmodule>');
  const proc = parse(golden('DMC-AGS-A-24-10-00-00A-520A-D.xml'));
  const none = X.pathOf(proc.doc.getElementsByTagName('noSupplies')[0]);
  const r = C.replacements(proc.doc, PROCED, none);
  assert.ok(r.some((o) => o.name === 'supplyDescrGroup' && o.kind === 'replace'), JSON.stringify(r));
  C.replaceElement(proc, PROCED, none, 'supplyDescrGroup');
  const after = parse(out(proc));
  assert.equal(after.doc.getElementsByTagName('noSupplies').length, 0);
  assert.equal(after.doc.getElementsByTagName('supplyDescr').length, 1);
  assert.deepEqual(valid(after.doc, PROCED), []);
  // A paragraph with text is never offered a replacement that would drop it.
  const t = parse(D040);
  assert.deepEqual(C.replacements(t.doc, DESCRIPT, [...byId(t.doc, 'par-240040-03'), 1]).filter((o) => o.kind === 'replace'), []);
});

test('duplicate copies an element with its content and gives the copy unique ids; references to modules outside the project are found', () => {
  const p = parse(D040);
  const fig = byId(p.doc, 'fig-240040-01');
  const at = C.duplicate(p, DESCRIPT, fig);
  assert.equal(X.elementAt(p.doc, at).getAttribute('id'), 'fig-240040-01-2');
  assert.match(out(p), /<figure id="fig-240040-01-2">\s*<title>PDU-200 block diagram<\/title>/);
  assert.deepEqual(C.liveChecks(parse(out(p))).filter((c) => /twice/.test(c.message)), []);
  assert.deepEqual(valid(p.doc, DESCRIPT), []);
  const refs = C.unresolvedDmRefs(p.doc, new Set(['AGS-A-24-00-00-00A-099A-D']), 'AGS-A-24-00-00-00A-040A-D');
  assert.equal(refs.length, 1);
  assert.match(refs[0].message, /DMC-AGS-A-24-00-00-00A-030A-D is not a data module of this project/);
  assert.deepEqual(C.unresolvedDmRefs(p.doc, new Set(['AGS-A-24-00-00-00A-030A-D']), ''), []);
  assert.deepEqual(C.unresolvedDmRefs(p.doc, new Set(), ''), [], 'not judged when the project\'s codes are not known');
});

test('a reference\'s issue is added to it later without touching the text around it; symbols are live-checked like graphics', () => {
  const p = parse('<dmodule><content><description><para>See <dmRef><dmRefIdent><dmCode modelIdentCode="A" systemDiffCode="A" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="040" infoCodeVariant="A" itemLocationCode="D"/></dmRefIdent></dmRef> typed on.</para></description></content></dmodule>');
  const ref = [0, 0, 0, 0];
  assert.deepEqual(C.addRefIssue(p, ref, { issueNumber: '003', inWork: '01' }), ref);
  assert.match(out(p), /<dmCode [^>]*\/><issueInfo issueNumber="003" inWork="01"\/><\/dmRefIdent><\/dmRef> typed on\.<\/para>/);
  assert.equal(C.addRefIssue(p, ref, { issueNumber: '004', inWork: '00' }), false, 'once only');
  assert.equal(C.addRefIssue(parse('<dmodule><content><description><para>x</para></description></content></dmodule>'), [0, 0, 0], { issueNumber: '001', inWork: '00' }), false, 'only a dmRef');
  assert.equal(C.addRefIssue(parse(out(p)), ref, { issueNumber: '1"/><x', inWork: '00' }), false, 'malformed values are refused');
  const s = parse('<!DOCTYPE dmodule [\n<!ENTITY ICN-OK SYSTEM "ICN-OK.png" NDATA png>\n]>\n<dmodule><content><description><para>Press <symbol infoEntityIdent="ICN-OK"/> <symbol infoEntityIdent="ICN-NO"/> <symbol/></para></description></content></dmodule>');
  assert.deepEqual(C.liveChecks(s).map((c) => c.message).sort(), ['ICN-NO is not declared in the DOCTYPE; insert the figure again from the Figure dialog, or declare it in the XML view.', 'This symbol has no ICN.']);
});
