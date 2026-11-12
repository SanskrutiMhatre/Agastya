'use strict';
// CSDB packages (Phase 6, decisions.md CX1 to CX6), the pure parts: reading
// an untrusted zip (names, links, sizes, a size header that lies), and the
// import plan for every kind of file, with nothing written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const pkg = require('../server/content/csdbPackage');
const { tmpdir } = require('./helpers');

const GOLDEN = path.join(__dirname, '..', 'samples', 'golden');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b90000000049454e44ae426082', 'hex');
const DM = fs.readFileSync(path.join(GOLDEN, 'csdb', 'DMC-AGS-A-24-00-00-00A-030A-D.xml'), 'utf8'); // no artwork of its own
const CODE = 'AGS-A-24-00-00-00A-030A-D';

async function zipOf(entries, opts = {}) {
  const z = new JSZip();
  for (const [name, data, o] of entries) z.file(name, data, { createFolders: false, ...(o || {}) });
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', ...opts });
}
const workspace = () => {
  const dir = tmpdir();
  for (const d of ['csdb', 'Media']) fs.mkdirSync(path.join(dir, d));
  return dir;
};
const plan = async (buf, opts = {}) => pkg.planImport(await pkg.readPackage(buf), { dir: opts.dir || workspace(), liveCodes: new Set(), ...opts });
const byName = (p, name) => p.items.find((i) => i.name === name);

test('entry names that are absolute, climb out, or carry a backslash or NUL are refused', () => {
  for (const bad of ['/etc/passwd', 'C:/x.xml', 'csdb/../../x.xml', '..', 'a\\b.xml', 'a\0.xml', '']) assert.ok(pkg.unsafeName(bad), bad);
  for (const ok of ['DMC-A.xml', 'csdb/DMC-A.xml', 'deep/er/ICN-AB-01.png', 'a..b.xml']) assert.equal(pkg.unsafeName(ok), null, ok);
});

test('reading a package: noise skipped, links and unreadable names refused, our manifest recognised', async () => {
  const z = new JSZip();
  z.file('csdb/DMC-A.xml', DM);
  z.file('__MACOSX/csdb/._DMC-A.xml', 'x');
  z.file('.DS_Store', 'x');
  z.file('link.xml', 'target', { unixPermissions: 0o120777 });
  z.file(pkg.MANIFEST, JSON.stringify({ format: pkg.FORMAT, version: 1, project: 'P', exportedAt: '2026-10-29T00:00:00Z', files: [1, 2] }));
  const buf = await z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
  const r = await pkg.readPackage(buf);
  assert.deepEqual(r.files.map((f) => f.name), ['csdb/DMC-A.xml']);
  assert.deepEqual(r.refused.map((f) => f.name), ['link.xml']);
  assert.match(r.refused[0].reason, /symbolic link/);
  assert.deepEqual(r.manifest, { format: pkg.FORMAT, version: 1, project: 'P', exportedAt: '2026-10-29T00:00:00Z', files: 2 });

  // A traversal name, written straight into the archive (JSZip normalises the names it is given).
  const evil = Buffer.from(buf.toString('latin1').split('csdb/DMC-A.xml').join('../../DMCA.xml'), 'latin1'); // same length
  const e = await pkg.readPackage(evil);
  assert.deepEqual(e.files, []);
  assert.deepEqual(e.refused.map((f) => f.name).sort(), ['../../DMCA.xml', 'link.xml']);
  assert.match(e.refused.find((f) => f.name.startsWith('..')).reason, /outside the package/);
});

test('a file that is not a zip, or an empty upload, is refused with a code', async () => {
  assert.equal((await pkg.readPackage(Buffer.from('not a zip')).catch((e) => e)).code, 'UNREADABLE');
  assert.equal((await pkg.readPackage(Buffer.alloc(0)).catch((e) => e)).code, 'VALIDATION');
});

test('an entry larger than its limit is refused, also when its size header lies (zip bomb)', async () => {
  const big = '<a>' + 'x'.repeat(9 * 1024 * 1024) + '</a>';
  const honest = await pkg.readPackage(await zipOf([['big.xml', big], ['ok.xml', DM]]));
  assert.deepEqual(honest.files.map((f) => f.name), ['ok.xml']);
  assert.match(honest.refused[0].reason, /8 MB/);

  // The same archive with both size fields rewritten to 100 bytes: inflating stops at the limit.
  const buf = await zipOf([['big.xml', big]]);
  const lie = Buffer.from(buf);
  for (const [sig, off] of [[0x04034b50, 22], [0x02014b50, 24]]) {
    for (let i = 0; i < lie.length - 4; i++) if (lie.readUInt32LE(i) === sig) lie.writeUInt32LE(100, i + off);
  }
  const r = await pkg.readPackage(lie);
  assert.equal(r.files.length, 0);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].reason, /8 MB/);
});

test('the plan: modules by their own code, never their entry name; existing and duplicate codes skipped', async () => {
  const other = DM.replace('infoCode="030"', 'infoCode="031"');
  const buf = await zipOf([
    ['deep/folder/anything.xml', DM],
    ['z-again.xml', DM], // read after the first (names in order)
    ['csdb/DMC-AGS-A-24-00-00-00A-031A-D.xml', other],
  ]);
  const p = await plan(buf);
  const a = byName(p, 'deep/folder/anything.xml');
  assert.equal(a.status, 'import');
  assert.equal(a.target, `csdb/DMC-${CODE}.xml`);
  assert.match(a.warnings.join(' '), /does not match the code/);
  assert.equal(byName(p, 'z-again.xml').status, 'duplicate');
  assert.equal(byName(p, 'csdb/DMC-AGS-A-24-00-00-00A-031A-D.xml').warnings.length, 0);
  assert.equal(p.counts.modules, 2);
  assert.ok(!('_write' in pkg.planOut(p).items[0]), 'no content goes to the client');

  // A file already at the target with no live record (copied in by hand): not overwritten either.
  const dir = workspace();
  fs.writeFileSync(path.join(dir, 'csdb', `DMC-${CODE}.xml`), DM);
  const onDisk = await plan(buf, { dir });
  assert.equal(byName(onDisk, 'deep/folder/anything.xml').status, 'exists');
  assert.match(byName(onDisk, 'deep/folder/anything.xml').message, /already in the project/);

  const exists = await plan(buf, { liveCodes: new Set([CODE]) });
  assert.equal(byName(exists, 'deep/folder/anything.xml').status, 'exists');
  assert.equal(byName(exists, 'z-again.xml').status, 'exists');
});

test('the plan refuses what no save would accept, and says why', async () => {
  const xxe = '<?xml version="1.0"?><!DOCTYPE dmodule [<!ENTITY x SYSTEM "file:///etc/passwd">]><dmodule>&x;</dmodule>';
  const pm = fs.readFileSync(path.join(GOLDEN, 'publication.xml'));
  const p = await plan(await zipOf([
    ['broken.xml', '<dmodule><unclosed></dmodule>'],
    ['xxe.xml', xxe],
    ['plain.xml', '<?xml version="1.0"?><notes>hello</notes>'],
    ['latin.xml', '<?xml version="1.0" encoding="ISO-8859-1"?><dmodule/>'],
    ['utf16.xml', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<a/>', 'utf16le')])],
    ['publication.xml', pm],
  ]));
  assert.equal(byName(p, 'broken.xml').status, 'refused');
  assert.match(byName(p, 'broken.xml').message, /not well formed/);
  assert.equal(byName(p, 'xxe.xml').status, 'refused');
  assert.match(byName(p, 'plain.xml').message, /Not an S1000D data module/);
  assert.match(byName(p, 'latin.xml').message, /ISO-8859-1.*UTF-8/);
  assert.match(byName(p, 'utf16.xml').message, /UTF-16/);
  assert.equal(byName(p, 'publication.xml').kind, 'publication');
  assert.equal(byName(p, 'publication.xml').status, 'ignored');
  assert.equal(p.counts.import, 0);
});

test('graphics go where the build looks for them; non-images, SVG and non-ICN names are not imported', async () => {
  const declared = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE dmodule [\n<!NOTATION png SYSTEM "png">\n<!ENTITY ICN-AGS-X-00001-A-01-1 SYSTEM "ICN-AGS-X-00001-A-01-1.png" NDATA png>\n]>\n`
    + DM.replace(/^<\?xml[^>]*\?>\s*(<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>\s*)?/, '').replace('infoCode="030"', 'infoCode="032"').replace(/<description>/, '<description><figure><title>F</title><graphic infoEntityIdent="ICN-AGS-X-00001-A-01-1"/></figure>');
  const p = await plan(await zipOf([
    ['csdb/DMC-AGS-A-24-00-00-00A-032A-D.xml', declared],
    ['pics/icn-ags-x-00001-a-01-1.png', PNG], // spelled as the module spells it, placed in csdb/ by the declaration
    ['ICN-AGS-Y-00002-A-01-1.png', PNG], // not declared: Media/, and nobody refers to it
    ['ICN-AGS-Y-00003-A-01-1.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['emblem.png', PNG],
    ['readme.txt', 'hello'],
  ]));
  const g = byName(p, 'pics/icn-ags-x-00001-a-01-1.png');
  assert.equal(g.status, 'import');
  assert.equal(g.icn, 'ICN-AGS-X-00001-A-01-1');
  assert.equal(g.target, 'csdb/ICN-AGS-X-00001-A-01-1.png');
  assert.deepEqual(g.warnings, []);
  const media = byName(p, 'ICN-AGS-Y-00002-A-01-1.png');
  assert.equal(media.target, 'Media/ICN-AGS-Y-00002-A-01-1.png');
  assert.match(media.warnings.join(' '), /No data module/);
  assert.equal(byName(p, 'ICN-AGS-Y-00003-A-01-1.svg').status, 'refused');
  assert.match(byName(p, 'ICN-AGS-Y-00003-A-01-1.svg').message, /SVG/);
  assert.equal(byName(p, 'emblem.png').status, 'ignored');
  assert.equal(byName(p, 'readme.txt').kind, 'other');
  assert.deepEqual(byName(p, 'csdb/DMC-AGS-A-24-00-00-00A-032A-D.xml').warnings, [], 'its artwork comes with it');
  assert.equal(p.counts.graphics, 2);
});

test('graphics already in the project are never replaced; frozen targets are refused; missing artwork is named', async () => {
  const dir = workspace();
  fs.writeFileSync(path.join(dir, 'Media', 'ICN-AGS-Y-00002-A-01-1.png'), PNG);
  fs.writeFileSync(path.join(dir, 'Media', 'ICN-AGS-Y-00004-A-01-1.png'), Buffer.concat([PNG, Buffer.from('x')]));
  const withRef = DM.replace(/<description>/, '<description><figure><title>F</title><graphic infoEntityIdent="ICN-AGS-Z-00009-A-01-1"/></figure>');
  const p = await plan(await zipOf([
    ['ICN-AGS-Y-00002-A-01-1.png', PNG],
    ['ICN-AGS-Y-00004-A-01-1.png', PNG],
    ['ICN-AGS-Y-00005-A-01-1.png', PNG],
    [`csdb/DMC-${CODE}.xml`, withRef],
  ]), { dir, locked: new Map([['Media/ICN-AGS-Y-00005-A-01-1.png', {}]]) });
  assert.match(byName(p, 'ICN-AGS-Y-00002-A-01-1.png').message, /identical/);
  assert.match(byName(p, 'ICN-AGS-Y-00004-A-01-1.png').message, /different content.*nothing replaced/);
  assert.equal(byName(p, 'ICN-AGS-Y-00005-A-01-1.png').status, 'refused');
  assert.match(byName(p, 'ICN-AGS-Y-00005-A-01-1.png').message, /Frozen/);
  assert.match(byName(p, `csdb/DMC-${CODE}.xml`).warnings.join(' '), /^1 graphic not in the package or the project: ICN-AGS-Z-00009-A-01-1/);
});

test('export: every live module, the publication module and the images, each listed with its SHA-256', async () => {
  const dir = workspace();
  for (const f of fs.readdirSync(path.join(GOLDEN, 'csdb'))) fs.copyFileSync(path.join(GOLDEN, 'csdb', f), path.join(dir, 'csdb', f));
  for (const f of fs.readdirSync(path.join(GOLDEN, 'Media'))) fs.copyFileSync(path.join(GOLDEN, 'Media', f), path.join(dir, 'Media', f));
  fs.copyFileSync(path.join(GOLDEN, 'publication.xml'), path.join(dir, 'publication.xml'));
  fs.writeFileSync(path.join(dir, 'csdb', 'notes.txt'), 'not exported');
  const modules = fs.readdirSync(path.join(dir, 'csdb')).filter((f) => f.endsWith('.xml')).map((f) => ({ rel_path: `csdb/${f}`, dmc: f.slice(4, -4), status: 'draft', issue: '4.2' }));
  modules.push({ rel_path: 'csdb/DMC-GONE.xml', dmc: 'GONE', status: 'draft' });
  const { buffer, manifest } = await pkg.exportPackage({ dir, project: { name: 'Golden' }, modules, by: 'Tester', now: new Date('2026-10-29T10:00:00Z') });
  assert.equal(manifest.counts.modules, 9);
  assert.equal(manifest.counts.graphics, 3);
  assert.deepEqual(manifest.missing, ['csdb/DMC-GONE.xml']);
  const z = await JSZip.loadAsync(buffer);
  const names = Object.keys(z.files).sort();
  assert.ok(names.includes('publication.xml') && names.includes(pkg.MANIFEST) && !names.includes('csdb/notes.txt'));
  for (const f of manifest.files) {
    const got = await z.file(f.path).async('nodebuffer');
    assert.ok(got.equals(fs.readFileSync(path.join(dir, f.path))), f.path);
  }
  // Read back as a package into an empty project: every module and the ICN, the logos and publication module set aside.
  const p = await plan(buffer);
  assert.equal(p.counts.modules, 9);
  assert.equal(p.counts.graphics, 1);
  assert.equal(p.counts.ignored, 3);
  assert.equal(p.manifest.project, 'Golden');
});
