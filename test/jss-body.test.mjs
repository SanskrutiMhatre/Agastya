// The JSS Design view's block tree (decisions.md ST9): parsing a book's
// <body> and serialising it back, in Node via xmldom (jssBody.js's own
// convention, matching xmlDoc.js's).
import test from 'node:test';
import assert from 'node:assert/strict';
import xmldom from '@xmldom/xmldom';
import { parseBody, serializeBody, spliceBody, nextBlockId } from '../client/src/editor/jssBody.js';

const impl = { DOMParser: xmldom.DOMParser, XMLSerializer: xmldom.XMLSerializer };

const BOOK = `<?xml version="1.0" encoding="UTF-8"?>
<jssbook>
  <bookmeta><bookName>B</bookName></bookmeta>
  <body>
    <chapter number="1">
      <title>General</title>
      <para>Intro <b>bold</b> text.</para>
      <section>
        <title>Sub topic</title>
        <para>Nested para.</para>
        <list type="number"><item>One</item><item>Two</item></list>
        <table>
          <title>Specs</title>
          <thead><row><cell><para>A</para></cell><cell><para>B</para></cell></row></thead>
          <tbody><row><cell><para>1</para></cell><cell><para>2</para></cell></row></tbody>
        </table>
        <figure><title>Diagram</title><graphic src="csdb/ICN-X-1.png"/></figure>
        <warning>Danger.</warning>
        <somethingElse foo="1"><bar/></somethingElse>
      </section>
    </chapter>
    <chapter number="2">
      <title>Second</title>
    </chapter>
  </body>
</jssbook>
`;

test('parseBody reads chapters, a nested section and every block type inside it', () => {
  const { chapters, ok } = parseBody(BOOK, impl);
  assert.equal(ok, true);
  assert.equal(chapters.length, 2);
  const chapter1 = chapters[0];
  assert.equal(chapter1.number, '1');
  assert.equal(chapter1.title, 'General');
  assert.equal(chapter1.blocks.length, 2, 'the top-level para, then the nested section');
  assert.equal(chapter1.blocks[0].type, 'para');
  assert.match(chapter1.blocks[0].html, /Intro <b>bold<\/b> text\./);

  const section = chapter1.blocks[1];
  assert.equal(section.type, 'section');
  assert.equal(section.title, 'Sub topic');
  assert.deepEqual(section.blocks.map((b) => b.type), ['para', 'list', 'table', 'figure', 'warning', 'unknown']);

  const list = section.blocks[1];
  assert.equal(list.ordered, true);
  assert.deepEqual(list.items, ['One', 'Two']);

  const table = section.blocks[2];
  assert.equal(table.title, 'Specs');
  assert.deepEqual(table.header, ['A', 'B']);
  assert.deepEqual(table.rows, [['1', '2']]);

  const figure = section.blocks[3];
  assert.equal(figure.title, 'Diagram');
  assert.equal(figure.src, 'csdb/ICN-X-1.png');

  const warning = section.blocks[4];
  assert.equal(warning.type, 'warning');
  assert.match(warning.html, /Danger\./);

  const unknown = section.blocks[5];
  assert.equal(unknown.type, 'unknown');
  assert.match(unknown.xml, /<somethingElse foo="1"><bar\/><\/somethingElse>/);

  // Serialise back and re-parse: the same shape comes out (ids are regenerated, so compared without them).
  const bodyXml = serializeBody(chapters);
  const strip = (cs) => cs.map((c) => ({ number: c.number, title: c.title, blocks: stripBlocks(c.blocks) }));
  function stripBlocks(bs) {
    return bs.map((b) => {
      const { id, ...rest } = b;
      if (rest.type === 'section') rest.blocks = stripBlocks(rest.blocks);
      return rest;
    });
  }
  const full = BOOK.replace(/<body>[\s\S]*<\/body>/, bodyXml);
  const again = parseBody(full, impl).chapters;
  assert.deepEqual(strip(again), strip(chapters));
});

test('spliceBody replaces only <body>, leaving bookmeta and everything else untouched', () => {
  const next = spliceBody(BOOK, '<body><chapter number="9"><title>New</title></chapter></body>');
  assert.match(next, /<bookName>B<\/bookName>/);
  assert.match(next, /<chapter number="9"><title>New<\/title><\/chapter>/);
  assert.doesNotMatch(next, /General/);
});

test('an empty or missing <body> (not a book, or no book yet) is reported, not thrown', () => {
  assert.deepEqual(parseBody('<pm/>', impl), { chapters: [], ok: false });
  assert.deepEqual(parseBody('<jssbook><bookmeta/></jssbook>', impl), { chapters: [], ok: false });
});

test('nextBlockId always returns a fresh id', () => {
  const a = nextBlockId(); const b = nextBlockId();
  assert.notEqual(a, b);
});
