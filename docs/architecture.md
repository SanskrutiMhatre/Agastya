# Agastya architecture

Agastya is an S1000D publication authoring and publishing platform. This note covers what exists after Phase 10. See `decisions.md` for the reasoning behind each choice.

## Runtime

```
Browser (React SPA, client/)  ──HTTP /api──▶  Node + Express 5 (server/)  ──▶  data/agastya.db (node:sqlite, WAL)
  sign-in, gates, dashboards                   csrf → json → validate → guard → handler
  users, reset queue, projects                 evaluate() decides every request
```

The server is one process. In production it serves the built client from `client/dist`. In development, Vite (port 5173) proxies `/api` to the server (port 3535) and leaves the `Host` header unchanged, so the CSRF Origin check sees one origin.

Content will stay on disk in the S1000D project layout (`csdb/`, `Media/`, `publication.xml`, `project.json`) from Phase 2. The database holds identity, governance and metadata only.

## Server layout

| Path | Responsibility |
|---|---|
| `server/server.js` | `createServer({dataDir, env, log, now})` builds the app; `start()` listens. Middleware order: security headers, CSRF Origin check, JSON body (100 KB), routes, SPA fallback, error handler. |
| `server/db/migrations.js` | Ordered, additive, named migrations `001` to `013` (Phase 5 adds none) (users and sessions, resets, projects, notifications, ownership, documents and revisions, data modules, graphics, publication requests, drafts, builds and validation runs, request modules and history, administrator overrides and override sessions). |
| `server/db/store.js` | Every SQL statement. Prepared statements are cached. `tx()` wraps `BEGIN IMMEDIATE`. |
| `server/auth/crypto.js` | Argon2id or scrypt hashing, `dummyVerify`, tokens, SHA-256. |
| `server/auth/policy.js` | Password policy, username rules, reserved names, full names, `tempPasswordFor`. |
| `server/auth/sessions.js` | Cookie parsing and formatting, issuing sessions (single active, gated sessions capped at 30 min), resolving them. |
| `server/auth/rateLimit.js` | Sliding window, 10 per 15 min per username + IP. |
| `server/auth/authz.js` | `evaluate(user, action, ctx)` and the guard factories `requireAuth`, `can(action, loader)`, `publicRoute(reason)`. Guards carry `isAuthGuard` / `isPublicMarker`. The rule table also holds the approval-request rules (`request.read`, `request.decide`, `request.submit`), used by the Phase 2 and Phase 3 routes; `request.queue` is the approvals queue. |
| `server/auth/bootstrap.js` | First Software Administrator from the environment. |
| `server/audit.js` | Append-only audit with sanitised metadata. A failed write is logged and swallowed. Each row is passed on to the notifier. |
| `server/notify.js` | Maps audit actions to notifications for the people concerned. |
| `server/http/validate.js` | Body schemas: types, lengths, enums; unknown fields refused. |
| `server/http/errors.js` | Uniform `{error, code}` responses and the final error handler. |
| `server/routes/*.js` | `auth`, `users`, `resets`, `projects`, `dashboard`, `content`, `publication`, `requests`, `drafts`, `admin` (Phase 4), `misc` (health, notifications, SPA). `kit.js` holds the shared content helpers. |
| `scripts/reset-admin-password.js` | Break-glass temporary password for the Software Administrator. |

## Authorization model

Every route's first middleware is exactly one guard, and every guard decision goes through `evaluate()`:

1. **No session** (missing, expired, revoked, or account disabled): 401 `UNAUTHENTICATED`.
2. **Account gate**: onboarding pending → 403 `ONBOARDING_REQUIRED`; forced change → 403 `PASSWORD_CHANGE_REQUIRED`. Only each gate's own exit route is allowed through.
3. **Action rule** from the rule table in `authz.js`:
   - wrong role → 403 `FORBIDDEN`
   - resource outside scope (another manager's Author, a project you neither own nor are assigned to) → 404 `NOT_FOUND`
   - escalation attempt → 403 `ROLE_NOT_ALLOWED`

`test/routes-guarded.test.js` walks the Express route table. It fails if a route has no guard, if the guard is not first, or if the public set changes (`/api/health`, `/api/auth/login`, `/api/auth/forgot`, SPA fallback).

## Content and PDF (Phase 2, checkpoints 2a and 2b)

```
Browser ─ /api/projects/:id/dms, /graphics, /dmrl, /publication, /settings/wording, /validate, /build; /api/reference-data
   │
   ▼  can(content.read | content.write | content.build)
server/routes/content.js
   ├─ content/documents.js   THE write path: guard → well-formed → containment → conflict (409) → atomic write → revision
   ├─ content/dmc.js         data module code rules; file name = DMC-<code>.xml
   ├─ content/shells.js      Agastya shells (vendor/templates/shells) + identity stamping
   ├─ content/validation.js  XSD per issue, with fallbacks + BREX (project BREX, else vendor/brex default 4.2) + project checks
   ├─ content/graphics.js    ICN rules (case kept), content sniffing, expected location, next ICN
   ├─ content/dmrl.js        Agastya 16-column DMRL: export (exceljs), import (jszip + xmldom)
   └─ publish/pdf.js         full build and preview → vendor/engine (JSS) → tools/ (JRE, xsltproc, FOP)
```

| Path | Responsibility |
|---|---|
| `<dataDir>/projects/<id>/` | The project workspace: `project.json`, `publication.xml`, `csdb/`, `Media/`, `jss/frontmatter/`, `.deleted/`, `.previews/` (last preview per module), build outputs (`output.pdf`, `_preview.pdf`, intermediate FO/XML). |
| `vendor/engine/` | JSS build engine (copied with permission; changes listed in `vendor/PROVENANCE.md`). |
| `vendor/pipeline/`, `vendor/schemas/`, `vendor/templates/` | XSLT pipelines and stencils; S1000D XSD sets and entity sets; house templates and data module shells. |
| `vendor/brex/`, `vendor/reference-data/` | The S1000D 4.2 default BREX and the authoring seed lists, from the Agastya original. |
| `tools/` | Third-party binaries: Temurin JRE, xsltproc + DLLs, Apache FOP, fonts, licence texts. |
| `scripts/doctor.js` | `npm run doctor`: everything the build needs is inside the project. |
| `scripts/golden.mjs` | `npm run golden`: builds `samples/golden` and compares page count and text with its baseline. |

## Data model (Phase 1)

| Table | Purpose |
|---|---|
| `users` | Identity, role (3 values), PHC password hash, gates, temporary-password lifecycle (`temp_password_expires_at`, `temp_password_used_at`), `disabled_at`, `created_by`. |
| `sessions` | `token_hash` (SHA-256), `expires_at`, `revoked_at` + reason, IP, user agent, last seen. |
| `audit_log` | Append-only (triggers refuse UPDATE/DELETE). Actor, IP, action, target, project, sanitised JSON metadata. |
| `password_reset_requests` | Forgot-password queue: one pending request per user; `approver_id`; decision. |
| `projects` | `id`, `name` (unique, case-insensitive), description, `owner_id` (the one owner: an Author or a Project Manager; required), `created_by`, status. `manager_id` is a legacy mirror of `owner_id`. |
| `project_members` | Author assignments: `(project_id, user_id)`, `added_by`, `added_at`. |
| `notifications` | Per-user notifications derived from audit actions; `read_at`. |
| `documents` | One row per source file in a workspace (data modules, the publication module); `rel_path` is data, so renames keep history. (migration 006) |
| `blobs` | Content stored once by SHA-256; immutable. (006) |
| `revisions` | Immutable history: document, blob hash, path at the time, reason, author. (006) |
| `data_modules` | DM manager records: code, schema, issue, titles, status, soft delete. (007) |
| `graphics` | ICN registry: file location, format, size, SHA-256, uploader. (008) |
| `publication_requests` | Approval requests: publication, submitter, chosen manager, status, note, fingerprint, snapshot location, validation counts, PDF hash, stale reason, decision fields (status, `decided_by`, `decided_at`, `decision_comment`). Fingerprint and snapshot fields are immutable; rows are never deleted; one pending request per publication. (009) |
| `drafts` | Autosaved unsaved text per user, project and source key. (010) |
| `builds`, `validation_runs` | Build and validation outcomes per project, for the dashboards. (011) |
| `admin_overrides` | Every administrator override: kind (decision, reset, reassign, content, members), the underlying action, project, request, target, editing session, **reason**. Append-only. (013) |
| `override_sessions` | The administrator's content-editing sessions: document key, reason (fixed), the sign-in it belongs to, last use, end and why. (013) |
| `request_modules` | The data modules each request froze, `(request_id, data_module_id, rel_path)`, recorded at submission; drives the status flow. `publication_requests.previous_request_id` links a request to the one before it for the same publication (the history chain). (012) |
| `schema_migrations` | Applied migration names. |

## Publication, approval and live updates (Phase 2, checkpoint 2b)

```
Browser ─ /api/projects/:id/publication/model|import|ietm-form|pdf-form   (routes/publication.js → content/publication.js)
        ─ /api/projects/:id/requests, /approvers; /api/requests/...       (routes/requests.js → content/requests.js)
        ─ /api/projects/:id/drafts/:key, /api/drafts/mine                 (routes/drafts.js)
        ─ /ws?project=<id>   upgrade: Origin = Host, live session, content.read  (realtime.js)
   ▲
   │ push only
events (in-process hub, server.js)
   ├─ 'content'  every audited content change   → WebSocket "saved by", request stale check
   ├─ 'build'    progress lines (publish/runner.js) → WebSocket build log
   └─ 'audit'    every audited action           → WebSocket re-check sweep
```

| Path | Responsibility |
|---|---|
| `server/content/publication.js` | Builder model (tree, pool, titles, missing), entry validation, splice of `<content>` only, round-trip check, IETM/PDF forms. |
| `server/content/requests.js` | Publication sources, fingerprint, snapshot writing (read-only, outside the workspace). |
| `server/content/xinclude.js` | XInclude containment, used by the write path and by the build. |
| `server/publish/runner.js` | Runs a build, emits its progress, records it in `builds`. |
| `server/realtime.js` | The WebSocket: authentication, scoping, re-checks, delivery. |
| `<dataDir>/snapshots/<request id>/` | `sources/`, `publication.pdf`, `validation.json`, `manifest.json`. |
| `e2e/` | Browser tests (Playwright) against a real server; screenshots in `e2e/screenshots/{light,dark}/`. |

## Structured editor and XML panel (Phase 2, checkpoint 2c)

```
DmEditor (lazy route) ── xml text (single source) ──┬── StructuredEditor + Inspector  (client/src/editor/)
                                                    │     parseXml → edit DOM → serializeXml  (xmlDoc.js)
                                                    │     contentModelFor(issue, schemaType)  (schema/contentModel.js)
                                                    └── XmlPanel (Monaco, lazy)  completion from the same content model
save / drafts / conflicts / lock / validation: unchanged, on the xml text
scripts/build-content-models.mjs: vendor/schemas/*.xsd → client/src/data/content-models.json
```

## Project Manager dashboard and approvals (Phase 3)

```
Author ── POST /api/projects/:id/requests ──► snapshot + request_modules ──► modules in_review, manager notified
Manager ─ GET  /api/requests/queue                      the chosen manager's requests (admin: all, oversight)
        ─ GET  /api/requests/:id                        files (sha256), modules, history chain, canDecide
        ─ GET  /api/requests/:id/source?rel=            frozen source, manifest-listed paths only
        ─ GET  /api/requests/:id/revisions[?rel=|/:rev] revision history up to submission
        ─ GET  /api/requests/:id/validation             the frozen validation report
        ─ POST /api/requests/:id/decision {outcome, comment}
              live fingerprint ≠ snapshot → 409 STALE, request stale, modules draft
              else decided, modules approved | draft, audit request.decided (comment length only), Author notified
```

| Path | Responsibility |
|---|---|
| `server/content/workflow.js` | The data module status flow (decisions.md M3): the only place statuses change; the newest request governs a module; saving an approved module makes it draft. |
| `server/routes/requests.js` | Queue, review, sources, revisions, validation, decision, withdraw; `seesComments` (M6). |
| `server/routes/dashboard.js` | The manager dashboard: pending requests and team activity (M8: owned projects, Author actions, draft flag and time, never content). |
| `server/notify.js` | `request.submitted` (and resubmission), `request.decided`, `request.stale`, `user.disabled` (owners of the Author's other projects). |
| `client/src/pages/approvals/` | `ApprovalsPage` (queue) and `ReviewPage` (lazy: PDF, read-only sources and revisions, validation, history, decision form). |

## Software Administrator dashboard (Phase 4)

```
Admin ─ GET  /api/admin/oversight            projects, workload, who is working on what, stuck requests
      ─ GET  /api/admin/audit[.csv]          presenter (auditView.js): allow-listed details per action
      ─ GET  /api/admin/health               toolchain (health/toolchain.js, also npm run doctor), builds, storage, backup
      ─ GET  /api/admin/sessions             every live session (revoke: POST /api/sessions/:id/revoke)
      ─ POST /api/requests/:id/override-decision | override-reset | reassign   {…, reason}
      ─ POST /api/projects/:id/members, DELETE …/members/:userId               {…, reason}
      ─ POST /api/projects/:id/override-sessions {key, reason} ──► session id
            then the normal write routes with  X-Agastya-Override-Session: <id>
            (+ X-Agastya-Override-Stale: accept to save a file a pending request froze → request stale)
every override ─► overrides.record(): admin_overrides row + audit 'admin.override' (reason, recipients) ─► notifier
```

| Path | Responsibility |
|---|---|
| `server/overrides.js` | Records an override (table + audit row) and names who is told; content saves under a session notify once per session. |
| `server/auth/authz.js` | `request.override`, `content.override.start`, `override.session.end`, `draft.write`, `request.approvers`, `admin.*`; `loaders.withReason`, `loaders.withOverride` (checks the session: owner, sign-in, project, document, 30 min idle). |
| `server/auditView.js` | The only way audit rows leave the server: allow-list per action, CSV with formula neutralising. |
| `server/routes/admin.js` | Oversight, audit, health, sessions, override sessions. |
| `client/src/components/OverrideDialog.jsx` | The reason dialog every override uses. |
| `client/src/components/OverrideSession.jsx` | "Edit as administrator": the editing session, its bar, idle and leave handling, the stale confirmation. `api.js` adds the session header and retries an accepted stale save. |
| `client/src/pages/admin/` | Audit log, System health, Sessions tab. |

## Page-view editor (checkpoint 2d)

```
DmEditor ── xml text (single source) ──┬── Design: PageView (editor/PageView.jsx) + dialogs (PageDialogs.jsx)
                                       ├── Tags:   StructuredEditor (2c)
                                       ├── Split:  the last of those beside XmlPanel
                                       └── XML:    XmlPanel (Monaco)
every edit: parseXml → ops.js / xmlDoc.js edit (recorded) → serializeXml (unchanged parts copied from the source) → onChange
save / drafts / conflicts / lock / override sessions / validation: unchanged, on the xml text
```

| Path | Responsibility |
|---|---|
| `client/src/editor/xmlDoc.js` | Parse with a source map; record edits; serialise losslessly; `pathAtLine` for findings. |
| `client/src/editor/ops.js` | Formats, references, ids and targets, figures (with the ICN entity declaration), CALS tables (rows, columns, the occupancy grid, merge and split), lists, the identification and status values. |
| `client/src/editor/PageView.jsx` | The page (including procedure requirements as tables), the toolbar, menus, keyboard shortcuts, context menu, text runs, the outline. |
| `client/src/editor/commands.js` | Parity commands: blocks before/after, sections and steps, moves, list exit, cell ranges and alignment, columns with spans, widths, fuller references, find and replace, counts, id tools, re-indent, live checks. |
| `client/src/editor/PageMenus.jsx` | Menu bar, context menu, find and replace, word count, shortcuts, column widths, attributes dialogs; print. |
| `client/src/editor/PageDialogs.jsx` | Insert palette, reference, figure, table and identification dialogs. |
| `client/src/pages/approvals/ReviewPage.jsx` | The review's Sources: Design (PageView, read-only, artwork from the snapshot), Tags and XML. |

## Backup and restore (Phase 5)

```
Admin ─ GET    /api/admin/backups                list + status (schedule, retention, last, warnings)
      ─ POST   /api/admin/backups                create ─┐
      ─ POST   /api/admin/backups/:bid/verify            │
      ─ DELETE /api/admin/backups/:bid                   │
      ─ POST   /api/admin/backups/:bid/restore   {confirm, password, reason}
                                                         ▼
server/backup/service.js ── maintenance gate (writes held, or everything for a restore)
   create:  VACUUM INTO + copy files (+ AES-256-GCM) → manifest + seal → re-verify → rename .tmp-<id> → <id>
   restore: verify → stage + migrate → recovery point → gate → carry audit → journal swap → reopen + verify → end sessions
                                                       (failure: original data moved back; crash: recovery.js at start)
<dataDir>-backups/<id>/ manifest.json · manifest.seal · db/agastya.db · projects/… · snapshots/…
```

| Path | Responsibility |
|---|---|
| `server/backup/format.js` | Ids, the paths a backup may hold, what a workspace walk leaves out, the manifest check and seal, the backup key, storing and extracting files (plain or AES-256-GCM). |
| `server/backup/service.js` | Create, list, verify, delete, retention, schedule, restore, status. |
| `server/backup/recovery.js` | Undoes a restore interrupted during the swap, before the database is opened. |
| `server/maintenance.js` | The gate: drains in-flight requests, then holds writes (backup) or everything (restore). |
| `server/routes/backups.js` | The API, admin only. |
| `scripts/backup.js` | `npm run backup`: list, verify, and with the server stopped, create and restore. |
| `client/src/pages/admin/BackupsPage.jsx` | The Backups screen. |

## CSDB package exchange (Phase 6)

```
Author / owner / admin ─ GET  /api/projects/:id/package.zip       content.read  → exportPackage: modules, publication.xml, images + agastya-package.json
Author (admin: override) ─ POST /api/projects/:id/package/preview  content.write → readPackage → planImport (+ XSD/BREX per module)  nothing written
                        ─ POST /api/projects/:id/package/import   content.write → readPackage → planImport → createModule (write path) / storeGraphic
```

| Path | Responsibility |
|---|---|
| `server/content/csdbPackage.js` | Reading an untrusted zip (names, links, limits, streamed inflation), the import plan, the export. |
| `server/content/graphics.js` | `placeFor`: where an image of a format is stored for an ICN (shared with the Graphics upload). |
| `client/src/pages/dms/PackageDialog.jsx` | Choose a zip, see the plan, import; Export package and Import package on the Data modules tab. |

## Workspaces, formats, settings, graphics and releases (Phases 6.5 to 10)

```
/api/workspaces, /api/workspaces/:wid/folders, /api/folders/:fid, /api/projects/:id/move     routes/workspaces.js   (arrange only, WS1)
/api/projects (format, workspaceId, folderId, members), /from-xml, /from-package              projectsApi.create     (WS2, WS3)
/api/projects/:id/convert {to:'jss'}, /conversion-report                                       content/convert.js     (s1000dtojss in a copy, FM4)
/api/projects/:id/settings, /settings/:group, /branding                                        content/settings.js    (ST1-ST7)
/api/projects/:id/assets, /graphics/:icn (PATCH, DELETE), /graphics.zip, /parts                content/assets.js      (GR1-GR6)
/api/projects/:id/dms/:dmId/file, /publication/file                                            DMC and PMC downloads
/api/projects/:id/dms/:dmId/preview/pages                                                      page text for the editor's PDF pane (SW3)
every build (runner.js) ─ releases.stateOf ─► pdf.js markingOptions ─► vendor/engine/watermark.js ─► FO background + release label
                        └► builds row: fingerprint, settings hash, released, release number, marking, PDF hash (migration 015)
output.pdf, preview.pdf ─ currentness() ─► 200, or 409 PDF_OUT_OF_DATE (RL4)
```

| Path | Responsibility |
|---|---|
| `server/formats/index.js` | The S1000D and JSS adapters: detection, capabilities, JSS checks (vocabulary read from the stylesheets), bookmeta identity, which conversions exist. |
| `server/content/convert.js` | S1000D to JSS through the reference's stage 1, with the report. |
| `server/content/settings.js` | The settings model: read, apply one group with checks, re-check a package's settings. |
| `server/content/assets.js` | ICN, symbol and parts catalogues and their problems; adding a part to an IPD module. |
| `server/content/releases.js` | The release state. |
| `client/src/pages/projects/ProjectsPage.jsx` | Workspace tree, folders, Move; `components/NewProjectDialog.jsx` the creation flow. |
| `client/src/pages/projects/SettingsTab.jsx`, `GraphicsTab.jsx` | Settings and conversion; ICNs, symbols, parts. |
| `client/src/components/SplitPane.jsx`, `DmEditor.jsx` `PdfPane` | The editor beside its PDF. |

## Client layout

| Path | Responsibility |
|---|---|
| `client/src/api.js` | Fetch wrapper (same-origin, credentials, JSON, `ApiError` with `status`/`code`). |
| `client/src/auth.jsx` | Session context from `/api/auth/me`; route guards that send gated accounts to `/onboarding` or `/change-password`. |
| `client/src/nav.js` | Role → navigation items (pure data, unit-tested). |
| `client/src/components/ui/` | Design system: buttons, fields, cards, badges, sortable table, dialogs (native `<dialog>`), toasts, empty/loading/error states, stat tiles, column chart. |
| `client/src/layout/` | App shell: sidebar, top bar, theme toggle, notifications, account menu. |
| `client/src/pages/` | Sign-in, forgot password, onboarding, forced change, three dashboards, Users list/detail, reset requests, project detail (data modules, graphics, publication builder and XML, PDF, approval), data module editor, Publications, approvals queue and review, placeholders. |
| `client/src/lib/useLive.js` | One shared WebSocket per project per page; build log and content events. |
| `client/src/editor/` | The structured view, the inspector, the document layer (`xmlDoc.js`) and the Monaco panel. |
| `client/src/schema/contentModel.js` | Content-model automata: what may go at a position, attributes, what a new element needs. |
| `client/src/lib/pmcTree.js` | Pure tree operations for the builder (ported from the Agastya original). |

## Tests

`npm test` runs the Node test runner over `test/`. `npm run test:e2e` builds the client and runs the browser scenarios in `e2e/` against a real server (Chromium installed in the project). `npm run test:everything` runs every suite, the doctor and the golden test. `npm run test:security` runs `security-regression.js`, which starts the real server on a random port with a throwaway data directory, checks the security properties end to end, and searches the captured log for leaked credentials.
