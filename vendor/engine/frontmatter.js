'use strict';
// Generate the config-driven front-matter XML files consumed by jsstofo.
//
// Stage 1 emits xi:include references to jss/frontmatter/*.xml, which stage 2
// resolves. This module writes those files from the effective config, making
// the front-matter text a setting rather than hand-edited XML.
//
// Only the pages whose content lives in the config are generated:
//   01 title page (joint)   02 title page (single)   03 proprietary
//   04 foreword             07 safety warning        09 cautions/notes
//   13 description of symbols
// The purely-boilerplate pages (record of changes, associated handbooks, first
// aid, demolition, change notice) are left as static files.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const AUTOGEN = '<!-- Generated from the effective config by engine/frontmatter.js. Do not edit. -->\n';

// A contact block value that is one line becomes plain text; multiple lines
// become <line> elements, matching the foreword deflist in the stencil.
function defBody(value) {
    const arr = Array.isArray(value) ? value : [value];
    if (arr.length === 1) return esc(arr[0]);
    return '\n' + arr.map(l => `                <line>${esc(l)}</line>`).join('\n') + '\n            ';
}

function titlePageXml(rootTag, tp) {
    return HEAD + AUTOGEN +
`<${rootTag}>
    <documentType>${defBody(tp.documentType)}</documentType>
    <disclosureNotice>${esc(tp.disclosureNotice)}</disclosureNotice>
    <repairNotice>${esc(tp.repairNotice)}</repairNotice>
</${rootTag}>
`;
}

function proprietaryXml(p) {
    return HEAD + AUTOGEN +
`<proprietary>
    <para>${esc(p.text)}</para>
    <applicability>${esc(p.applicability)}</applicability>
</proprietary>
`;
}

function forewordXml(f) {
    return HEAD + AUTOGEN +
`<foreword>
    <para>${esc(f.text)}</para>
    <deflist>
        <defitem>
            <term>E-mail Address</term>
            <def>${defBody(f.email)}</def>
        </defitem>
        <defitem>
            <term>Postal Address</term>
            <def>${defBody(f.postalAddress)}</def>
        </defitem>
        <defitem>
            <term>Telephone No.</term>
            <def>${defBody(f.telephone)}</def>
        </defitem>
        <defitem>
            <term>Fax No.</term>
            <def>${defBody(f.fax)}</def>
        </defitem>
    </deflist>
</foreword>
`;
}

function safetyWarningXml(lines) {
    const body = (lines || []).map(l => {
        const attrs =
            (l.strong ? ' emphasis="strong"' : '') +
            (l.spaceBefore ? ` space-before="${escAttr(l.spaceBefore)}"` : '');
        return `    <line${attrs}>${esc(l.text)}</line>`;
    }).join('\n');
    return HEAD + AUTOGEN + `<safetyWarning>\n${body}\n</safetyWarning>\n`;
}

function cautionsNotesXml(items) {
    const body = (items || []).map(t => `    <item>${esc(t)}</item>`).join('\n');
    return HEAD + AUTOGEN + `<cautionsNotes>\n${body}\n</cautionsNotes>\n`;
}

/*
  The six pages that used to be hand-edited stencils.

  Each writes the same element the stylesheets already render, so nothing in
  either engine changes — only where the content comes from. A page is written
  ONLY when its settings key exists, so a project that has never opened these
  editors keeps the stencil it has, edits and all.
*/

// Two pro-formas whose only variable is how many ruled rows to print.
function recordOfChangesXml(cfg) {
    const rows = Number((cfg && cfg.rows) || 20) || 20;
    return HEAD + AUTOGEN + `<recordOfChanges rows="${rows}"/>\n`;
}

function changeNoticeXml(cfg) {
    const rows = Number((cfg && cfg.rows) || 3) || 3;
    return HEAD + AUTOGEN + `<changeNotice rows="${rows}"/>\n`;
}

/*
  The technical-literature set. `sr` is free text, not a counter: the stencil
  numbers sub-volumes 2.1, 2.1.1 and so on, which no automatic numbering would
  reproduce.
*/
function associatedHandbooksXml(items) {
    const body = (items || []).map((h) => [
        `    <handbook sr="${escAttr(h.sr)}">`,
        `        <title>${esc(h.title)}</title>`,
        `        <inbr>${esc(h.inbr)}</inbr>`,
        `    </handbook>`,
    ].join('\n')).join('\n');
    return HEAD + AUTOGEN + `<associatedHandbooks>\n${body}\n</associatedHandbooks>\n`;
}

/*
  Abbreviations. With no entries the element is emitted EMPTY, which is not the
  same as omitting the page: the stylesheet then draws a blank ruled pro-forma
  for an author to fill in by hand, which is the stencil's own behaviour.

  Terms harvested from <acronym> in the source are merged in by the build, so
  what is listed here is the hand-authored set only.
*/
function abbreviationsXml(items) {
    const rows = (items || []).filter((a) => a && a.term);
    if (!rows.length) return HEAD + AUTOGEN + `<listOfAbbreviations/>\n`;
    const body = rows.map((a) =>
        `    <abbreviation term="${escAttr(a.term)}">${esc(a.meaning)}</abbreviation>`).join('\n');
    return HEAD + AUTOGEN + `<listOfAbbreviations>\n${body}\n</listOfAbbreviations>\n`;
}

/*
  Demolition and first aid are both "parts of prose, some with a list".

  The text is statutory and rarely changes, but it is not identical between
  services, so it has to be editable rather than fixed. A part is a heading
  plus paragraphs plus an optional list; a first-aid step is the same shape
  without the heading.
*/
function partsXml(parts) {
    return (parts || []).map((p) => {
        const out = [`    <part>`];
        if (p.title) out.push(`        <title>${esc(p.title)}</title>`);
        for (const t of (p.paras || []).filter(Boolean)) {
            out.push(`        <para indent="none">${esc(t)}</para>`);
        }
        const items = (p.items || []).filter(Boolean);
        if (items.length) {
            out.push(`        <list type="${escAttr(p.listType || 'roman')}">`);
            for (const t of items) out.push(`            <item>${esc(t)}</item>`);
            out.push(`        </list>`);
        }
        out.push(`    </part>`);
        return out.join('\n');
    }).join('\n');
}

function demolitionXml(cfg) {
    return HEAD + AUTOGEN + `<demolition>\n${partsXml(cfg && cfg.parts)}\n</demolition>\n`;
}

function firstAidXml(cfg, fallbackFigure) {
    const out = [];
    // The artwork is chosen by the existing "First Aid Illustration" picker,
    // which also drives the stylesheet's sizing params; the steps editor does
    // not duplicate it. cfg.figure only wins if something set it explicitly.
    const fig = (cfg && cfg.figure) || fallbackFigure;
    if (fig) out.push(`    <figure src="${escAttr(fig)}"/>`);
    for (const st of ((cfg && cfg.steps) || [])) {
        out.push(`    <step>`);
        for (const t of (st.paras || []).filter(Boolean)) out.push(`        <para>${esc(t)}</para>`);
        out.push(`    </step>`);
    }
    return HEAD + AUTOGEN + `<firstAid>\n${out.join('\n')}\n</firstAid>\n`;
}

/*
  The notice legends carry the vocabulary of the ENGINE that will render them.

  These pages are ours: they are written from Settings, not read from the CSDB,
  so nothing outside this file decides what elements they use. The two engines
  read different ones. The JSS stylesheet takes whatever a notice contains, so
  <para> is right there. The S1000D stylesheet names the element it wants —
  <notePara> inside a note, <warningAndCautionPara> inside a warning or caution
  — because that is what a real data module holds, and it should not have to be
  taught a second shape to render a page we generate ourselves.

  Emitting <para> for the S1000D engine is what left the NOTE, WARNING and
  CAUTION bands on the Description of Symbols page drawn with nothing under
  them: the stylesheet asked for a child that was not there. No error, no gap
  in the layout, and a page that still looked deliberate — which is the worst
  way for a safety legend to fail.
*/
function symbolsXml(symbols, legends, engine) {
    const rows = (symbols || []).map(s =>
        `        <symbol src="${escAttr(s.icon)}">${esc(s.text)}</symbol>`).join('\n');
    const lg = legends || {};
    const s1000d = engine === 's1000dtofo';
    const notice = (tag, inner, text) =>
        `        <${tag}>\n            <${inner}>${esc(text)}</${inner}>\n        </${tag}>`;
    const para = s1000d ? 'warningAndCautionPara' : 'para';
    return HEAD + AUTOGEN +
`<descriptionOfSymbols>
    <symbolList>
${rows}
    </symbolList>
    <noticeList>
${notice('note', s1000d ? 'notePara' : 'para', lg.note)}
${notice('warning', para, lg.warning)}
${notice('caution', para, lg.caution)}
    </noticeList>
</descriptionOfSymbols>
`;
}

// Write all config-driven front-matter files into `dir`. `fm` is the effective
// frontMatter object (house defaults merged with project overrides).
/*
  The system illustration page: one or more full-page pictures of the equipment.

  Both stylesheets already render every <graphic> inside <systemNamePage>, so
  supporting several is a matter of emitting several — they stack down the page
  and flow onto further pages if they do not all fit.

  `systemImages` is the list; `systemImage` is the older single-value form and
  is still honoured so existing projects keep working. With neither set no file
  is written at all, and the page falls back to its ruled placeholder frame.
*/
function systemImageList(fm) {
    const many = Array.isArray(fm.systemImages) ? fm.systemImages : [];
    const list = many.map((v) => (v && v.src ? v.src : v)).filter((v) => typeof v === 'string' && v.trim());
    if (!list.length && fm.systemImage) list.push(fm.systemImage);
    return list;
}

function systemNamePageXml(srcs) {
    const rows = srcs.map((s) => `    <graphic src="${escAttr(s)}"/>`).join('\n');
    return HEAD + AUTOGEN + `<systemNamePage>\n${rows}\n</systemNamePage>\n`;
}


/*
  The page-order file the JSS stage-1 stylesheet reads.

  That stylesheet cannot see project settings, and XSLT 1.0 cannot walk a
  comma-separated parameter comfortably, so the resolved running order is
  written out as a tiny document it can iterate with document(). Only enabled
  pages appear; a page whose file is missing is skipped rather than becoming a
  broken xi:include.
*/
function writeFrontMatterOrder(dir, pages, fmDirAbs, outName) {
    const rows = [];
    for (const p of pages) {
        if (p.file) {
            if (fmDirAbs && !fs.existsSync(path.join(fmDirAbs, p.file))) {
                if (!p.element) continue;          // no file and no element: nothing to emit
                rows.push(`  <page element="${escAttr(p.element)}"/>`);
                continue;
            }
            rows.push(`  <page file="${escAttr(p.file)}"/>`);
        } else if (p.element) {
            rows.push(`  <page element="${escAttr(p.element)}"/>`);
        }
    }
    const file = outName || '_frontmatter-order.xml';
    fs.writeFileSync(path.join(dir, file),
        HEAD + '<!-- Generated per build from settings. Do not edit. -->\n'
        + '<pages>\n' + rows.join('\n') + '\n</pages>\n',
        'utf8');
    return file;
}

/*
  Record of what this module last wrote, so a page the user has since edited by
  hand can be told apart from one still owned by Settings.

  Without it every build silently overwrote all eight generated pages: open
  04-foreword.xml in the editor, change a line, press Generate, and the edit was
  gone with nothing to say so. Keyed by file name, holding a hash of the exact
  bytes we produced.
*/
const STAMP_FILE = '_frontmatter-generated.json';
const contentHash = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 32);

function readStamp(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, STAMP_FILE), 'utf8')); } catch { return {}; }
}
function writeStamp(dir, stamp) {
    try {
        fs.writeFileSync(path.join(dir, STAMP_FILE),
            JSON.stringify(stamp, null, 2) + '\n', 'utf8');
    } catch { /* a project on read-only media still builds */ }
}

/*
  Write the settings-driven front-matter pages.

  A page is only overwritten while it still matches what we last generated. Once
  it has been hand-edited it belongs to the author: it is left alone and
  reported in `kept`, so the build can say the page is no longer following
  Settings rather than quietly discarding the work. Reverting is just deleting
  the file — the next build regenerates it.

  Returns { written, kept }.
*/
function generateFrontMatter(fm, dir, engine) {
    if (!fm) return { written: [], kept: [] };
    const written = [];
    const kept = [];
    const stamp = readStamp(dir);
    const put = (name, xml) => {
        const abs = path.join(dir, name);
        // Only a file we can prove we wrote is ours to replace. With no record
        // (a project from before this existed) the old behaviour stands for one
        // build, and the record written below protects it from then on.
        if (fs.existsSync(abs) && stamp[name]) {
            let current = '';
            try { current = fs.readFileSync(abs, 'utf8'); } catch { /* unreadable: rewrite it */ }
            if (current && contentHash(current) !== stamp[name]) { kept.push(name); return; }
        }
        fs.writeFileSync(abs, xml, 'utf8');
        stamp[name] = contentHash(xml);
        written.push(name);
    };

    if (fm.titlePageJoint) put('01-title-page-joint.xml', titlePageXml('titlePageJoint', fm.titlePageJoint));
    if (fm.titlePage)      put('02-title-page.xml',        titlePageXml('titlePage', fm.titlePage));
    if (fm.proprietary)    put('03-proprietary.xml',       proprietaryXml(fm.proprietary));
    if (fm.foreword)       put('04-foreword.xml',          forewordXml(fm.foreword));
    if (fm.safetyWarning)  put('07-safety-warning.xml',    safetyWarningXml(fm.safetyWarning));
    if (fm.cautionsNotes)  put('09-cautions-notes.xml',    cautionsNotesXml(fm.cautionsNotes));
    if (fm.descriptionOfSymbols) put('13-description-of-symbols.xml', symbolsXml(fm.descriptionOfSymbols, fm.noticeLegends, engine));
    // Pages that were stencil-only until they gained editors. Written only
    // once the settings key exists, so an untouched project keeps the stencil
    // file it already has, hand edits and all.
    if (fm.recordOfChanges)     put('05-record-of-changes.xml',     recordOfChangesXml(fm.recordOfChanges));
    if (fm.associatedHandbooks) put('06-associated-handbooks.xml',  associatedHandbooksXml(fm.associatedHandbooks));
    if (fm.firstAid)            put('08-first-aid.xml',             firstAidXml(fm.firstAid, fm.firstAidImage));
    if (fm.demolition)          put('10-demolition.xml',            demolitionXml(fm.demolition));
    if (fm.changeNotice)        put('11-change-notice.xml',         changeNoticeXml(fm.changeNotice));
    if (fm.listOfAbbreviations) put('12-list-of-abbreviations.xml', abbreviationsXml(fm.listOfAbbreviations));
    const sysImgs = systemImageList(fm);
    if (sysImgs.length) put('14-system-name-page.xml', systemNamePageXml(sysImgs));

    writeStamp(dir, stamp);
    return { written, kept };
}

module.exports = { generateFrontMatter, writeFrontMatterOrder };
