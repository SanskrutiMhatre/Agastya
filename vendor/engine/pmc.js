'use strict';
// Publication Module (PMC) read/write.
//
// Turns publication.xml into a plain tree the UI can rearrange, and back again.
// This is the file that decides what the finished book contains and in what
// order, so the guiding rule here is: NOTHING is silently dropped. Anything
// inside a <pmEntry> this module does not model is kept as raw XML and written
// back out verbatim (see `extra`), and the caller is told about it.
//
// The stored form is always the dmRef ("IETM") one — the same thing
// pmcbuilder.py exports. The xi:include ("PDF") form is derived at build time
// by resolveDmRefs, never authored or stored, so the two publications cannot
// drift apart the way two hand-exported files can.
//
// Deliberately hand-written rather than regex-driven: <pmEntry> nests (three
// deep in real publications), and nesting is precisely what regexes get wrong.

// ---------------------------------------------------------------------------
// Minimal XML reader
// ---------------------------------------------------------------------------
// Enough of XML for a machine-generated S1000D PM: elements, attributes, text,
// comments, PIs and the doctype. No entity expansion beyond the predefined
// five, no namespaces resolution (prefixes are kept as part of the name).

function decodeText(s) {
    return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/g, '&'); // last, so &amp;lt; survives as &lt;
}

function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
    return escapeText(s).replace(/"/g, '&quot;');
}

function parseAttrs(src) {
    const attrs = {};
    const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(src))) attrs[m[1]] = decodeText(m[3] !== undefined ? m[3] : m[4]);
    return attrs;
}

/*
  Parse `xml` into { name, attrs, children, text } nodes. Text-only content is
  collapsed onto `text`; whitespace between elements is discarded, since a PM
  carries no mixed content and keeping it would only complicate re-indenting.
*/
function parseXml(xml) {
    const root = { name: '#doc', attrs: {}, children: [] };
    const stack = [root];
    const tagRe = /<(!--[\s\S]*?--|\?[\s\S]*?\?|![^>]*|\/?[^>]*?)>/g;
    let last = 0, m;

    while ((m = tagRe.exec(xml))) {
        const between = xml.slice(last, m.index);
        if (between.trim()) {
            const top = stack[stack.length - 1];
            top.text = (top.text || '') + decodeText(between);
        }
        last = tagRe.lastIndex;

        const body = m[1];
        if (body.startsWith('!--') || body.startsWith('?') || body.startsWith('!')) continue;

        if (body.startsWith('/')) {
            const name = body.slice(1).trim();
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].name === name) { stack.length = i; break; }
            }
            continue;
        }

        const selfClosing = body.endsWith('/');
        const inner = selfClosing ? body.slice(0, -1) : body;
        const sp = inner.search(/[\s/]/);
        const name = (sp === -1 ? inner : inner.slice(0, sp)).trim();
        if (!name) continue;

        const node = { name, attrs: parseAttrs(sp === -1 ? '' : inner.slice(sp)), children: [] };
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
    }
    return root;
}

const child = (node, name) => (node ? node.children.find((c) => c.name === name) : undefined);
const childText = (node, name) => { const c = child(node, name); return c && c.text !== undefined ? c.text.trim() : undefined; };

// Re-serialise an unmodelled node exactly enough to write it back unchanged.
function nodeToXml(node, indent) {
    const pad = '  '.repeat(indent);
    const attrs = Object.entries(node.attrs)
        .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
    if (!node.children.length && (node.text === undefined || node.text === '')) {
        return `${pad}<${node.name}${attrs}/>`;
    }
    if (!node.children.length) {
        return `${pad}<${node.name}${attrs}>${escapeText(node.text)}</${node.name}>`;
    }
    const inner = node.children.map((c) => nodeToXml(c, indent + 1)).join('\n');
    return `${pad}<${node.name}${attrs}>\n${inner}\n${pad}</${node.name}>`;
}

// ---------------------------------------------------------------------------
// PM  ->  model
// ---------------------------------------------------------------------------

const DM_CODE_KEYS = [
    'modelIdentCode', 'systemDiffCode', 'systemCode', 'subSystemCode',
    'subSubSystemCode', 'assyCode', 'disassyCode', 'disassyCodeVariant',
    'infoCode', 'infoCodeVariant', 'itemLocationCode',
];

// A <dmRef> as a 'dm' entry.
function dmEntryFrom(dmRef, title, extra) {
    const ident = child(dmRef, 'dmRefIdent');
    const addr = child(dmRef, 'dmRefAddressItems');
    const dmTitle = child(addr, 'dmTitle');
    return {
        type: 'dm',
        title: title || undefined,
        dmCode: child(ident, 'dmCode') ? { ...child(ident, 'dmCode').attrs } : {},
        identExtension: child(ident, 'identExtension') ? { ...child(ident, 'identExtension').attrs } : undefined,
        issueInfo: child(ident, 'issueInfo') ? { ...child(ident, 'issueInfo').attrs } : undefined,
        language: child(ident, 'language') ? { ...child(ident, 'language').attrs } : undefined,
        techName: dmTitle ? childText(dmTitle, 'techName') : undefined,
        infoName: dmTitle ? childText(dmTitle, 'infoName') : undefined,
        issueDate: child(addr, 'issueDate') ? { ...child(addr, 'issueDate').attrs } : undefined,
        extra: extra && extra.length ? extra : undefined,
    };
}

/*
  Agastya: the page a chapter or module is set on (decisions.md ST6). The
  stage-1 stylesheet turns a whole entry landscape when its <pmEntry> has
  id="a4-landscape" (or "landscape") or id="a3-landscape"
  (s1000dtojss.xsl); that id is read into `page` and written back, where it
  was dropped before.
*/
const PAGE_IDS = ['a4-landscape', 'a3-landscape', 'landscape'];
function readEntry(node, warnings, pathLabel) {
    const entry = readEntryBody(node, warnings, pathLabel);
    const id = node.attrs && node.attrs.id;
    if (PAGE_IDS.includes(id)) entry.page = id === 'landscape' ? 'a4-landscape' : id;
    return entry;
}

function readEntryBody(node, warnings, pathLabel) {
    const title = childText(node, 'pmEntryTitle');
    const dmRef = child(node, 'dmRef');
    const nested = node.children.filter((c) => c.name === 'pmEntry');

    /*
      Agastya: S1000D lets a <pmEntry> hold several <dmRef>s directly, and
      mix them with nested entries ("General" with two modules in it). Only
      the first <dmRef> was read, so the others vanished from the book on the
      next save. Such an entry is a chapter: its modules and sub-entries are
      its children, in document order, and the writer puts untitled modules
      back as bare <dmRef>s, so the file keeps its shape.
    */
    const directRefs = node.children.filter((c) => c.name === 'dmRef');
    if (directRefs.length > 1 || (directRefs.length === 1 && nested.length)) {
        const others = node.children.filter((c) => c.name !== 'pmEntryTitle' && c.name !== 'dmRef' && c.name !== 'pmEntry');
        for (const e of others) warnings.push(`${pathLabel}: kept unmodelled <${e.name}> as-is`);
        let n = 0;
        return {
            type: 'folder',
            title: title || '',
            children: node.children
                .filter((c) => c.name === 'dmRef' || c.name === 'pmEntry')
                .map((c) => (c.name === 'dmRef' ? dmEntryFrom(c) : readEntry(c, warnings, `${pathLabel}/${++n}`))),
            extra: others.length ? others.map((e) => nodeToXml(e, 0)) : undefined,
        };
    }

    // A PM may reference modules either by dmCode (<dmRef>, the "IETM" form
    // this module writes) or directly by file (<xi:include>, the "PDF" form
    // resolveDmRefs generates). Real projects contain both — an already-built
    // publication is stored in include form — so both are first-class here.
    // Treating an include as unmodelled made a 215-module publication read as
    // 245 empty folders.
    const include = node.children.find((c) => c.name === 'xi:include' || c.name === 'xinclude' || /(^|:)include$/.test(c.name));
    const pmRef = child(node, 'pmRef');

    // Anything else is kept verbatim rather than dropped — externalPubRef is
    // legal here, and losing one would quietly remove a chapter from the book.
    const extra = node.children.filter(
        (c) => c.name !== 'pmEntryTitle' && c.name !== 'dmRef' && c.name !== 'pmEntry'
            && c !== include && c !== pmRef,
    );
    for (const e of extra) warnings.push(`${pathLabel}: kept unmodelled <${e.name}> as-is`);

    // A pmEntry pointing at a WHOLE OTHER publication module — an "Annexure"
    // chapter that is really a separate manual, resolved at build time by
    // pmCode against the other projects in the workspace (resolveDmRefs.js).
    if (pmRef) {
        const ident = child(pmRef, 'pmRefIdent');
        const addr = child(pmRef, 'pmRefAddressItems');
        return {
            type: 'pmRef',
            title: title || undefined,
            pmCode: child(ident, 'pmCode') ? { ...child(ident, 'pmCode').attrs } : {},
            issueInfo: child(ident, 'issueInfo') ? { ...child(ident, 'issueInfo').attrs } : undefined,
            pmTitle: addr ? childText(addr, 'pmTitle') : undefined,
            shortPmTitle: addr ? childText(addr, 'shortPmTitle') : undefined,
            extra: extra.length ? extra.map((e) => nodeToXml(e, 0)) : undefined,
        };
    }

    if (include) {
        return {
            type: 'include',
            title: title || undefined,
            href: include.attrs.href || '',
            hasFallback: include.children.some((c) => /(^|:)fallback$/.test(c.name)) || undefined,
            extra: extra.length ? extra.map((e) => nodeToXml(e, 0)) : undefined,
        };
    }

    if (dmRef) {
        const ident = child(dmRef, 'dmRefIdent');
        const addr = child(dmRef, 'dmRefAddressItems');
        const dmTitle = child(addr, 'dmTitle');
        return {
            type: 'dm',
            title: title || undefined,
            dmCode: child(ident, 'dmCode') ? { ...child(ident, 'dmCode').attrs } : {},
            identExtension: child(ident, 'identExtension') ? { ...child(ident, 'identExtension').attrs } : undefined,
            issueInfo: child(ident, 'issueInfo') ? { ...child(ident, 'issueInfo').attrs } : undefined,
            language: child(ident, 'language') ? { ...child(ident, 'language').attrs } : undefined,
            techName: dmTitle ? childText(dmTitle, 'techName') : undefined,
            infoName: dmTitle ? childText(dmTitle, 'infoName') : undefined,
            issueDate: child(addr, 'issueDate') ? { ...child(addr, 'issueDate').attrs } : undefined,
            extra: extra.length ? extra.map((e) => nodeToXml(e, 0)) : undefined,
        };
    }

    return {
        type: 'folder',
        title: title || '',
        children: nested.map((c, i) => readEntry(c, warnings, `${pathLabel}/${i + 1}`)),
        extra: extra.length ? extra.map((e) => nodeToXml(e, 0)) : undefined,
    };
}

function parsePm(xml) {
    const warnings = [];
    const doc = parseXml(xml);
    const pm = child(doc, 'pm');
    if (!pm) throw new Error('Not a publication module: no <pm> root element.');

    const ids = child(pm, 'identAndStatusSection');
    const addr = child(ids, 'pmAddress');
    const ident = child(addr, 'pmIdent');
    const items = child(addr, 'pmAddressItems');
    const status = child(ids, 'pmStatus');
    const rpc = child(status, 'responsiblePartnerCompany');
    const orig = child(status, 'originator');
    const logoSymbol = child(child(status, 'logo'), 'symbol');

    const meta = {
        pmCode: child(ident, 'pmCode') ? { ...child(ident, 'pmCode').attrs } : {},
        language: child(ident, 'language') ? { ...child(ident, 'language').attrs } : {},
        issueInfo: child(ident, 'issueInfo') ? { ...child(ident, 'issueInfo').attrs } : {},
        issueDate: child(items, 'issueDate') ? { ...child(items, 'issueDate').attrs } : {},
        pmTitle: (items && childText(items, 'pmTitle')) || '',
        shortPmTitle: (items && childText(items, 'shortPmTitle')) || '',
        securityClassification: (child(status, 'security') || { attrs: {} }).attrs.securityClassification || '01',
        logo: logoSymbol ? { ...logoSymbol.attrs } : undefined,
        rpc: rpc ? { enterpriseCode: rpc.attrs.enterpriseCode || '', enterpriseName: childText(rpc, 'enterpriseName') || '' } : undefined,
        originator: orig ? { enterpriseCode: orig.attrs.enterpriseCode || '', enterpriseName: childText(orig, 'enterpriseName') || '' } : undefined,
    };

    const content = child(pm, 'content');
    const entries = content
        ? content.children.filter((c) => c.name === 'pmEntry').map((c, i) => readEntry(c, warnings, `entry ${i + 1}`))
        : [];

    return { meta, entries, warnings };
}

// ---------------------------------------------------------------------------
// model  ->  PM
// ---------------------------------------------------------------------------

function attrStr(obj, order) {
    if (!obj) return '';
    const keys = order ? order.filter((k) => obj[k] !== undefined && obj[k] !== '') : Object.keys(obj);
    return keys.map((k) => ` ${k}="${escapeAttr(obj[k])}"`).join('');
}

// One <dmRef>, indented by p.
function writeDmRef(entry, p, out) {
    out.push(`${p}<dmRef>`);
    out.push(`${p}  <dmRefIdent>`);
    if (entry.identExtension) out.push(`${p}    <identExtension${attrStr(entry.identExtension, ['extensionProducer', 'extensionCode'])}/>`);
    out.push(`${p}    <dmCode${attrStr(entry.dmCode, DM_CODE_KEYS)}/>`);
    if (entry.issueInfo) out.push(`${p}    <issueInfo${attrStr(entry.issueInfo, ['issueNumber', 'inWork'])}/>`);
    if (entry.language) out.push(`${p}    <language${attrStr(entry.language, ['languageIsoCode', 'countryIsoCode'])}/>`);
    out.push(`${p}  </dmRefIdent>`);
    // Titles and issue date are what the Explorer and the TOC display; a
    // dmRef without them still builds, so they stay optional.
    if (entry.techName !== undefined || entry.infoName !== undefined || entry.issueDate) {
        out.push(`${p}  <dmRefAddressItems>`);
        if (entry.techName !== undefined || entry.infoName !== undefined) {
            out.push(`${p}    <dmTitle>`);
            out.push(`${p}      <techName>${escapeText(entry.techName || '')}</techName>`);
            out.push(`${p}      <infoName>${escapeText(entry.infoName || '')}</infoName>`);
            out.push(`${p}    </dmTitle>`);
        }
        if (entry.issueDate) out.push(`${p}    <issueDate${attrStr(entry.issueDate, ['year', 'month', 'day'])}/>`);
        out.push(`${p}  </dmRefAddressItems>`);
    }
    out.push(`${p}</dmRef>`);
}

function writeEntry(entry, depth, out) {
    const pad = '  '.repeat(depth);
    out.push(`${pad}<pmEntry${entry.page && PAGE_IDS.includes(entry.page) ? ` id="${entry.page}"` : ''}>`);
    if (entry.title) out.push(`${pad}  <pmEntryTitle>${escapeText(entry.title)}</pmEntryTitle>`);

    if (entry.type === 'include') {
        // xi:fallback means "substitute nothing if this file is missing"; it is
        // what stops one absent module aborting the whole XInclude pass.
        if (entry.hasFallback) {
            out.push(`${pad}  <xi:include href="${escapeAttr(entry.href || '')}"><xi:fallback/></xi:include>`);
        } else {
            out.push(`${pad}  <xi:include href="${escapeAttr(entry.href || '')}"/>`);
        }
    } else if (entry.type === 'dm') {
        writeDmRef(entry, `${pad}  `, out);
    } else if (entry.type === 'pmRef') {
        out.push(`${pad}  <pmRef>`);
        if (entry.pmTitle !== undefined || entry.shortPmTitle !== undefined) {
            out.push(`${pad}    <pmRefAddressItems>`);
            if (entry.pmTitle !== undefined) out.push(`${pad}      <pmTitle>${escapeText(entry.pmTitle || '')}</pmTitle>`);
            if (entry.shortPmTitle !== undefined) out.push(`${pad}      <shortPmTitle>${escapeText(entry.shortPmTitle || '')}</shortPmTitle>`);
            out.push(`${pad}    </pmRefAddressItems>`);
        }
        out.push(`${pad}    <pmRefIdent>`);
        if (entry.issueInfo) out.push(`${pad}      <issueInfo${attrStr(entry.issueInfo, ['issueNumber', 'inWork'])}/>`);
        out.push(`${pad}      <pmCode${attrStr(entry.pmCode, ['modelIdentCode', 'pmIssuer', 'pmNumber', 'pmVolume'])}/>`);
        out.push(`${pad}    </pmRefIdent>`);
        out.push(`${pad}  </pmRef>`);
    } else {
        // Agastya: untitled modules in a chapter are bare <dmRef>s of the chapter's
        // <pmEntry>, but only where that still reads back as a chapter (two or more
        // of them, or one beside sub-entries); a lone one stays in its own <pmEntry>.
        const kids = entry.children || [];
        const bareable = (c) => c.type === 'dm' && !c.title && !c.page && !(c.extra && c.extra.length);
        const bare = kids.filter(bareable).length;
        const unwrap = bare >= 2 || (bare === 1 && kids.length > 1);
        for (const c of kids) {
            if (unwrap && bareable(c)) writeDmRef(c, `${pad}  `, out);
            else writeEntry(c, depth + 1, out);
        }
    }

    for (const raw of entry.extra || []) {
        out.push(raw.split('\n').map((l) => `${pad}  ${l}`).join('\n'));
    }
    out.push(`${pad}</pmEntry>`);
}

function serialisePm(model) {
    const m = model.meta || {};
    const out = [];
    out.push('<?xml version="1.0" ?>');
    // Declared only when an include is actually present: an undefined prefix
    // is a parse error, and a stray unused declaration is noise.
    const usesXi = (function has(list) {
        return (list || []).some((e) => e.type === 'include' || has(e.children));
    })(model.entries);
    out.push(`<pm${usesXi ? ' xmlns:xi="http://www.w3.org/2001/XInclude"' : ''}`
        + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xlink="http://www.w3.org/1999/xlink">');
    out.push('  <identAndStatusSection>');
    out.push('    <pmAddress>');
    out.push('      <pmIdent>');
    out.push(`        <pmCode${attrStr(m.pmCode, ['modelIdentCode', 'pmIssuer', 'pmNumber', 'pmVolume'])}/>`);
    out.push(`        <language${attrStr(m.language, ['countryIsoCode', 'languageIsoCode'])}/>`);
    out.push(`        <issueInfo${attrStr(m.issueInfo, ['issueNumber', 'inWork'])}/>`);
    out.push('      </pmIdent>');
    out.push('      <pmAddressItems>');
    out.push(`        <issueDate${attrStr(m.issueDate, ['year', 'month', 'day'])}/>`);
    out.push(`        <pmTitle>${escapeText(m.pmTitle || '')}</pmTitle>`);
    out.push(`        <shortPmTitle>${escapeText(m.shortPmTitle || '')}</shortPmTitle>`);
    out.push('      </pmAddressItems>');
    out.push('    </pmAddress>');
    out.push('    <pmStatus>');
    out.push(`      <security securityClassification="${escapeAttr(m.securityClassification || '01')}"/>`);
    if (m.logo) {
        out.push('      <logo>');
        out.push(`        <symbol${attrStr(m.logo, ['infoEntityIdent', 'reproductionHeight'])}/>`);
        out.push('      </logo>');
    }
    if (m.rpc) {
        out.push(`      <responsiblePartnerCompany enterpriseCode="${escapeAttr(m.rpc.enterpriseCode || '')}">`);
        out.push(`        <enterpriseName>${escapeText(m.rpc.enterpriseName || '')}</enterpriseName>`);
        out.push('      </responsiblePartnerCompany>');
    }
    if (m.originator) {
        out.push(`      <originator enterpriseCode="${escapeAttr(m.originator.enterpriseCode || '')}">`);
        out.push(`        <enterpriseName>${escapeText(m.originator.enterpriseName || '')}</enterpriseName>`);
        out.push('      </originator>');
    }
    out.push('      <qualityAssurance>');
    out.push('        <unverified/>');
    out.push('      </qualityAssurance>');
    out.push('    </pmStatus>');
    out.push('  </identAndStatusSection>');
    out.push('  <content>');
    for (const e of model.entries || []) writeEntry(e, 2, out);
    out.push('  </content>');
    out.push('</pm>');
    return out.join('\n') + '\n';
}

// Flat counts used by the UI footer and by the write guard.
function countEntries(entries) {
    let folders = 0, dms = 0;
    const walk = (list) => {
        for (const e of list || []) {
            if (e.type === 'dm' || e.type === 'include') dms++;
            else { folders++; walk(e.children); }
        }
    };
    walk(entries);
    return { folders, dms, total: folders + dms };
}

module.exports = { parsePm, serialisePm, countEntries, parseXml, DM_CODE_KEYS };
