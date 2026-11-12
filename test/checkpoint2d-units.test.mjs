// Checkpoint 2d units (decisions.md PV1-PV9): the lossless document layer and
// the page view's editing operations, run in Node with xmldom as the browser.
//
//   - opening and saving without an edit is byte-identical, for every golden
//     module, every shell, the publication module and synthetic documents
//     with every kind of markup the editor does not model;
//   - an edit changes only the element it touched (a property test over
//     random edits of every golden module);
//   - comments, processing instructions, CDATA, entities, character
//     references and unknown elements survive edits elsewhere;
//   - formatting, references, figures, tables, lists and ids build valid
//     S1000D, and text is always escaped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xmldom from '@xmldom/xmldom';
import { contentModelFor } from '../client/src/schema/contentModel.js';
import * as X from '../client/src/editor/xmlDoc.js';
import * as O from '../client/src/editor/ops.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const impl = {
  DOMParser: xmldom.DOMParser, XMLSerializer: xmldom.XMLSerializer,
  errorHandler: (report) => ({ warning: () => {}, error: report, fatalError: report }),
};
const parse = (t) => { const p = X.parseXml(t, impl); assert.ok(!p.error, p.error && p.error.message); return p; };
const out = (p) => X.serializeXml(p, impl);
const DESCRIPT = contentModelFor('4.2', 'descript');
const PROCED = contentModelFor('4.2', 'proced');

const corpus = () => {
  const files = [];
  const add = (dir, filter = (f) => f.endsWith('.xml')) => { for (const f of fs.readdirSync(dir).filter(filter)) files.push([`${path.basename(dir)}/${f}`, fs.readFileSync(path.join(dir, f), 'utf8')]); };
  add(path.join(ROOT, 'samples', 'golden', 'csdb'));
  add(path.join(ROOT, 'vendor', 'templates', 'shells'), (f) => /4[12]\.xml$/.test(f));
  files.push(['golden/publication.xml', fs.readFileSync(path.join(ROOT, 'samples', 'golden', 'publication.xml'), 'utf8')]);
  return files;
};

// Everything the editor does not model, in one module, with Windows line ends and a byte-order mark.
const EDGE = '﻿<?xml version=\'1.0\' encoding="UTF-8"?>\r\n'
  + '<!DOCTYPE dmodule [\r\n<!ENTITY ICN-AGS-1 SYSTEM "ICN-AGS-1.png" NDATA png>\r\n<!NOTATION png SYSTEM "png">\r\n]>\r\n'
  + '<!-- a comment before the root -->\r\n<?xml-stylesheet type="text/xsl" href="x.xsl"?>\r\n'
  + '<dmodule  xmlns:xlink = \'http://www.w3.org/1999/xlink\'\r\n\txmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" >\r\n'
  + '  <content>\r\n    <description>\r\n'
  + '      <para id=\'p1\'   applicRefId="a1">Range 10&#x2013;20 &deg;C &amp; &lt;more&gt; <emphasis   emphasisType="em02">italic</emphasis><![CDATA[ <raw> & ]]><?pi keep="me"?><!-- inline comment --> tail</para>\r\n'
  + '      <para></para>\r\n      <para/>\r\n'
  + '      <customThing kind="x"><nested a="1">kept as is</nested></customThing>\r\n'
  + '      <para>Before <randomList><listItem><para>one</para></listItem></randomList> after</para>\r\n'
  + '      <para xlink:href="urn:x">second</para>\r\n'
  + '    </description>\r\n  </content>\r\n</dmodule>\r\n<!-- after the root -->\r\n';

// ---- lossless -----------------------------------------------------------------------------------

test('opening and saving without an edit is byte-identical: every golden module, shell and the publication module', () => {
  const files = corpus();
  assert.ok(files.length >= 15, `corpus of ${files.length}`);
  for (const [name, text] of files) {
    const p = parse(text);
    assert.ok(p.map, `${name}: the source map aligns`);
    assert.equal(out(p), text, name);
  }
});

test('and for a module with a BOM, CRLF, a DOCTYPE subset, PIs, CDATA, comments, character references, quotes and unknown elements', () => {
  const p = parse(EDGE);
  assert.ok(p.map);
  assert.equal(out(p), EDGE);
});

// The source span of the element at `path` in the original text (prolog included).
function spanOf(text, pth) {
  const p = parse(text);
  const el = X.elementAt(p.doc, pth);
  const rec = p.map.recs.get(el);
  return { start: p.prolog.length + rec.start, end: p.prolog.length + rec.end };
}
function assertOnlyInside(src, result, span, what) {
  assert.equal(result.slice(0, span.start), src.slice(0, span.start), `${what}: everything before the element is unchanged`);
  assert.equal(result.slice(result.length - (src.length - span.end)), src.slice(span.end), `${what}: everything after the element is unchanged`);
}

test('an edit rewrites only the element it touched: text, attributes, inserts, deletes, moves (random edits of every golden module)', () => {
  let rng = 20261029;
  const rand = (n) => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
  let checked = 0;
  for (const [name, text] of corpus().filter(([n]) => n.startsWith('csdb/'))) {
    const model = /<procedure/.test(text) ? PROCED : DESCRIPT;
    const all = [];
    (function walk(el, pth) { all.push(pth); X.elementChildren(el).forEach((c, i) => walk(c, [...pth, i])); })(parse(text).doc.documentElement, []);
    for (let round = 0; round < 90; round++) {
      const p = parse(text);
      const pth = all[1 + rand(all.length - 1)];
      const el = X.elementAt(p.doc, pth);
      let touched = pth;
      const kind = rand(4);
      if (kind === 0) {
        const i = Array.from(el.childNodes).findIndex((n) => n.nodeType === 3 && n.data.trim());
        if (i === -1) continue;
        X.setText(p, pth, i, `Edited ${round} <&> text`);
      } else if (kind === 1) {
        X.setAttribute(p, pth, 'id', `x-${round}`);
      } else if (kind === 2) {
        const names = X.childNames(el);
        const allowed = model.insertableAt(el.nodeName, names, names.length).filter((n) => !model.holdsText(el.nodeName));
        if (!allowed.length) continue;
        X.insertElement(p, pth, names.length, allowed[rand(allowed.length)], model);
      } else {
        const parentPath = pth.slice(0, -1);
        const parent = X.elementAt(p.doc, parentPath);
        const i = pth[pth.length - 1];
        if (rand(2) && X.namesAfterMove(parent, i, -1) && model.canExtend(parent.nodeName, X.namesAfterMove(parent, i, -1))) X.moveElement(p, pth, -1);
        else if (model.canExtend(parent.nodeName, X.namesAfterRemove(parent, i))) X.removeElement(p, pth);
        else continue;
        touched = parentPath;
      }
      const result = out(p);
      assert.ok(!X.parseXml(result, impl).error, `${name} round ${round}: well formed`);
      assertOnlyInside(text, result, spanOf(text, touched), `${name} round ${round} (${['text', 'attribute', 'insert', 'remove/move'][kind]})`);
      checked++;
    }
  }
  assert.ok(checked > 200, `${checked} edits checked`);
});

test('an edited text node is escaped and only it changes; the edit re-reads as the same text', () => {
  const src = '<dmodule><content><description><para>One &#176; two</para><para>Untouched &#x2013; &ndash; here</para></description></content></dmodule>';
  const p = parse(src);
  X.setText(p, [0, 0, 0], 0, 'A <b> & "c"');
  const r = out(p);
  assert.equal(r, '<dmodule><content><description><para>A &lt;b&gt; &amp; "c"</para><para>Untouched &#x2013; &ndash; here</para></description></content></dmodule>');
  assert.equal(X.elementAt(parse(r).doc, [0, 0, 0]).textContent, 'A <b> & "c"');
});

test('unsupported content survives edits elsewhere: DOCTYPE, entities, character references, comments, PIs, CDATA, unknown elements', () => {
  const p = parse(EDGE);
  const m = DESCRIPT;
  X.setText(p, [0, 0, 5], 0, 'changed');
  O.insertBlock(p, [0, 0], 1, O.tableSpec({ id: 'tab-0001', rows: 2, cols: 2, header: true }));
  O.insertBlock(p, [0, 0], 1, O.figureSpec({ id: 'fig-0001', title: 'New', icn: 'ICN-AGS-1' }));
  X.setAttribute(p, [0, 0, 0], 'id', 'p1-new');
  const r = out(p);
  for (const kept of [
    '﻿<?xml version=\'1.0\' encoding="UTF-8"?>\r\n', '<!ENTITY ICN-AGS-1 SYSTEM "ICN-AGS-1.png" NDATA png>', '<!-- a comment before the root -->',
    '<?xml-stylesheet type="text/xsl" href="x.xsl"?>', 'xmlns:xlink = \'http://www.w3.org/1999/xlink\'\r\n\txmlns:xsi', 'Range 10&#x2013;20 &deg;C &amp; &lt;more&gt; ',
    '<emphasis   emphasisType="em02">italic</emphasis>', '<![CDATA[ <raw> & ]]>', '<?pi keep="me"?>', '<!-- inline comment -->',
    '<para></para>', '<para/>', '<customThing kind="x"><nested a="1">kept as is</nested></customThing>',
    '<para>Before <randomList><listItem><para>one</para></listItem></randomList> after</para>', '<!-- after the root -->\r\n',
  ]) assert.ok(r.includes(kept), `kept: ${kept}`);
  assert.match(r, /<para id='p1-new'   applicRefId="a1">/, 'a changed attribute keeps its quotes and the tag its layout');
  const again = parse(r);
  assert.deepEqual(X.contentProblems(again.doc, m).filter((x) => x.name === 'table' || x.name === 'figure'), []);
});

test('a self-closing element that gains content opens; an attribute is added at the end of the tag', () => {
  const p = parse('<dmodule><content><description><para/></description></content></dmodule>');
  X.setText(p, [0, 0, 0], 0, 'now');
  X.setAttribute(p, [0, 0], 'id', 'd1');
  assert.equal(out(p), '<dmodule><content><description id="d1"><para>now</para></description></content></dmodule>');
});

// ---- editing operations -------------------------------------------------------------------------

test('formatting wraps the selected characters, only where they are; clearing it unwraps', () => {
  const p = parse('<dmodule><content><description><para>Turn the switch off.</para></description></content></dmodule>');
  const at = O.wrapText(p, [0, 0, 0], 0, 5, 15, O.FORMATS.bold);
  assert.deepEqual(at, [0, 0, 0, 0]);
  assert.equal(out(p), '<dmodule><content><description><para>Turn <emphasis>the switch</emphasis> off.</para></description></content></dmodule>');
  const q = parse(out(p));
  O.wrapText(q, [0, 0, 0], 2, 1, 4, O.FORMATS.italic);
  assert.match(out(q), /<emphasis emphasisType="em02">off<\/emphasis>\.<\/para>/);
  const r = parse(out(q));
  O.unwrap(r, [0, 0, 0, 0]);
  assert.match(out(r), /<para>Turn the switch <emphasis emphasisType="em02">off<\/emphasis>\.<\/para>/);
  assert.equal(O.wrapText(parse(out(r)), [0, 0, 0], 0, 3, 3, O.FORMATS.bold), null, 'an empty selection formats nothing');
});

test('reference targets are numbered as the page shows them; ids are given on demand and are unique', () => {
  const src = '<dmodule><content><description>'
    + '<levelledPara><title>Intro</title><para>x</para><figure><title>A</title><graphic infoEntityIdent="ICN-1"/></figure>'
    + '<levelledPara id="par-0001"><title>Sub</title><para>y</para></levelledPara></levelledPara>'
    + '<levelledPara><title>Two</title><table><title>T</title><tgroup cols="1"><tbody><row><entry><para>c</para></entry></row></tbody></tgroup></table>'
    + '<figure id="fig-0001"><title>B</title><graphic infoEntityIdent="ICN-2"/></figure></levelledPara>'
    + '</description></content></dmodule>';
  const p = parse(src);
  const t = O.referenceTargets(p.doc);
  assert.deepEqual(t.map((x) => x.label), ['Para 1', 'Fig 1', 'Para 1.1', 'Para 2', 'Table 1', 'Fig 2']);
  const fig1 = t.find((x) => x.label === 'Fig 1');
  assert.equal(fig1.id, null);
  const id = O.ensureId(p, fig1.path);
  assert.equal(id, 'fig-0002', 'fig-0001 is taken');
  assert.equal(O.ensureId(p, fig1.path), 'fig-0002', 'stable once given');
  assert.equal(O.labelFor(O.referenceTargets(p.doc), 'fig-0002'), 'Fig 1');
  const spec = O.internalRefSpec({ ...fig1, id });
  assert.deepEqual(spec, { name: 'internalRef', attrs: { internalRefId: 'fig-0002', internalRefTargetType: 'irtt01' } });
  const at = O.insertInlineSpec(p, [0, 0, 0, 1], 0, 1, spec);
  assert.match(out(p), /<para>x<internalRef internalRefId="fig-0002" internalRefTargetType="irtt01"\/><\/para>/);
  assert.equal(X.elementAt(p.doc, at).nodeName, 'internalRef');
  const steps = O.referenceTargets(parse('<dmodule><content><procedure><mainProcedure><proceduralStep><para>a</para><proceduralStep><para>b</para></proceduralStep></proceduralStep><proceduralStep><para>c</para></proceduralStep></mainProcedure></procedure></content></dmodule>').doc);
  assert.deepEqual(steps.map((x) => x.label), ['Step 1', 'Step 1.1', 'Step 2']);
});

test('a data module reference is built from a project code; a malformed code builds nothing', () => {
  const spec = O.dmRefSpec('AGS-A-24-10-00-00A-520A-D');
  const p = parse('<dmodule><content><description><para>See </para></description></content></dmodule>');
  O.insertInlineSpec(p, [0, 0, 0], 0, 4, spec);
  assert.match(out(p), /<para>See <dmRef><dmRefIdent><dmCode modelIdentCode="AGS" systemDiffCode="A" systemCode="24" subSystemCode="1" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="520" infoCodeVariant="A" itemLocationCode="D"\/><\/dmRefIdent><\/dmRef><\/para>/);
  assert.deepEqual(X.contentProblems(parse(out(p)).doc, DESCRIPT).filter((x) => /dmRef|dmCode/.test(x.name)), []);
  for (const bad of ['', 'AGS', 'AGS-A-24-10-00-00A-520A-D"><x', '../../etc']) assert.equal(O.dmRefSpec(bad), null, bad);
  const ext = O.externalPubRefSpec({ code: 'ABC <1>', title: 'Manual & "guide"' });
  const q = parse('<dmodule><content><description><para>x</para></description></content></dmodule>');
  O.insertInlineSpec(q, [0, 0, 0], 0, 1, ext);
  assert.match(out(q), /<externalPubRef><externalPubRefIdent><externalPubCode>ABC &lt;1&gt;<\/externalPubCode><externalPubTitle>Manual &amp; "guide"<\/externalPubTitle><\/externalPubRefIdent><\/externalPubRef>/);
});

test('figures and tables are built schema-valid where the model allows them', () => {
  const p = parse('<dmodule><content><description><para>x</para></description></content></dmodule>');
  O.insertBlock(p, [0, 0], 1, O.figureSpec({ id: 'fig-0001', title: 'Pump', icn: 'ICN-AGS-1' }));
  O.insertBlock(p, [0, 0], 2, O.tableSpec({ id: 'tab-0001', title: 'Torques', rows: 3, cols: 4, header: true }));
  const q = parse(out(p));
  const problems = X.contentProblems(q.doc, DESCRIPT).filter((x) => x.path.length >= 3);
  assert.deepEqual(problems, [], JSON.stringify(problems));
  const tg = q.doc.getElementsByTagName('tgroup')[0];
  assert.equal(tg.getAttribute('cols'), '4');
  assert.equal(tg.getElementsByTagName('colspec').length, 4);
  assert.equal(tg.getElementsByTagName('row').length, 4, 'a header row and three body rows');
  assert.equal(q.doc.getElementsByTagName('entry').length, 16);
});

test('table rows and columns are added and deleted consistently; tables with merged cells keep their columns', () => {
  const p = parse(out((() => { const x = parse('<dmodule><content><description><para>x</para></description></content></dmodule>'); O.insertBlock(x, [0, 0], 1, O.tableSpec({ id: 't', rows: 2, cols: 2, header: false })); return x; })()));
  const cellPath = (doc, r, c) => X.pathOf(doc.getElementsByTagName('row')[r].getElementsByTagName('entry')[c]);
  O.addRow(p, cellPath(p.doc, 0, 0), 1);
  O.addColumn(p, cellPath(p.doc, 0, 1), 1);
  let q = parse(out(p));
  assert.equal(q.doc.getElementsByTagName('row').length, 3);
  for (const row of Array.from(q.doc.getElementsByTagName('row'))) assert.equal(row.getElementsByTagName('entry').length, 3);
  assert.equal(q.doc.getElementsByTagName('tgroup')[0].getAttribute('cols'), '3');
  assert.deepEqual(Array.from(q.doc.getElementsByTagName('colspec')).map((c) => c.getAttribute('colname')), ['col1', 'col2', 'col3']);
  O.deleteColumn(q, cellPath(q.doc, 1, 0));
  O.deleteRow(q, cellPath(q.doc, 2, 0));
  const r = parse(out(q));
  assert.equal(r.doc.getElementsByTagName('row').length, 2);
  for (const row of Array.from(r.doc.getElementsByTagName('row'))) assert.equal(row.getElementsByTagName('entry').length, 2);
  assert.equal(r.doc.getElementsByTagName('tgroup')[0].getAttribute('cols'), '2');
  assert.deepEqual(X.contentProblems(r.doc, DESCRIPT).filter((x) => x.path.length >= 3), []);
  // The last row of a body is kept.
  const one = parse('<dmodule><content><description><table><tgroup cols="1"><tbody><row><entry><para>a</para></entry></row></tbody></tgroup></table></description></content></dmodule>');
  assert.equal(O.deleteRow(one, [0, 0, 0, 0, 0, 0]), null);
  // Merged cells: column edits are refused.
  const merged = parse('<dmodule><content><description><table><tgroup cols="2"><colspec colname="c1"/><colspec colname="c2"/><tbody><row><entry namest="c1" nameend="c2"><para>wide</para></entry></row></tbody></tgroup></table></description></content></dmodule>');
  assert.equal(O.tableContext(merged.doc, [0, 0, 0, 0, 2, 0, 0]).spans, true);
  assert.equal(O.addColumn(merged, [0, 0, 0, 0, 2, 0, 0], 1), null);
  assert.equal(O.deleteColumn(merged, [0, 0, 0, 0, 2, 0, 0]), null);
});

test('lists: items are added, indented into a nested list of the same kind, and outdented back, staying valid', () => {
  const p = parse('<dmodule><content><description><para>Do: <sequentialList><listItem><para>one</para></listItem><listItem><para>two</para></listItem></sequentialList></para></description></content></dmodule>');
  const item2 = [0, 0, 0, 0, 1];
  const added = O.addListItem(p, item2, 1);
  assert.deepEqual(added, [0, 0, 0, 0, 2]);
  const ind = O.indentItem(p, item2);
  assert.deepEqual(ind, [0, 0, 0, 0, 0, 0, 0, 0]);
  let r = out(p);
  assert.match(r, /<listItem><para>one<sequentialList><listItem><para>two<\/para><\/listItem><\/sequentialList><\/para><\/listItem>/);
  assert.deepEqual(X.contentProblems(parse(r).doc, DESCRIPT), [].concat(X.contentProblems(parse(r).doc, DESCRIPT).filter((x) => x.path.length < 3)));
  const q = parse(r);
  assert.equal(O.indentItem(q, [0, 0, 0, 0, 0]), null, 'the first item cannot be indented');
  const back = O.outdentItem(q, ind);
  assert.deepEqual(back, [0, 0, 0, 0, 1]);
  r = out(q);
  assert.match(r, /<listItem><para>one<\/para><\/listItem><listItem><para>two<\/para><\/listItem><listItem><para\/><\/listItem>/, 'the emptied nested list is removed');
  assert.equal(O.outdentItem(parse(r), [0, 0, 0, 0, 0]), null, 'a top-level item cannot be outdented');
  const list = parse('<dmodule><content><description><para>x</para></description></content></dmodule>');
  O.insertInlineSpec(list, [0, 0, 0], 0, 1, O.listSpec('randomList'));
  assert.deepEqual(X.contentProblems(parse(out(list)).doc, DESCRIPT).filter((x) => x.path.length >= 3), []);
});

test('a validation finding\'s line leads to its element, prolog lines counted', () => {
  const text = '<?xml version="1.0"?>\n<!DOCTYPE dmodule>\n<dmodule>\n  <content>\n    <description>\n      <para>a</para>\n      <para>\n        b\n      </para>\n    </description>\n  </content>\n</dmodule>\n';
  const p = parse(text);
  assert.deepEqual(X.pathAtLine(p, 6), [0, 0, 0]);
  assert.deepEqual(X.pathAtLine(p, 8), [0, 0, 1]);
  assert.deepEqual(X.pathAtLine(p, 5), [0, 0]);
  assert.equal(X.pathAtLine(p, 1), null, 'the prolog is no element');
});

test('built text and attributes are always escaped: markup typed by an author stays text', () => {
  const p = parse('<dmodule><content><description><para>x</para></description></content></dmodule>');
  O.insertBlock(p, [0, 0], 1, O.figureSpec({ id: 'f"><script>', title: '<script>alert(1)</script>', icn: 'ICN"/><x y="' }));
  const r = out(p);
  assert.ok(!/<script>/.test(r));
  assert.match(r, /id="f&quot;&gt;&lt;script&gt;"|id="f&quot;>&lt;script>"/);
  assert.match(r, /<title>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
  const again = parse(r);
  assert.equal(again.doc.getElementsByTagName('figure')[0].getAttribute('id'), 'f"><script>');
  assert.equal(again.doc.getElementsByTagName('script').length, 0);
});

test('a figure\'s ICN is declared as an entity in the DOCTYPE, whatever the prolog looks like; only the prolog changes', () => {
  const cases = [
    ['<?xml version="1.0" encoding="UTF-8"?>\n<dmodule><a/></dmodule>', '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE dmodule [\n<!NOTATION png SYSTEM "png">\n<!ENTITY ICN-B-2 SYSTEM "ICN-B-2.png" NDATA png>\n]>\n<dmodule><a/></dmodule>'],
    ['<?xml version="1.0"?><!DOCTYPE dmodule>\n<dmodule/>', '<?xml version="1.0"?><!DOCTYPE dmodule [\n<!NOTATION png SYSTEM "png">\n<!ENTITY ICN-B-2 SYSTEM "ICN-B-2.png" NDATA png>\n]>\n<dmodule/>'],
    ['<?xml version="1.0"?>\r\n<!DOCTYPE dmodule [\r\n<!NOTATION png SYSTEM "png">\r\n<!ENTITY ICN-A-1 SYSTEM "ICN-A-1.png" NDATA png>\r\n]>\r\n<dmodule/>',
      '<?xml version="1.0"?>\r\n<!DOCTYPE dmodule [\r\n<!NOTATION png SYSTEM "png">\r\n<!ENTITY ICN-A-1 SYSTEM "ICN-A-1.png" NDATA png>\r\n<!ENTITY ICN-B-2 SYSTEM "ICN-B-2.png" NDATA png>\r\n]>\r\n<dmodule/>'],
  ];
  for (const [src, want] of cases) {
    const p = parse(src);
    assert.equal(O.declareEntity(p, 'ICN-B-2', 'png'), true);
    assert.equal(O.declareEntity(p, 'ICN-B-2', 'png'), false, 'declared once');
    assert.equal(out(p), want);
  }
  const j = parse('<dmodule/>');
  O.declareEntity(j, 'ICN-C-3', 'jpeg');
  assert.match(out(j), /<!NOTATION jpg SYSTEM "jpg">\n<!ENTITY ICN-C-3 SYSTEM "ICN-C-3\.jpg" NDATA jpg>/);
  for (const bad of ['ICN-X" SYSTEM "file:///etc/passwd', '../ICN', 'NOT-AN-ICN']) assert.equal(O.declareEntity(parse('<dmodule/>'), bad, 'png'), false, bad);
  assert.equal(O.declareEntity(parse('<dmodule/>'), 'ICN-OK-1', 'svg'), false, 'only the formats the build renders');
});

// ---- follow-up checkpoint: merged cells --------------------------------------------------------

const TABLE = (rows, { colspecs = true, cols = 3 } = {}) => `<dmodule><content><description><para>before</para><table id="t"><tgroup cols="${cols}">${colspecs ? Array.from({ length: cols }, (_, i) => `<colspec colname="c${i + 1}"/>`).join('') : ''}<tbody>${rows}</tbody></tgroup></table><para>after</para></description></content></dmodule>`;
const R = (...cells) => `<row>${cells.map((c) => (typeof c === 'string' ? `<entry><para>${c}</para></entry>` : `<entry${Object.entries(c.a).map(([k, v]) => ` ${k}="${v}"`).join('')}><para>${c.t}</para></entry>`)).join('')}</row>`;
const entryPath = (doc, text) => X.pathOf(Array.from(doc.getElementsByTagName('entry')).find((e) => e.textContent === text));
const gridText = (doc) => {
  const g = O.tableGrid(doc.getElementsByTagName('tgroup')[0]);
  return g.cells.map((c) => `${c.entry.textContent}@r${c.r}c${c.start}-${c.end}x${c.rows}`).join(' ');
};
const tableValid = (doc) => X.contentProblems(doc, DESCRIPT).filter((x) => x.path.length >= 3);

test('the CALS grid places positional, named and spanning cells, including cells pushed right by spans from above', () => {
  const p = parse(TABLE(R({ a: { morerows: 1 }, t: 'A' }, 'B', 'C') + R('D', 'E') + R({ a: { namest: 'c1', nameend: 'c2' }, t: 'F' }, 'G')));
  assert.equal(gridText(p.doc), 'A@r0c0-0x2 B@r0c1-1x1 C@r0c2-2x1 D@r1c1-1x1 E@r1c2-2x1 F@r2c0-1x1 G@r2c2-2x1');
  assert.equal(O.tableGrid(parse(TABLE(R({ a: { spanname: 's1' }, t: 'A' }, 'B', 'C'))).doc.getElementsByTagName('tgroup')[0]), null, 'named spans are not modelled');
  assert.equal(O.tableGrid(parse(TABLE(R({ a: { namest: 'nope' }, t: 'A' }, 'B'))).doc.getElementsByTagName('tgroup')[0]), null, 'an unknown column name');
  assert.equal(O.tableGrid(parse(TABLE(R({ a: { morerows: 3 }, t: 'A' }, 'B', 'C'))).doc.getElementsByTagName('tgroup')[0]), null, 'a span past the last row');
});

test('merge right: the cells become one spanning both columns, content kept in order, still valid; only the table changes', () => {
  const src = TABLE(R('A', 'B', 'C') + R('D', 'E', 'F'));
  const p = parse(src);
  assert.deepEqual(O.cellActions(p.doc, entryPath(p.doc, 'A')), { mergeRight: true, mergeDown: true, split: false, modelled: true });
  O.mergeRight(p, entryPath(p.doc, 'A'));
  const r = out(p);
  assert.match(r, /<row><entry namest="c1" nameend="c2"><para>A<\/para><para>B<\/para><\/entry><entry><para>C<\/para><\/entry><\/row>/);
  assert.ok(r.startsWith('<dmodule><content><description><para>before</para><table id="t">') && r.endsWith('</table><para>after</para></description></content></dmodule>'));
  const q = parse(r);
  assert.equal(gridText(q.doc), 'AB@r0c0-1x1 C@r0c2-2x1 D@r1c0-0x1 E@r1c1-1x1 F@r1c2-2x1');
  assert.deepEqual(tableValid(q.doc), []);
  // The merged cell (two columns) cannot take the single cell below it, nor a neighbour with other rows.
  assert.equal(O.cellActions(q.doc, entryPath(q.doc, 'AB')).mergeDown, false);
  assert.equal(O.mergeDown(q, entryPath(q.doc, 'AB')), null);
});

test('merge down: the cell spans the row below; a row is never left without a cell', () => {
  const p = parse(TABLE(R('A', 'B', 'C') + R('D', 'E', 'F') + R('G', 'H', 'I')));
  O.mergeDown(p, entryPath(p.doc, 'B'));
  let q = parse(out(p));
  assert.match(out(q), /<entry morerows="1"><para>B<\/para><para>E<\/para><\/entry>/);
  assert.equal(gridText(q.doc), 'A@r0c0-0x1 BE@r0c1-1x2 C@r0c2-2x1 D@r1c0-0x1 F@r1c2-2x1 G@r2c0-0x1 H@r2c1-1x1 I@r2c2-2x1');
  O.mergeDown(q, entryPath(q.doc, 'BE'));
  q = parse(out(q));
  assert.equal(gridText(q.doc), 'A@r0c0-0x1 BEH@r0c1-1x3 C@r0c2-2x1 D@r1c0-0x1 F@r1c2-2x1 G@r2c0-0x1 I@r2c2-2x1');
  assert.deepEqual(tableValid(q.doc), []);
  // One column: merging down would empty the row below, which the schema forbids.
  const one = parse(TABLE(R('A') + R('B'), { cols: 1 }));
  assert.equal(O.cellActions(one.doc, entryPath(one.doc, 'A')).mergeDown, false);
  assert.equal(O.mergeDown(one, entryPath(one.doc, 'A')), null);
});

test('split: a cell spanning columns and rows becomes single cells in the right places, valid, and a merge then split restores the grid', () => {
  const p = parse(TABLE(R('A', 'B', 'C') + R('D', 'E', 'F') + R('G', 'H', 'I')));
  O.mergeRight(p, entryPath(p.doc, 'A'));
  O.mergeRight(p, entryPath(p.doc, 'D'));
  let q = parse(out(p));
  // The cell below must cover the same columns: AB (two columns) takes DE (two columns).
  O.mergeDown(q, entryPath(q.doc, 'AB'));
  q = parse(out(q));
  assert.equal(gridText(q.doc), 'ABDE@r0c0-1x2 C@r0c2-2x1 F@r1c2-2x1 G@r2c0-0x1 H@r2c1-1x1 I@r2c2-2x1');
  O.splitCell(q, entryPath(q.doc, 'ABDE'));
  const s = parse(out(q));
  assert.equal(gridText(s.doc), 'ABDE@r0c0-0x1 @r0c1-1x1 C@r0c2-2x1 @r1c0-0x1 @r1c1-1x1 F@r1c2-2x1 G@r2c0-0x1 H@r2c1-1x1 I@r2c2-2x1');
  assert.deepEqual(tableValid(s.doc), []);
  assert.equal(O.splitCell(s, entryPath(s.doc, 'C')), null, 'a single cell has nothing to split');
});

test('a table without column names gets them only when a span needs them', () => {
  const p = parse(TABLE(R('A', 'B') + R('C', 'D'), { colspecs: false, cols: 2 }));
  O.mergeRight(p, entryPath(p.doc, 'A'));
  const r = out(p);
  assert.match(r, /<tgroup cols="2"><colspec colnum="1" colname="col1"\/><colspec colnum="2" colname="col2"\/><tbody>/);
  assert.match(r, /<entry namest="col1" nameend="col2"><para>A<\/para><para>B<\/para><\/entry>/);
  assert.deepEqual(tableValid(parse(r).doc), []);
});

// ---- follow-up checkpoint: identification and status ------------------------------------------

const GOLD040 = fs.readFileSync(path.join(ROOT, 'samples', 'golden', 'csdb', 'DMC-AGS-A-24-00-00-00A-040A-D.xml'), 'utf8');

test('identification: the editable fields are read from the section', () => {
  const id = O.identOf(parse(GOLD040).doc);
  assert.equal(id.values.techName, 'PDU-200 power distribution unit');
  assert.match(id.values.issueNumber, /^\d{3}$/);
  assert.match(id.values.issueDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(id.values.languageIsoCode, 'en');
  assert.ok(id.editable.techName && id.present.security);
});

test('identification: changed values touch only their own attribute or text; everything else is byte-identical and valid', () => {
  const p = parse(GOLD040);
  const id = O.identOf(p.doc);
  const values = { ...id.values, techName: 'PDU-200 unit & cabinet', issueNumber: '002', inWork: '01', issueDate: '2026-10-29', securityClassification: '02' };
  assert.deepEqual(O.checkIdent(values, DESCRIPT, id), {});
  const changed = O.setIdent(p, values, DESCRIPT);
  assert.deepEqual(changed.sort(), ['inWork', 'issueDate', 'issueNumber', 'securityClassification', 'techName']);
  const r = out(p);
  const expect = GOLD040
    .replace('<techName>PDU-200 power distribution unit</techName>', '<techName>PDU-200 unit &amp; cabinet</techName>')
    .replace(/<issueInfo issueNumber="\d{3}" inWork="\d{2}"\/>/, '<issueInfo issueNumber="002" inWork="01"/>')
    .replace(/<issueDate year="\d{4}" month="\d{2}" day="\d{2}"\/>/, '<issueDate year="2026" month="10" day="29"/>')
    .replace(/<security securityClassification="\d{2}"\/>/, '<security securityClassification="02"/>');
  assert.equal(r, expect);
  const q = parse(r);
  assert.deepEqual(X.contentProblems(q.doc, DESCRIPT).filter((x) => x.path.length && x.path[0] === 0), [], 'the identification section stays valid');
  assert.equal(O.identOf(q.doc).values.techName, 'PDU-200 unit & cabinet');
});

test('identification: the information name is added after the technical name, and removed when cleared', () => {
  const src = '<dmodule><identAndStatusSection><dmAddress><dmIdent><dmCode modelIdentCode="A"/><language languageIsoCode="en" countryIsoCode="IN"/><issueInfo issueNumber="001" inWork="00"/></dmIdent><dmAddressItems><issueDate year="2026" month="01" day="02"/><dmTitle><techName>Pump</techName></dmTitle></dmAddressItems></dmAddress><dmStatus><security securityClassification="01"/></dmStatus></identAndStatusSection><content/></dmodule>';
  const p = parse(src);
  O.setIdent(p, { ...O.identOf(p.doc).values, infoName: 'Description' }, DESCRIPT);
  const r = out(p);
  assert.match(r, /<dmTitle><techName>Pump<\/techName><infoName>Description<\/infoName><\/dmTitle>/);
  const q = parse(r);
  O.setIdent(q, { ...O.identOf(q.doc).values, infoName: '' }, DESCRIPT);
  assert.equal(out(q), src, 'cleared: back to exactly what it was');
});

test('identification: invalid values and titles holding markup are refused, nothing changes', () => {
  const p = parse(GOLD040);
  const id = O.identOf(p.doc);
  const bad = O.checkIdent({ ...id.values, techName: ' ', issueNumber: '1', inWork: 'x', issueDate: '2026-02-30', languageIsoCode: 'EN', countryIsoCode: 'in', securityClassification: 'X1' }, DESCRIPT, id);
  assert.deepEqual(Object.keys(bad).sort(), ['countryIsoCode', 'inWork', 'issueDate', 'issueNumber', 'languageIsoCode', 'securityClassification', 'techName']);
  assert.throws(() => O.setIdent(p, { ...id.values, issueNumber: '1' }, DESCRIPT));
  assert.equal(out(p), GOLD040);
  const marked = parse(GOLD040.replace('<techName>PDU-200 power distribution unit</techName>', '<techName>PDU-200 <!-- note --> unit</techName>'));
  const mid = O.identOf(marked.doc);
  assert.equal(mid.editable.techName, false);
  assert.match(O.checkIdent({ ...mid.values, techName: 'flattened' }, DESCRIPT, mid).techName, /contains markup/);
  assert.deepEqual(O.checkIdent(mid.values, DESCRIPT, mid), {}, 'unchanged values are fine');
});
