# Agastya roadmap

Status on 31 October 2026 (milestone 6.5 to 10 added; section 6), written from the code, the tests and the records
in this folder, not from memory. Sources: `decisions.md` (the decision ids
below), `editor-parity.md`, `production.md`, the route table
(`server/routes/*.js`), the Agastya original's specification
(`jss-agastya source code/Agastya_V.01/docs/SPECIFICATION.md`, parts 2, 3,
14 and 15) and the JSS Publisher original (`PDFPublishingCommon`). The
original PROMPT.md is not on this machine; its phases are known through
`decisions.md`, which cites it.

**Status:** Done (built and covered by Node, security and browser tests on
Node 24 and 22), Partial, Missing, Blocked (waits on something outside the
code), Skipped (ruled out by a decision).

## 1. Phases

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 1 | Sign-in, sessions, accounts, roles, dashboards, audit, notifications | Done | A1 to A10, R1 to R13; `test/auth-*.test.js`, `user-management.test.js` |
| 2a | Workspaces, write path and revisions, data modules, XSD and BREX, graphics, DMRL, PDF build | Done | D1 to D12, G1 to G10; `test/content.test.js` |
| 2b | Publication builder, preview, live progress, submission with snapshot, drafts, Author dashboard | Done | B1 to B15; `test/checkpoint2b.test.js` |
| 2c | Structured editor and Monaco XML panel | Done | E1 to E8 |
| Lock | Content lock while a request is pending | Done | L1 to L4; `test/lock.test.js` |
| 3 | Project Manager dashboard, approvals, review, decisions, rework | Done | M1 to M10; `test/phase3.test.js`, `e2e/07` |
| 4 | Administrator dashboard, audit viewer, health, overrides | Done | V1 to V13; `test/phase4.test.js`, `e2e/08` |
| 5 | Backup and restore | Done (Windows drill Blocked) | K1 to K14; `test/backup.test.js`, `e2e/99`; `production.md` section 4 |
| 2d | Page-view editor, parity and functional repair | Done, with the gaps in section 2 | PV1 to PV40; `editor-parity.md`; `e2e/10` to `e2e/16` |
| Release gaps | Missing-artwork PDF, Ctrl+S race, Windows checklist | Done (Windows checks Blocked) | PV39, PV40, K14; `production.md` |
| 6 | CSDB package exchange: project export, checked bulk import of modules and graphics | Done | CX1 to CX6; `test/csdb-package.test.js`, `test/package.test.js`, `e2e/17` |

## 2. Remaining features

| # | Feature | Status | Evidence | Depends on | Priority |
|---|---|---|---|---|---|
| 1 | Replace or update existing modules from a package (today: skipped, never replaced) | Missing | CX4 | Phase 6; conflict and lock rules for a batch | High |
| 2 | Publication settings beyond wording | Partial: identity, publishers, page size and margins, body font and size, contents depth, blank versos, pipeline and watermark done (ST1-ST7); headings, tables, lists, notices, classification banner, front-matter page choice and house-template editing not yet | `PDFPublishingCommon/client/src/settingsCatalogue.js`; ST1 | done | Medium (rest) |
| 3 | Branding upload (emblem, publisher logos) | Done (ST4) | `POST /branding` | | |
| 4 | Front-matter page editor | Missing | JSS `FrontMatterPages.jsx` | Item 2 | Medium |
| 5 | Batch tools: file name against code audit, safe rename, code and ICN reports | Partial (the package check reports name and code mismatches, CX4) | Original batch screen | Phase 6 | Medium |
| 6 | Graphics gallery, titles, ICN issues, symbols, parts | Done except a thumbnail grid view (GR1-GR6) | Original 3.9 | | Low |
| 7 | CIR screen (Common Information Repository modules) | Missing | Original 2.1, v1.4 | none | Low to medium |
| 8 | Reference data editing by the administrator (info codes, CAGE codes, countries) | Missing (read-only seed lists, G9) | Original 3.10 "S1000D configurations" | none | Medium |
| 9 | Data module labels, flags, notes, "assigned to me" | Missing | Original 3.3 | none | Low |
| 10 | Ownership transfer when a Project Manager is disabled | Partial (pending requests reassignable, V6) | O4 | none | Medium |
| 11 | Editor: track changes, accept and reject, review comments | Missing | `editor-parity.md`; original Phase 6 "Review mode", v1.3 | Snapshot and revision model | Medium |
| 12 | Editor: drag blocks and column borders, "text only" and "containers only" tag views, empty-container check | Partial | `editor-parity.md` | none | Low |
| 13 | Applicability filtering, conditional text | Missing | Original v1.2 | Publication settings | Low until a customer asks |
| 14 | DDN generation for a delivery | Missing | Original v1.1 | Phase 6 export | Low to medium |
| 15 | Shells for Issues 5.0 and 6.0 (validation of 3.0 to 6.0 already works, G4) | Partial | D1, G4 | none | Low |
| 16 | HTML site output, SCORM, IETP viewer | Skipped | P4 | Saxon, CommonStyleSheet | Only on request |
| 17 | Desktop app, licence keys, custom stylesheet injection | Skipped | Status report of 28 Oct; a security risk | none | No |
| 18 | Real-time co-editing | Skipped | One editor per module by design (conflict detection, PV) | none | No |

## 3. Blocked (outside the code)

| Item | Blocked on | Where |
|---|---|---|
| Golden build with the bundled Windows Java and xsltproc | A Windows machine | V12, `production.md` sections 1 and 3 |
| NTFS permissions, antivirus, backup and restore drill on NTFS | A Windows machine | `production.md` sections 2 and 4 |
| libxml2 2.9.3 in the bundled xsltproc | A decision by whoever owns the production machine | X1 |
| Browsers other than Chromium | Not installed here | `playwright.config.js` |

These stay deferred to the deployment-hardening phase, as asked.

## 4. Order and reasons

1. **Phase 6, CSDB package exchange** (done now). It was the largest functional gap that every later item builds on: a project could not be handed over or loaded in bulk, the original's MVP Phase 6 lists it ("Import (bulk XML DMs with pre-validation report)", "Export … to zip", "Graphic Entities (… zip import …)"), and all it depends on was done (write path, validation, graphics, lock, overrides, backups to undo a bad import).
2. **Phase 7, publication settings and branding** (items 2 to 4). This is the remaining JSS Publisher integration: today a developer edits the house template to change the layout. The engine already reads every setting; the work is a validated settings model on the write path, a settings screen, and branding uploads.
3. **Phase 8, CSDB maintenance**: item 1 (updates from a package, with revisions, lock and conflict rules), item 5 (batch tools) and item 14 (DDN).
4. Then items 6 to 11 by customer need, and the deployment-hardening phase (section 3) before go-live.

## 5. Milestone 6.5 to 10: plan and parity with the JSS PDF Publisher

Audited on 30 October 2026 against `jss-agastya source code/PDFPublishingCommon`
(`server/server.js`, `server/engine/*.js`, `client/src/**`, `README.md`) and
the Agastya code. "Reference" below is that application.

### 5.1 What the reference actually does (evidence)

- **Formats.** A project's source type is `S1000D` or `JSS`
  (`client/src/components/NewProjectModal.jsx`; `server/engine/db.js`:
  `type TEXT … 'S1000D' | 'JSS'`). An S1000D project builds through
  `s1000dtojss` (S1000D → `<jssbook>` → `jsstofo` → FOP, "Customize") or
  `s1000dtofo` (direct). A JSS project's publication is a `<jssbook>` built by
  `jsstofo` alone. There is **no JSS schema**: the vocabulary is what
  `jsstofo/*.xsl` matches (jssbook, bookmeta, frontmatter, body, chapter,
  section, para, list, item, table, figure, image, warning, caution, note, …).
  **"JSG" does not exist in either reference** (no file, schema, stylesheet,
  setting or string; the only matches are random bytes in a lock file and a
  source map). See 5.4.
- **Folders.** A folder is a `group` string on each project, flat, called
  "workspace" in the UI; deleting one unfiles its projects, never deletes
  them; owner and grants per folder (`folder_owners`, `folder_grants`).
- **Watermark** (`server/engine/watermark.js`, `server.js` `releaseStateOf`):
  decided at **build** time, in one place, from the release state. A
  publication is *released* when an approved release is in force **and** its
  fingerprint matches the content now. Unreleased: a forced diagonal
  `NOT RELEASED` (colour `#C2410C`, opacity 0.3) that no setting can switch
  off. Released: the project's own watermark if enabled (horizontal, diagonal
  or tiled), and `Release N` in the running head. The SVG is the FO
  region-body background (`watermark.image.uri`), sized to the printable box
  from the page geometry. Both build and preview apply it.
- **Settings drawer** (`settingsIndex.js`, `SettingsDrawer.jsx`): Publication
  (Identity = `publication.*`, Publishers = `publishers[]` with logos,
  Template), Front matter, Page and type (layout, headings, lists), In the
  text (figures, notices, margin notes). Stored in `project.json` over a
  house template (`engine/config.js mergeConfig`).
- **Page sizes ("Resize Pages")**: there is no command of that name. The
  mechanisms are page geometry (`layout.page.*`), a whole module on a
  landscape page by putting it under a `pmEntry id="a4-landscape"` or
  `"a3-landscape"`, and a single table or figure with `orient="land"`
  (README, "Landscape pages").
- **Graphics**: `MediaManager.jsx` splits csdb/ (ICNs beside the modules)
  from Media/ (logos, emblems, symbols). Symbols are ICNs used by
  `<symbol infoEntityIdent>`. Parts are the IPD content (`catalogSeqNumber`,
  `itemSeqNumber`, `partRef`), not a separate asset store.

### 5.2 Feature-parity matrix

| Feature | Reference implementation | Agastya before this milestone | Missing | Planned (phase) |
|---|---|---|---|---|
| Folders / workspaces | flat `group` folders, owner and grants, unfile on delete | none | everything | 6.5: workspaces with nested folders, projects in a folder or none; ownership and permissions stay on the project |
| Move projects | edit the group | none | move | 6.5: move between folders and workspaces; data, members, history untouched (folders are records only) |
| Import a project from a zip | `POST /api/projects/import` | package import into an existing project (Phase 6) | create-from-zip | 6.5: new project from a package |
| Project from an XML file | New project with a source type | none | it | 6.5: new project from a data module, a publication module or a JSS book, format detected and confirmed |
| Source formats | S1000D, JSS | S1000D only (engine already builds a `<jssbook>`) | JSS projects | 7: format adapters (S1000D, JSS), format on the project |
| S1000D → JSS | the `s1000dtojss` stage of every Customize build | used inside the build only | as a user conversion | 7: convert a project into a new JSS project with a report; the original kept |
| JSS → S1000D, JSG | none | none | no mapping exists | 7: refused with a reason (no invented mapping) |
| Editor / DMs | Monaco on every file | page view, tags, XML for S1000D | JSS editing | 7: the XML editor with JSS checks for a JSS book; page view stays S1000D |
| DMC import/export | file tree upload and download | import, package | single-file download | 8: download a module |
| PMC import/export | file tree | import (G7) | download | 8: download the publication module |
| Graphics, symbols, parts | MediaManager; symbols by use; parts in IPD | ICN list with thumbnails, upload | categories, delete, duplicates, ICN revisions, parts | 8: ICNs / Symbols / Parts views, duplicate and conflict detection, ICN issue as revision, graphics zip export, delete when unused |
| Validation | ValidationPanel | XSD + BREX + project checks | format-aware | 7/8: JSS checks; dashboard summary |
| Members | MembersPanel with project roles | owner + Authors (R9 to R13) | (role model differs on purpose) | kept; shown on the dashboard |
| Identity | Settings > Identity | none (only wording, D9) | it | 8: identity settings, saved in `project.json` |
| Publishers / branding | Settings > Publishers, logos | none | it | 8: up to two publishers with logo uploads |
| Page geometry / Resize Pages | layout.page, pmEntry landscape ids, `orient="land"` | none | all three | 8: page size and margins; per-module page in the builder; landscape toggle on tables and figures |
| Pipeline (template) choice | Customize or S1000D default | fixed `s1000dtojss` | choice | 8: per project |
| Side-by-side editor and PDF | split preview, pop-out | preview panel beside the editor | resizable, saved/unsaved, refresh on save, jump to page | 9 |
| Release and watermark | releaseStateOf + watermark.js | approvals (Phase 3), no marking | marking | 10: same rule on build and preview; download refused when the PDF on disk no longer matches the release state |
| Build provenance | fingerprint per release | builds table (ok, ms) | which content and settings | 10: fingerprint, settings hash, release, PDF hash per build |

### 5.3 Order

6.5 → 7 → 8 → 9 → 10, then the full regression on Node 24 and 22, then one
browser run from project creation to the final PDF download.

### 5.4 Blocker: JSG

JSG is not defined anywhere in the material available here. Inventing a
schema would break the rule not to, so JSG is recorded as **blocked: needs
its definition** (a schema, a sample book and the stylesheet that renders
it). The format registry is built so that a JSG adapter is one more entry.

## 6. Status after milestone 6.5 to 10 (31 October 2026)

| Phase | Status | Evidence |
|---|---|---|
| 6.5 Workspaces and project lifecycle | Done | WS1-WS6; `test/workspaces.test.js` (7), `e2e/18` (2) |
| 7 Formats (S1000D, JSS; S1000D to JSS) | Done; **JSG blocked** (5.4) | FM1-FM6; `test/formats.test.js` (4), `e2e/19` |
| 8 Dashboard, settings, identity, publishers, Resize Pages, ICNs, symbols, parts, DMC/PMC files | Done | ST1-ST7, GR1-GR6; `test/project-features.test.js` (8), `e2e/19` (3) |
| 9 Editor beside its PDF | Done | SW1-SW4; `e2e/20` |
| 10 Release marking and download control | Done | RL1-RL6; `test/releases.test.js` (4), `e2e/21` (creation to released download) |

Parity matrix rows (5.2) now implemented: all, except JSS to S1000D and JSG
(refused with a reason) and these limits:

- A figure cannot be set landscape on its own: S1000D 4.2 has no `orient` on
  `<figure>` (the reference stylesheet honours it, the schema refuses it).
  Tables (`orient="land"`), chapters and modules can.
- A JSS book is edited as XML (with its checks); the page-view editor is
  built on the S1000D content models and is S1000D only.
- Parts are read from and added to IPD modules; editing or removing a part
  is done in the module's editor.
- Going to the PDF page of the selection works where the selected element's
  title or text is found in the preview's text; elsewhere no page is claimed.
- Watermarks are on every non-cover page, as the reference stylesheets draw
  them; covers and intentionally blank pages carry none.

Next: the deployment-hardening phase (section 3), then roadmap items 1, 5
to 11 and 13 to 15 by need; JSG once its definition is supplied.

## 7. Author Panel UI redesign (31 October 2026)

A UI/UX restructuring, not a new backend: every new screen reuses an
existing API (the project package export, the per-project graphics
catalogue, the workspace tree) or adds a small, obviously-scoped one
(decisions.md UI1-UI5, GL1-GL4).

| Area | What changed |
|---|---|
| Theme, notifications, profile | Already global and persisted (`theme.js`, `TopBar.jsx`); unchanged. |
| Author navigation | Overview (Dashboard, Workspace, Projects), Authoring (Graphics), Other (Backup). The old standalone "Data modules" and "Publications" pickers are superseded and unlinked, not deleted (`/data-modules`, `/publications` still work). |
| Dashboard | "Recent data modules" removed; "My projects" replaced by **Recently opened projects** (new `project_opens` table, migration 016, `POST /api/projects/:id/opened`); the header action is **View Projects**, not a creation dialog. |
| Workspace page | `/workspaces`: every visible workspace, searchable, with folder/project counts; **Open** selects it on the Projects page (`?ws=`). |
| Projects page | The existing two-panel explorer (workspace tree + project table) now supports **drag-and-drop** (a project onto any node; a folder onto another node of the same workspace, matching the API's own limit) alongside the existing Move dialogs, plus a **Last modified** column. |
| Graphics library | `/graphics`: ICNs and Symbols in a thumbnail grid across every visible project (reuses `content/assets.js`'s per-project catalogue, aggregated by a new `GET /api/graphics`), with search, pagination ("show more"), and upload (asks which project first, then the existing `POST /api/projects/:id/graphics`). |
| Backup | `/backup`: per-project and "download all" zips, both the existing CSDB package export (`exportPackage`), the "all" case nesting each project's zip inside one outer zip (`GET /api/backup/all.zip`). Documented as a content backup, not a database backup with history/members — that stays the administrator's system backup. |
| Project workspace | Opening a project now goes straight to a focused editor: `/projects/:id/workspace` resolves to the JSS book editor (`BookWorkspace.jsx`, the Phase 9 SplitPane reused directly) or redirects to the most recently edited data module's existing editor route. Overview/Data modules/Graphics/Publication/Settings are one click away through a new `ProjectMenu` dropdown; `DmEditor` gained a document switcher to move between modules without leaving the editor. |

**A real bug found and fixed while testing**: `UploadGraphicDialog`'s reset
effect depended on the `projects` array reference, so the central
library's `onDone` → `reload()` (a new array each time) wiped the
just-shown "Uploaded" result before it could be read. Fixed by resetting
only on `open` becoming true, as `AddPartDialog` already does elsewhere in
the codebase.

**Tests**: `e2e/22-author-panel-redesign.spec.js` (7 scenarios, including a
real mouse-driven drag-and-drop) plus `nav.test.mjs` updated for the new
author navigation. The redesign's navigation changes required fixing two
pre-existing specs whose assumptions it deliberately changed (opening a
project by name, and the dashboard's empty-project text) — not weakened,
updated to the new intended behaviour. Full regression (`npm test`,
`test:security`, doctor, golden, Playwright) passes on Node 24.21.0 and
22.23.4.
