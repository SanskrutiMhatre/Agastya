# Provenance of copied and downloaded components

Everything the Agastya PDF build and XML validation need lives inside this project folder (decisions.md P5). This file lists every item that was **not written for Agastya**, where it came from, its version and its licence. `npm run doctor` checks they are all present.

**JSS Publisher reuse.** Items marked *JSS* were copied from the company's own **JSS Publisher** (`jss-publisher` v1.1.1, working tree inspected 17 October 2026, source revision f4d8210) **with permission to reuse**, confirmed by the user before checkpoint 2a. They remain company code under the same terms as JSS Publisher.

**Agastya original reuse.** Items marked *Agastya* were copied, unmodified, from the original Agastya source supplied read-only at `docs/reference/agastya sourcecode/Agastya_V.01` (commit `db7e250`, 11 September 2026), on 25 October 2026, before checkpoint 2b. Each copy was checked byte-identical to its source with `cmp`.

JSS items were copied on 20 October 2026. Nothing was copied from `node_modules`, `.git`, user data (`workspace/projects`, backups), `.env` files, licence keys or private keys. The JSS licence tooling (`license.js`, `license-cli.js`, `master-password.js`) and the LemMinX language server were deliberately left out.

## Third-party binaries (`tools/`)

| Item | Version | Came from | Licence | Notes |
|---|---|---|---|---|
| `tools/jre/` Eclipse Temurin JRE, Windows x64 | **21.0.12.1+1 LTS** (2026-08-18) | **Downloaded** from Adoptium: `OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip` via `api.adoptium.net` → `github.com/adoptium/temurin21-binaries` (release `jdk-21.0.12.1+1`), 48,999,141 bytes, SHA-256 `d35f31e712f0fcf6ac5a093edc90204fbff22f720ba3950bd09d331d5e621636` (matched the checksum Adoptium publishes) | GPL-2.0 with Classpath Exception; third-party notices in `tools/jre/legal/` | JSS shipped no Java runtime (it used Java on the PATH), so this was downloaded. |
| `tools/fop-2.10/` Apache FOP | 2.10 | JSS `server/tools/fop-2.10` (Apache distribution) | Apache-2.0 (`LICENSE`, `NOTICE`) | Copied: `fop/build/fop*.jar`, `fop/lib/` (all jars and their licence/notice files), `fop/conf/`, top-level `LICENSE`, `NOTICE`, `README`. Left out: javadocs, examples, sample outputs, launcher scripts (`fop.bat` etc.; Agastya runs `java` directly). |
| Bundled FOP dependencies (`fop/lib`) | Batik 1.18, xmlgraphics-commons 2.10, fontbox 2.0.27, commons-io 2.11.0, commons-logging 1.3.0, xml-apis 1.4.01, xml-apis-ext 1.3.04 | as above | Apache-2.0; xml-apis also W3C/SAX notices (files alongside each jar) | |
| `tools/libxslt-1.1.28-win32-x86/` xsltproc | libxslt 1.1.28, libexslt 0.8.17, **libxml2 2.9.3**, 32-bit MinGW build (2015) | JSS `server/tools/libxslt-1.1.28-win32-x86` | libxslt and libxml2: MIT (texts in `tools/licenses/`) | Copied `bin/` and `share/doc/` only. **Known published vulnerabilities in libxml2 2.9.3**: accepted with mitigations; re-check before production (decisions.md X1). |
| DLLs alongside xsltproc | `libiconv-2.dll` (libiconv 1.14, FSF), `zlib1.dll` (zlib 1.2.8), `libgcc_s_dw2-1.dll` (MinGW GCC runtime, no version resource), `libwinpthread-1.dll` (MinGW-w64 winpthreads 1.0.0.0), `regex2.dll` (GnuWin32 regex 2.7) | as above | libiconv: LGPL-2.1; zlib: zlib licence; libgcc: GPL-3.0 with GCC Runtime Library Exception 3.1; winpthreads: MIT and BSD-3-Clause; regex2: LGPL-2.1 | Versions read from each DLL's version resource. Licence texts in `tools/licenses/`, listed below. |
| `tools/fonts/DejaVuSans*.ttf` | DejaVu Sans (4 faces) | JSS `server/tools/fonts` | DejaVu Fonts licence (Bitstream Vera derived; DejaVu changes public domain) | Licence text **downloaded** to `tools/licenses/DejaVu-LICENSE.txt` from `raw.githubusercontent.com/dejavu-fonts/dejavu-fonts/version_2_37/LICENSE` (SHA-256 `7a083b13…5958a93`). JSS's README noted it was missing. |
| `tools/fop.xconf` | n/a | *JSS* `server/tools/fop.xconf` | company (JSS) | Registers the DejaVu family for FOP. |
| `tools/licenses/libxslt-1.1.28-Copyright.txt` | 1.1.28 | **Downloaded** from `gitlab.gnome.org/GNOME/libxslt/-/raw/v1.1.28/Copyright` (SHA-256 `7e48e290…a851819`) | MIT | |
| `tools/licenses/libxml2-2.9.3-Copyright.txt` | 2.9.3 | **Downloaded** from `gitlab.gnome.org/GNOME/libxml2/-/raw/v2.9.3/Copyright` (SHA-256 `c5c63674…78574bd`) | MIT | |
| `tools/licenses/libiconv-1.14-LGPL-2.1.txt` | LGPL 2.1 | **Downloaded** from `www.gnu.org/licenses/old-licenses/lgpl-2.1.txt` (SHA-256 `20e50fe7…a3555d95`) | | For `libiconv-2.dll`. |
| `tools/licenses/regex2-GnuWin32-LGPL-2.1.txt` | LGPL 2.1 | Same text as above (identical SHA-256) | | For `regex2.dll` (GnuWin32 regex is distributed under the LGPL). |
| `tools/licenses/libgcc-GPL-3.0.txt` | GPL 3.0 | **Downloaded** from `www.gnu.org/licenses/gpl-3.0.txt` (SHA-256 `3972dc97…fb36986`) | | For `libgcc_s_dw2-1.dll`, read with the exception below. |
| `tools/licenses/libgcc-GCC-Runtime-Library-Exception-3.1.txt` | 3.1 | **Downloaded** from the GCC source tree, `COPYING.RUNTIME` in the official GitHub mirror `github.com/gcc-mirror/gcc` (SHA-256 `9d6b43ce…bdc90f74`); `gcc.gnu.org` refused the request (HTTP 429) at the time | | The exception that lets the runtime ship with programs under other licences. |
| `tools/licenses/zlib-1.2.8-LICENSE.txt` | 1.2.8 | **Downloaded** from `github.com/madler/zlib`, tag `v1.2.8`, `README` (the zlib licence is its final section) (SHA-256 `53a466b5…ae7159f9`) | zlib | For `zlib1.dll`. |
| `tools/licenses/libwinpthread-COPYING.txt` | winpthreads | **Downloaded** from the mingw-w64 source, `mingw-w64-libraries/winpthreads/COPYING` in the GitHub mirror `github.com/mingw-w64/mingw-w64` (SHA-256 `63263614…a8a1b177`) | MIT and BSD-3-Clause | For `libwinpthread-1.dll`. |

## Schemas (`vendor/schemas/`)

| Item | Version | Came from | Licence | Notes |
|---|---|---|---|---|
| S1000D XSD sets | Issues 3.0, 4.1, 4.2, 5.0, 6.0 (flat schemas, unmodified) | JSS `schemas/` (which took them from the official S1000D releases; see `vendor/schemas/PROVENANCE.md`) | S1000D specification terms of use | About 35 MB. `xml.xsd` added by JSS where missing. |
| ISO character entity sets (`<issue>/ent/`) | for 3.0, 4.2, 5.0 | as above (OASIS/S1000D sets) | ISO 8879 entity sets, freely redistributable | **None for 4.1 and 6.0**: the source pack has none; doctor reports this as a note. |

## Pipelines and engine (`vendor/pipeline/`, `vendor/engine/`, `vendor/templates/`) — *JSS*

| Item | Came from | Modifications in Agastya |
|---|---|---|
| `vendor/pipeline/s1000dtojss/`, `wellformed.xsl` | JSS `server/pipeline/` | None. |
| `vendor/pipeline/jsstofo/`, `s1000dtofo/` | JSS `server/pipeline/` | Before checkpoint 2b: `jsstofo.xsl` and `s1000dtofo.xsl` declare two more parameters, `fm.label.title.authorityHeading` and `fm.label.title.authority`, and `jsstofo/frontmatter.xsl` prints the title page's authority block through `fm-label`, with the JSS wording as the default ("Under the Authority of" / "Secretary, Ministry of Defence, Govt. of India"); a value of `-` leaves that line out. The "L&T Document No.:" label was already overridable (`fm.label.foreword.documentNo`). Both are project settings (decisions.md D9). A project without overrides builds exactly as before (golden test). |
| `vendor/pipeline/jss/frontmatter/` (13 front-matter stencils), `jss/samples/` | JSS `server/pipeline/jss/` | None. |
| `vendor/engine/build.js` | JSS `server/engine/build.js` | Removed the unused shell helpers `run()` (child_process `exec`) and `fopConfArg()`; every tool is launched with `execFile` and an argument array (decisions.md C4). After the image check, missing images are replaced by a visible placeholder before FOP runs (decisions.md PV39). |
| `vendor/engine/paths.js` | JSS `server/engine/paths.js` | Rewritten for the Agastya layout (`tools/`, `vendor/schemas`, `vendor/pipeline`). No PATH fallback and no environment override for Java or xsltproc; no Ghostscript. |
| `vendor/engine/catalog.js` | JSS | Temporary catalogue file renamed to `agastya-s1000d-catalog.xml`. |
| `vendor/engine/foChecks.js` | JSS `server/engine/foChecks.js` | Image paths are percent-decoded and absolute or `file:` paths resolved before an image is called missing; added `placeholderMissingImages` (decisions.md PV39). |
| `server/publish/pdf.js` `printableBoxMm` | JSS `server/server.js` `printableBoxMm` and `PAGE_GEOMETRY_DEFAULTS` | Comments shortened; same defaults and arithmetic. |
| `vendor/engine/watermark.js` | JSS `server/engine/watermark.js` (SHA-256 `46caab6d…5992f42`, copied 30 Oct 2026) | None. Called from `server/publish/pdf.js` with the release state (decisions.md RL2). |
| `vendor/engine/buildErrors.js`, `config.js`, `doubled.js`, `fopd.js`, `frontMatterPages.js`, `frontmatter.js`, `frontmatterInject.js`, `imageDims.js`, `imageOptim.js`, `images.js`, `resolveDmRefs.js`, `xmlGuard.js`, `pm-outline.xsl` | JSS `server/engine/` | None. |
| `vendor/engine/pmc.js` | JSS `server/engine/pmc.js` | Checkpoint 2b: a `<pmEntry>` with several `<dmRef>`s (or one beside nested entries) is read as a chapter of modules instead of keeping only the first `<dmRef>`, and untitled modules in such a chapter are written back as bare `<dmRef>`s; `writeDmRef` factored out of `writeEntry` (decisions.md B3). Phase 8: a `<pmEntry id="a4-landscape">` / `"a3-landscape"` is read into the entry's `page` and written back (it was dropped) (decisions.md ST6). |
| `vendor/engine/validateSchema.js` | JSS `server/engine/validateSchema.js` | `validateDocument` takes an optional `file` (the schema file to use when a document declares none), so a module with no schema location is checked against its recorded type, as the Agastya original does. |
| `vendor/engine/fopserver/FopServer.java`, `FopServer.class`, `warmup.fo` | JSS `server/engine/fopserver/` | None (warm FOP renderer). |
| `vendor/templates/default.house.json` | JSS `workspace/templates/default.house.json` | None. Only the default house template was copied; JSS's other templates were customer experiments. |
| `vendor/templates/agastya.house.json` | Written for Agastya from `default.house.json` | Neutral branding, artwork pages off, generic foreword. |

## From the Agastya original (`vendor/brex/`, `vendor/templates/shells/`, `vendor/reference-data/`) — *Agastya*

| Item | Came from | SHA-256 | Notes |
|---|---|---|---|
| `vendor/brex/S1000D-default-4.2.xml` | `backend/brex/S1000D-default-4.2.xml` | `4746b308…aa2393b6` | The **S1000D Issue 4.2 default BREX** (`DMC-S1000D-F-04-10-0301-00A-022A-D`, issue 001-00, 31 December 2016), as published with the S1000D specification; copyright ASD, AIA and ATA e-Business Program (S1000D terms of use, stated in the file). About 260 rules. Used when a module's `brexDmRef` names no BREX in the project. Unmodified. |
| `vendor/templates/shells/descript42.xml`, `descript41.xml`, `proced42.xml`, `proced41.xml`, `ipd42.xml`, `ipd41.xml` | `backend/templates/shells/` | `852ad6d3…`, `d490f8fb…`, `bb080f22…`, `0f5f1722…`, `4e102ae1…`, `e7a52280…` | New data modules are these shells with the identity stamped in (`server/content/shells.js`). Unmodified: `descript41.xml` says `issueType="changed"`, which the default BREX rejects for a first issue, so the stamping writes `new` rather than the file being edited. |
| `vendor/templates/shells/descript23.xml`, `proced23.xml` | as above | `fddb1462…`, `6859a6e2…` | Copied for completeness but **not offered**: Issue 2.3 uses other element names, so the stamping cannot address them, and no 2.3 schema is bundled. |
| `vendor/reference-data/country-codes.json`, `language-codes.json`, `security-classes.json`, `info-codes.json`, `sns.json`, `originator-cages.json`, `rpc-cages.json`, `dm-types.json` | `backend/data/config-<name>.json` (renamed without the `config-` prefix) | `93b7a4a8…`, `86db0bcd…`, `7962288c…`, `1cb561d3…`, `e37b8288…`, `328b38a3…`, `ec0e511f…`, `9faab6a5…` | Seed lists for the authoring dialogs, served by `GET /api/reference-data` (code and name only). Company data from the original; `dm-types.json` is kept for reference and not served. |

## npm packages

Installed from the npm registry and recorded in `package-lock.json` (not copied): `jpeg-js` (BSD-3-Clause), which the vendored `imageOptim.js` requires; `jszip` (dual MIT or GPL-3.0, used under MIT) and `@xmldom/xmldom` (MIT), which the DMRL reader ported from the Agastya original's `XlsxGrid.ts` uses; `ws` 8 (MIT), the WebSocket server (checkpoint 2b).

Client (bundled into `client/dist`, not copied): `monaco-editor` **0.56.0** (MIT), the XML panel (checkpoint 2c), installed from npm; its dependency `dompurify` is overridden to **3.4.17** (Apache-2.0 or MPL-2.0) for a critical advisory in the version Monaco pins (decisions.md E7).

Ported from the Agastya original (commit `db7e250`): `scripts/build-content-models.mjs` (from `backend/scripts/build-content-models.mjs`) and `client/src/schema/contentModel.js` (from `frontend/src/schema/ContentModel.ts`), adapted as described in their headers and in decisions.md E1 and E2; `client/src/lib/pmcTree.js` (from `frontend/src/lib/pmcTree.ts`, checkpoint 2b). `client/src/data/content-models.json` is generated by that script from `vendor/schemas` and is not copied.

Development only: `@playwright/test` **1.64.0** (Apache-2.0), pinned exactly and released 7 October 2026 (more than two weeks before it was installed), for the browser tests. Its Chromium build (chromium-1248, with the headless shell, ffmpeg and winldd helpers) was **downloaded** by `npx playwright install chromium` from Playwright's official download host, with `PLAYWRIGHT_BROWSERS_PATH=0`, so it lives inside the project under `node_modules/playwright-core/.local-browsers/`. It is a test tool and is not used by the application.

## Open items

- libxml2 2.9.3 / libxslt 1.1.28 must be re-assessed before production (decisions.md X1).
