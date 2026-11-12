'use strict';
// The JSS build pipeline, as a reusable function.
//
//   S1000D XML --[s1000dtojss]--> jssbook --[annotate dims]--> jssbook'
//              --[jsstofo]--> XSL-FO --[FOP]--> PDF
//
// A source that is already a <jssbook> skips stage 1. Extracted from server.js
// (Phase 0) so the web server and the Electron app run the identical pipeline.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { annotateGraphicDimensions } = require('./images');
const { catalogEnv } = require('./catalog');
const { generateFrontMatter, writeFrontMatterOrder } = require('./frontmatter');
const { publishersXml } = require('./frontmatterInject');
const { enabledPages, CATALOGUE } = require('./frontMatterPages');
const { writeImageDimIndex } = require('./imageDims');
const fopd = require('./fopd');
const { checkImages, formatImageCheck, placeholderMissingImages } = require('./foChecks');
const { buildImageCache, rewriteFoImagePaths } = require('./imageOptim');
const toolPaths = require('./paths');

/*
  Agastya: the JSS fopConfArg() and run() helpers were removed here. run()
  went through child_process.exec(), i.e. a shell command line; Agastya
  never builds a shell string (decisions.md C4). Every tool is launched by
  runFile() below: execFile with an argument array, no shell.
*/

/*
  Spawn a program directly, with no shell and no launcher script between us and
  it.

  JSS originally also had a shell-based run() (removed in Agastya, see
  above): cmd.exe plus FOP's fop.bat put two script layers in the path of
  every PDF, which endpoint security on managed machines blocks. execFile
  talks to the executable directly, so the only thing that has to be
  permitted is the bundled java binary.
*/
function runFile(file, args, opts) {
    return new Promise((resolve, reject) => {
        execFile(file, args, opts, (err, stdout, stderr) => {
            if (err) {
                err.stderr = stderr;
                // ENOENT/EACCES here is nearly always the security product, not
                // a missing file — say so, rather than leaving a bare errno.
                if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM') {
                    err.message = `Could not run ${file} (${err.code}). If this machine runs `
                        + 'application or script control, the bundled Java runtime must be '
                        + 'allowed to execute from the installation folder.';
                }
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

function stringparams(pairs) {
    return (pairs || []).map(([n, v]) => `--stringparam ${n} "${v}"`).join(' ');
}

/*
  The same list as argv entries rather than one command line.

  Nothing is quoted here: with execFile there is no shell to strip quotes, so a
  value wrapped in '"' would reach xsltproc WITH the quote marks as part of the
  parameter.
*/
function stringparamArgs(pairs) {
    const out = [];
    for (const [n, v] of pairs || []) out.push('--stringparam', n, String(v));
    return out;
}

/*
  Both stylesheets emit "Unhandled element: <name>" on stderr when an element
  reaches the catch-all and its content is dropped. Nothing used to read that,
  so a whole element type could go missing from every book and the build would
  still report success — which is how <symbol> stayed broken. Tally them by
  name so the build can report the gap instead of swallowing it.
*/
function tallyUnmapped(stderr, into) {
    for (const m of String(stderr || '').matchAll(/Unhandled element:\s*(\S+)/g)) {
        const name = m[1].trim();
        if (name) into.set(name, (into.get(name) || 0) + 1);
    }
    return into;
}

// "symbol x16, foo x2" — most frequent first, so the worst gap reads first.
function formatUnmapped(counts) {
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([n, c]) => `${n} x${c}`)
        .join(', ');
}

function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// xsl:import/xsl:include hrefs are URI references, not raw file paths — a
// literal space (routine once the app is installed under something like
// "Program Files" or, on this app's own default install path, "...\Local\
// Programs\JSS Publisher\...") makes libxslt reject the whole stylesheet with
// "invalid URI reference". Percent-encode each path segment while leaving the
// "/" separators (and ".." segments, which encodeURIComponent leaves alone)
// intact.
function encodeHrefPath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
}

/*
  Confirm FOP actually wrote the PDF.

  fop.bat is a batch wrapper: on a validation error (a duplicate id, say) it
  prints the exception and still exits 0, so `run` sees a clean exit and the
  build reported "Done" with no error anywhere — while the PDF on disk was
  whatever the previous successful build left behind. That is precisely the
  "it says it worked but the PDF is not complete" report this guard exists to
  turn into a visible failure.

  Checked against the FO's own mtime rather than mere existence, so a stale
  file from an earlier run cannot pass for a fresh one.
*/
function assertPdfWritten(pdfAbs, foAbs) {
    let st;
    try { st = fs.statSync(pdfAbs); } catch {
        throw new Error('FOP wrote no PDF. The XSL-FO rendered, but the PDF step produced nothing — '
            + 'check the build log for the FOP error.');
    }
    if (st.size < 1024) {
        throw new Error(`FOP wrote an unusable PDF (${st.size} bytes) — check the build log for the FOP error.`);
    }
    try {
        if (fs.statSync(foAbs).mtimeMs > st.mtimeMs + 1000) {
            throw new Error('FOP left the previous PDF in place — this build produced no new one. '
                + 'Check the build log for the FOP error.');
        }
    } catch (e) { if (/previous PDF/.test(e.message)) throw e; }
}

// Write a driver stylesheet that imports the real stylesheet and overrides its
// top-level params with the given values. This sidesteps xsltproc's fixed
// MAX_PARAMETERS ceiling (hit once the layout has many tunables) and scales to
// any number of settings. Returns the driver filename (relative to workDir).
function writeDriver(workDir, driverName, importHref, params) {
    const overrides = (params || [])
        .map(([n, v]) => `  <xsl:param name="${n}">${xmlEscape(v)}</xsl:param>`)
        .join('\n');
    const xsl =
`<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by engine/build.js. Overrides jsstofo params from the effective
     config. Do not edit; regenerated on every build. -->
<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0">
  <xsl:import href="${encodeHrefPath(importHref.replace(/\\/g, '/'))}"/>
${overrides}
</xsl:stylesheet>
`;
    fs.writeFileSync(path.join(workDir, driverName), xsl, 'utf8');
    return driverName;
}

/*
  Options:
    workDir       cwd for xsltproc/fop (project root); paths below are relative
    xsltproc,fop  absolute tool paths
    stage1Xsl     s1000dtojss/s1000dtojss.xsl (relative to workDir)
    stage2Xsl     jsstofo/jsstofo.xsl
    inputXml      the source XML filename (PM or jssbook), already on disk
    stage1Out     jssbook filename to write from stage 1
    foOut, pdfOut output filenames
    isS1000D      true → run stage 1; false → input is already a jssbook
    classification, watermarkUri   optional --stringparams
    watermarkRepeat  'repeat' | 'no-repeat' for the watermark background
    releaseLabel     e.g. "Release 2", printed in the running head
    stage1Params  [[name,value], ...] from config.stage1Params (stage 1 only:
                  publishers, emblem, book/system name)
    layoutParams  [[name,value], ...] from config.stage2Params (stage 2 only)
    onMessage     optional (msg) => void progress callback

  Resolves { pdf, stage1: {stamped,missing} | null }.
*/
// "1.234s" for anything a second or longer, "842ms" below that.
function fmtMs(ms) {
    return ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms';
}

/*
  Shrink the PDF by optimising the images it embeds, then pointing the
  generated FO at the optimised copies.

  Done on the FO — after both stylesheets, before FOP — so one code path covers
  both pipelines and neither stylesheet needs to know it happened. Source
  artwork is never modified; copies live in .imgcache/<level>/ and are reused
  between builds.
*/
async function applyImageCompression(o, log, timed) {
    const level = Number(o.compression || 0);
    if (!Number.isFinite(level) || level <= 0) return;

    await timed('images-opt', `Optimising images (level ${level})...`, async () => {
        const { map, stats } = buildImageCache(o.workDir,
            [o.csdbDir || 'csdb', o.mediaDir || 'Media'], level);
        if (!map.size) { log('No image savings available'); return; }

        const foPath = path.join(o.workDir, o.foOut);
        const { text, rewritten } = rewriteFoImagePaths(fs.readFileSync(foPath, 'utf8'), map);
        fs.writeFileSync(foPath, text, 'utf8');

        const saved = stats.before - stats.after;
        log(`Images ${(stats.before / 1048576).toFixed(1)} MB -> ${(stats.after / 1048576).toFixed(1)} MB`
            + ` (${Math.round(100 * saved / Math.max(1, stats.before))}% smaller)`
            + `, ${rewritten} reference${rewritten === 1 ? '' : 's'} redirected`
            + (stats.cached ? `, ${stats.cached} reused from cache` : ''));
    });
}

/*
  Final-PDF recompression pass, via the bundled Ghostscript — a second,
  independent lever from applyImageCompression above, which works on the
  source artwork BEFORE FOP ever sees it. This one runs after FOP, on the
  PDF it actually produced, so it also catches whatever FOP itself embedded
  uncompressed (duplicate copies of a repeated figure, uncompressed content
  streams, un-subsetted fonts) — bloat the pre-FOP pass has no way to see.

  o.pdfCompressLevel is 0-100, same shape as the image-compression slider:

    0        off — the PDF FOP wrote is shipped exactly as rendered.
    1-100    Ghostscript rewrites it through pdfwrite. Font/stream
             compression and duplicate-image folding happen at every level
             (genuinely lossless — nothing above touches a pixel); ABOVE
             that floor, this also scales image downsample resolution and
             JPEG re-encoding quality down as the level rises, the same
             quality-for-size trade the image slider makes, just applied to
             the whole finished page rather than one source file at a time.

  Ghostscript occasionally hands back a LARGER file than it was given (an
  already tightly-packed input with nothing left to fold, most likely at
  low levels), so the smaller of the two is kept rather than trusting the
  pass unconditionally.
*/
async function applyLosslessCompression(o, log, timed) {
    const level = Number(o.pdfCompressLevel || 0);
    if (!Number.isFinite(level) || level <= 0) return;
    if (!toolPaths.hasGhostscript) {
        log('PDF compression skipped (Ghostscript not available)');
        return;
    }
    await timed('gs', `Compressing PDF (Ghostscript, level ${level})...`, async () => {
        const pdfPath = path.join(o.workDir, o.pdfOut);
        const tmpPath = pdfPath + '.gstmp';
        const before = fs.statSync(pdfPath).size;
        // 300dpi/95% JPEG quality just above the floor, easing down to
        // 72dpi/40% at 100 — the same curve shape the image-compression
        // bands describe (steep early savings, diminishing after ~60).
        const dpi = Math.round(300 - (level / 100) * 228);
        const jpegQ = Math.round(95 - (level / 100) * 55);
        try {
            await runFile(toolPaths.GS, [
                '-sDEVICE=pdfwrite',
                '-dCompatibilityLevel=1.4',
                '-dNOPAUSE', '-dQUIET', '-dBATCH', '-dSAFER',
                '-dDownsampleColorImages=true', '-dColorImageResolution=' + dpi,
                '-dDownsampleGrayImages=true', '-dGrayImageResolution=' + dpi,
                '-dDownsampleMonoImages=true', '-dMonoImageResolution=' + Math.max(dpi, 150),
                '-dColorImageDownsampleType=/Bicubic', '-dGrayImageDownsampleType=/Bicubic',
                '-dAutoFilterColorImages=false', '-dColorImageFilter=/DCTEncode',
                '-dAutoFilterGrayImages=false', '-dGrayImageFilter=/DCTEncode',
                '-dJPEGQ=' + jpegQ,
                '-dCompressFonts=true',
                '-dSubsetFonts=true',
                '-dDetectDuplicateImages=true',
                `-sOutputFile=${tmpPath}`,
                pdfPath,
            ], { cwd: o.workDir, maxBuffer: 10 * 1024 * 1024, env: toolPaths.childEnv() });
        } catch (e) {
            log('PDF compression failed (' + e.message + '); keeping the uncompressed PDF');
            try { fs.unlinkSync(tmpPath); } catch { /* never written */ }
            return;
        }
        if (!fs.existsSync(tmpPath)) {
            log('PDF compression produced no output; keeping the uncompressed PDF');
            return;
        }
        const after = fs.statSync(tmpPath).size;
        if (after < before) {
            fs.renameSync(tmpPath, pdfPath);
            const saved = before - after;
            log(`PDF ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB`
                + ` (${Math.round(100 * saved / Math.max(1, before))}% smaller)`);
        } else {
            fs.unlinkSync(tmpPath);
            log('PDF compression made no improvement; keeping original');
        }
    });
}

async function buildJss(o) {
    // JAVA_HOME points at the bundled JRE: the fop.bat fallback resolves Java
    // through it, so neither the warm daemon nor the fallback depends on the
    // customer having Java installed.
    const execOpts = {
        cwd: o.workDir,
        maxBuffer: 10 * 1024 * 1024,
        // childEnv strips the AppImage runtime's LD_LIBRARY_PATH, which would
        // otherwise point the bundled java/xsltproc at Electron's libraries.
        /*
          catalogEnv points libxml2 at the S1000D schema and entity sets on
          disk. Without it the URLs in every document resolve to nothing — the
          network is off — and the ISO character entities are simply not
          defined, so "40&deg;C" publishes as "40C". Missing characters, no
          error: the worst way for this to fail.
        */
        env: toolPaths.childEnv({
            ...catalogEnv(),
            ...(toolPaths.hasBundledJre ? { JAVA_HOME: toolPaths.JRE_HOME } : null),
        }),
    };
    const log = o.onMessage || (() => {});

    // Per-phase timing. `timed` wraps a phase (sync or async), logs a start
    // message, records how long it took, and logs the elapsed time so the slow
    // step in a build is obvious in the progress stream.
    const buildStart = Date.now();
    const timings = [];
    async function timed(key, startMsg, fn) {
        if (startMsg) log(startMsg);
        const s = Date.now();
        const r = await fn();
        const ms = Date.now() - s;
        timings.push([key, ms]);
        log(`${startMsg ? startMsg.replace(/\.\.\.$/, '') : key} — ${fmtMs(ms)}`);
        return r;
    }
    const cls = o.classification ? ['--stringparam', 'security.classification', o.classification] : [];
    const wm = o.watermarkUri
        ? ['--stringparam', 'watermark.image.uri', o.watermarkUri,
           '--stringparam', 'watermark.repeat', o.watermarkRepeat || 'no-repeat']
        : [];
    // The release the document is on, printed with the running head. Empty
    // for an unreleased document, which the NOT RELEASED watermark covers.
    const rel = o.releaseLabel ? ['--stringparam', 'release.label', o.releaseLabel] : [];
    // intentionally-blank.svg sits next to the stage-2 stylesheet. The
    // stylesheet's own default assumes the dev-checkout layout (a fixed
    // number of ".." steps from workDir back to the repo root); a packaged
    // build's project directory doesn't have that relationship to the app's
    // files at all, so the real path is computed here instead.
    const blankSvg = ['--stringparam', 'blank.page.svg',
        `${encodeHrefPath(path.dirname(o.stage2Xsl).replace(/\\/g, '/'))}/intentionally-blank.svg`];
    // Hand-authored abbreviations, merged with the harvested <acronym> terms.
    // Passed only when the file is there — document() on a missing href aborts
    // the transform, so an absent stencil must mean "no parameter", not "empty".
    const abbrevRel = path.join(o.frontmatterDir || path.join('jss', 'frontmatter'),
        '12-list-of-abbreviations.xml').replace(/\\/g, '/');
    const abbrev = fs.existsSync(path.join(o.workDir, abbrevRel))
        ? ['--stringparam', 'abbrev.stencil', abbrevRel] : [];
    // The system illustration lives in settings, not in the source, so it has
    // to reach stage 1 as a parameter the way the abbreviations stencil does.
    const sysImg = o.systemImage ? ['--stringparam', 'system.image', o.systemImage] : [];
    const brandingBase = [...stringparamArgs(o.stage1Params), ...abbrev, ...sysImg];

    // Layout params go through a generated driver stylesheet (not --stringparam)
    // to avoid xsltproc's MAX_PARAMETERS limit. cls/watermark stay on the CLI:
    // they are per-build runtime values, few in number.
    const stage2Xsl = (o.layoutParams && o.layoutParams.length)
        ? writeDriver(o.workDir, 'jss-run.xsl', o.stage2Xsl, o.layoutParams)
        : o.stage2Xsl;

    /*
      Publishers, written out for stage 1 to read.

      Not passed as --stringparams: there can be any number of them, each with a
      name, a logo and several address lines, which a small generated document
      expresses well and a flat parameter list does not. That flat list is why
      only two publishers ever reached the JSS engine.
    */
    let publishersFile = null;
    if (o.branding && (o.branding.publishers || []).length) {
        publishersFile = '_publishers.xml';
        fs.writeFileSync(path.join(o.workDir, publishersFile), publishersXml(o.branding), 'utf8');
    }

    // Set by the front-matter phase below and consumed by stage 1, so it has to
    // be declared before that block rather than alongside the other build state.
    let orderFile = null;

    // Regenerate the config-driven front-matter files before rendering, so the
    // xi:includes stage 2 resolves reflect the current settings.
    if (o.frontMatter) {
        await timed('frontmatter', 'Generating front matter...', async () => {
            const fmDir = path.join(o.workDir, o.frontmatterDir || path.join('jss', 'frontmatter'));
            // buildJss is the JSS pipeline; its stylesheet renders whatever a
            // notice contains, so these pages keep the plain <para> form.
            const { written, kept } = generateFrontMatter(o.frontMatter, fmDir, 's1000dtojss');
            log(`Generated ${written.length} front-matter pages from config`);
            /*
              These pages are indexed documents: they can be opened in the
              editor, which means a browser tab may be holding a CRDT copy of
              the version we have just replaced on disk. Writing the file alone
              leaves that copy alive and the two lineages later merge into a
              doubled file — two whole XML documents in one, which fails the
              build at the xi:include with "Extra content at the end of the
              document".

              So the caller is given a chance to put the new content through
              the same path a direct save takes. The engine cannot do it
              itself: it has no access to the document index.
            */
            if (o.onGenerated) {
                await o.onGenerated(
                    (o.frontmatterDir || path.join('jss', 'frontmatter')).split(path.sep).join('/'),
                    written.map((name) => ({ name, content: fs.readFileSync(path.join(fmDir, name), 'utf8') })),
                );
            }
            // Say so out loud: the page is now the author's, and Settings will
            // no longer change it until the file is deleted.
            if (kept.length) {
                log(`Kept your edits to ${kept.join(', ')} — these no longer follow Settings`
                    + ` (delete the file to go back to the generated version)`);
            }

            // Which pages appear and in what order is settings-driven, and
            // stage 1 cannot read settings — so the resolved order is written
            // out for it to iterate.
            const pages = enabledPages(o.frontMatter);
            orderFile = writeFrontMatterOrder(o.workDir, pages, fmDir);
            const off = CATALOGUE.length - pages.length;
            if (off > 0) log(`Front matter: ${pages.length} pages, ${off} turned off`);
        });
    }

    let stamp = null;
    const unmapped = new Map();
    const stage2Input = o.isS1000D ? o.stage1Out : o.inputXml;

    if (o.isS1000D) {
        // Stage 1 needs no --xinclude; the front matter it emits is resolved by
        // stage 2. Classification is passed through so status text can use it;
        // branding params carry publishers/emblem/book name into bookmeta.
        // Appended here, not above, because the order file is only written
        // once the front-matter phase has run.
        const branding = [
            ...brandingBase,
            ...(orderFile ? ['--stringparam', 'frontmatter.order', orderFile] : []),
            ...(publishersFile ? ['--stringparam', 'publishers.file', publishersFile] : []),
        ];
        await timed('map', 'Mapping S1000D to JSS book...', async () =>
            tallyUnmapped((await runFile(o.xsltproc,
                ['--nonet', ...cls, ...branding, '-o', o.stage1Out, o.stage1Xsl, o.inputXml],
                execOpts)).stderr, unmapped));
        stamp = await timed('images', 'Stamping image dimensions...', async () =>
            annotateGraphicDimensions(path.join(o.workDir, o.stage1Out), o.workDir,
                [o.csdbDir || 'csdb', o.mediaDir || 'Media']));
    } else {
        log('Source is already a JSS book; skipping S1000D mapping');
        stamp = await timed('images', 'Stamping image dimensions...', async () =>
            annotateGraphicDimensions(path.join(o.workDir, o.inputXml), o.workDir,
                [o.csdbDir || 'csdb', o.mediaDir || 'Media']));
    }
    if (stamp) log(`Stamped image dimensions on ${stamp.stamped} graphics` +
                   (stamp.repaired ? `, ${stamp.repaired} src paths repaired` : '') +
                   (stamp.missing ? `, ${stamp.missing} unreadable` : ''));

    await timed('fo', 'Rendering XSL-FO...', async () =>
        tallyUnmapped((await runFile(o.xsltproc,
            ['--xinclude', '--nonet', ...cls, ...wm, ...rel, ...blankSvg, '-o', o.foOut, stage2Xsl, stage2Input],
            execOpts)).stderr, unmapped));
    if (unmapped.size) log(`Unmapped elements (content dropped): ${formatUnmapped(unmapped)}`);

    await applyImageCompression(o, log, timed);

    // FOP renders a missing image as a silent blank, so check before it runs.
    const images = checkImages(path.join(o.workDir, o.foOut), o.workDir);
    { const m = formatImageCheck(images); if (m) log(`Image references: ${m}`); }
    if (images.missing.length) {
        const n = placeholderMissingImages(path.join(o.workDir, o.foOut), o.workDir);
        if (n) log(`Drew ${n} "artwork not available" placeholder(s) for missing images`);
    }

    // Prefer the warm-JVM FOP daemon (saves ~1.7s cold start). Fall back to
    // fop.bat if it isn't available or errors, so a build never depends on it.
    let usedDaemon = false;
    await timed('pdf', 'Generating PDF (FOP)...', async () => {
        if (o.warmFop !== false && fopd.isAvailable()) {
            try {
                await fopd.render({
                    baseDir: o.workDir,
                    foPath: path.join(o.workDir, o.foOut),
                    pdfPath: path.join(o.workDir, o.pdfOut),
                });
                usedDaemon = true;
            } catch (e) {
                log('Warm FOP unavailable (' + e.message + '); running FOP via java');
            }
        }
        if (!usedDaemon) {
            // Direct java invocation: see runFile, and paths.FOP_ARGS.
            const fopArgs = toolPaths.FOP_ARGS.slice();
            if (fs.existsSync(toolPaths.FOP_XCONF)) fopArgs.push('-c', toolPaths.FOP_XCONF);
            fopArgs.push('-fo', o.foOut, '-pdf', o.pdfOut);
            await runFile(toolPaths.JAVA, fopArgs, execOpts);
        }
        assertPdfWritten(path.join(o.workDir, o.pdfOut), path.join(o.workDir, o.foOut));
    });

    await applyLosslessCompression(o, log, timed);

    // One-line breakdown so the slowest phase is obvious at a glance.
    const total = Date.now() - buildStart;
    const labels = { frontmatter: 'front', map: 'map', images: 'img', fo: 'fo', pdf: 'pdf', gs: 'gs' };
    const breakdown = timings.map(([k, ms]) => `${labels[k] || k} ${fmtMs(ms)}`).join(' · ');
    log(`Done in ${fmtMs(total)} — ${breakdown} (${usedDaemon ? 'warm FOP' : 'FOP via java'})`);

    return {
        pdf: o.pdfOut, stage1: stamp, timings, totalMs: total, images,
        unmapped: [...unmapped.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    };
}

/*
  The alternate, single-stage pipeline: S1000D XML --[s1000dtofo.xsl]--> FO
  --[FOP]--> PDF directly, with no JSS intermediate and no two-layer settings
  applied. This is the pre-refactor engine, restored verbatim as a second,
  independent build path so a project can opt into a fixed "native S1000D"
  render instead of (never instead OF, always alongside) the customizable
  S1000D-to-JSS pipeline above, which this function does not touch at all.

  Options: workDir, xsltproc, fop, stylesheetXsl (s1000dtofo/s1000dtofo.xsl,
  relative to workDir), inputXml (the PM, already on disk), foOut, pdfOut,
  onMessage. Resolves { pdf, timings, totalMs }.
*/
// The top-level xsl:param names a stylesheet declares. Used to pass only the
// settings this pipeline can actually consume: handing it a name it declares
// as a VARIABLE instead (or not at all) is either a redefinition error or dead
// weight, and this pipeline supports a much smaller set than jsstofo.
/*
  Every parameter the stylesheet declares, following xsl:include/xsl:import.

  Anything not in this set is dropped before the driver is written, because
  overriding a name the stylesheet declares as a *variable* is a hard compile
  error. Following the include graph matters: a param declared in an included
  file is perfectly usable, and reading only the entry file would silently
  discard it — the same silent-drop failure this filter exists to prevent.
*/
function declaredParams(xslPath, seen) {
    const visited = seen || new Set();
    const abs = path.resolve(xslPath);
    if (visited.has(abs)) return new Set();
    visited.add(abs);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { return seen ? new Set() : null; }
    const out = new Set([...src.matchAll(/<xsl:param\s+name="([^"]+)"/g)].map((m) => m[1]));
    for (const m of src.matchAll(/<xsl:(?:include|import)\s+href="([^"]+)"/g)) {
        for (const n of declaredParams(path.join(path.dirname(abs), m[1]), visited)) out.add(n);
    }
    return out;
}

async function buildS1000dToFo(o) {
    // JAVA_HOME points at the bundled JRE: the fop.bat fallback resolves Java
    // through it, so neither the warm daemon nor the fallback depends on the
    // customer having Java installed.
    const execOpts = {
        cwd: o.workDir,
        maxBuffer: 10 * 1024 * 1024,
        // childEnv strips the AppImage runtime's LD_LIBRARY_PATH, which would
        // otherwise point the bundled java/xsltproc at Electron's libraries.
        /*
          catalogEnv points libxml2 at the S1000D schema and entity sets on
          disk. Without it the URLs in every document resolve to nothing — the
          network is off — and the ISO character entities are simply not
          defined, so "40&deg;C" publishes as "40C". Missing characters, no
          error: the worst way for this to fail.
        */
        env: toolPaths.childEnv({
            ...catalogEnv(),
            ...(toolPaths.hasBundledJre ? { JAVA_HOME: toolPaths.JRE_HOME } : null),
        }),
    };
    const log = o.onMessage || (() => {});
    const buildStart = Date.now();
    const timings = [];
    // Side-car index of real image pixel sizes. The JSS pipeline stamps these
    // onto its generated book; here the source data modules must stay
    // untouched, so the sizes are written alongside for figures.xsl to read.
    try {
        const { count } = writeImageDimIndex(o.workDir, o.csdbDir, o.mediaDir);
        log(`Indexed ${count} image${count === 1 ? '' : 's'} for sizing`);
    } catch (e) {
        log('Image sizing index unavailable (' + e.message + '); figures scale to fit');
    }
    async function timed(key, startMsg, fn) {
        if (startMsg) log(startMsg);
        const s = Date.now();
        const r = await fn();
        const ms = Date.now() - s;
        timings.push([key, ms]);
        log(`${startMsg ? startMsg.replace(/\.\.\.$/, '') : key} — ${fmtMs(ms)}`);
        return r;
    }

    // --xinclude: this stylesheet resolves the PM's data-module references via
    // xi:include (unlike the s1000dtojss pipeline, which uses document()), so
    // every referenced DM must actually be on disk or the whole build aborts.
    // Apply the project's settings, restricted to the ones this pipeline
    // actually declares — page geometry, margins, fonts, blank versos and TOC
    // depth. The heading/list/figure tunables are jsstofo-only and are dropped
    // rather than injected as dead (or clashing) globals. Delivered through a
    // generated driver stylesheet for the same reason buildJss does it: it
    // sidesteps xsltproc's fixed MAX_PARAMETERS ceiling.
    let stylesheet = o.stylesheetXsl;
    const declared = declaredParams(path.join(o.workDir, o.stylesheetXsl));
    const applicable = (o.layoutParams || []).filter(([n]) => !declared || declared.has(n));
    if (applicable.length) {
        stylesheet = writeDriver(o.workDir, 's1000dtofo-run.xsl', o.stylesheetXsl, applicable);
        log(`Applied ${applicable.length} layout setting${applicable.length === 1 ? '' : 's'}`);
    }
    const cls = o.classification ? ['--stringparam', 'security.classification', o.classification] : [];
    const wm = o.watermarkUri
        ? ['--stringparam', 'watermark.image.uri', o.watermarkUri,
           '--stringparam', 'watermark.repeat', o.watermarkRepeat || 'no-repeat']
        : [];
    const rel = o.releaseLabel ? ['--stringparam', 'release.label', o.releaseLabel] : [];
    // See buildJss's identical blankSvg: intentionally-blank.svg sits next to
    // this pipeline's own stylesheet, and a packaged build's project
    // directory has no fixed ".." relationship back to the app's files.
    const assetDir = encodeHrefPath(path.dirname(o.stylesheetXsl).replace(/\\/g, '/'));
    const blankSvg = ['--stringparam', 'blank.page.svg', `${assetDir}/intentionally-blank.svg`];
    // Same reasoning, for the 'hazard' notice style's striped frame images.
    const hazardStripes = [
        '--stringparam', 'notice.hazard.caution.image', `${assetDir}/hazard-caution-stripes.svg`,
        '--stringparam', 'notice.hazard.warning.image', `${assetDir}/hazard-warning-stripes.svg`,
    ];

    const unmapped = new Map();
    await timed('fo', 'Rendering XSL-FO (direct S1000D)...', async () =>
        tallyUnmapped((await runFile(o.xsltproc,
            ['--xinclude', '--nonet', ...cls, ...wm, ...rel, ...blankSvg, ...hazardStripes, '-o', o.foOut, stylesheet, o.inputXml],
            execOpts)).stderr, unmapped));
    if (unmapped.size) log(`Unmapped elements (content dropped): ${formatUnmapped(unmapped)}`);

    await applyImageCompression(o, log, timed);

    const images = checkImages(path.join(o.workDir, o.foOut), o.workDir);
    { const m = formatImageCheck(images); if (m) log(`Image references: ${m}`); }
    if (images.missing.length) {
        const n = placeholderMissingImages(path.join(o.workDir, o.foOut), o.workDir);
        if (n) log(`Drew ${n} "artwork not available" placeholder(s) for missing images`);
    }

    let usedDaemon = false;
    await timed('pdf', 'Generating PDF (FOP)...', async () => {
        if (o.warmFop !== false && fopd.isAvailable()) {
            try {
                await fopd.render({
                    baseDir: o.workDir,
                    foPath: path.join(o.workDir, o.foOut),
                    pdfPath: path.join(o.workDir, o.pdfOut),
                });
                usedDaemon = true;
            } catch (e) {
                log('Warm FOP unavailable (' + e.message + '); running FOP via java');
            }
        }
        if (!usedDaemon) {
            // Direct java invocation: see runFile, and paths.FOP_ARGS.
            const fopArgs = toolPaths.FOP_ARGS.slice();
            if (fs.existsSync(toolPaths.FOP_XCONF)) fopArgs.push('-c', toolPaths.FOP_XCONF);
            fopArgs.push('-fo', o.foOut, '-pdf', o.pdfOut);
            await runFile(toolPaths.JAVA, fopArgs, execOpts);
        }
        assertPdfWritten(path.join(o.workDir, o.pdfOut), path.join(o.workDir, o.foOut));
    });

    await applyLosslessCompression(o, log, timed);

    const total = Date.now() - buildStart;
    const breakdown = timings.map(([k, ms]) => `${k} ${fmtMs(ms)}`).join(' · ');
    log(`Done in ${fmtMs(total)} — ${breakdown} (${usedDaemon ? 'warm FOP' : 'FOP via java'})`);

    return {
        pdf: o.pdfOut, timings, totalMs: total, images,
        unmapped: [...unmapped.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    };
}

module.exports = { buildJss, buildS1000dToFo };
