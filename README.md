# Agastya

S1000D publication authoring and publishing platform. **Phase 1**: authentication, authorization, user management and role dashboards. **Phase 2, checkpoints 2a to 2c**: project workspaces, data modules, validation (XSD and BREX), graphics, DMRL spreadsheets, PDF output, the publication builder, live build progress, autosaved drafts, approval submission with the content lock, the Author dashboard, and the structured schema-aware editor with the Monaco XML panel. **Phase 3**: the Project Manager dashboard: the approvals queue, review of the frozen submission, decisions with comments, the data module status flow, the rework loop, team activity and Author account management (docs\decisions.md, G1 to G10, B1 to B15, L1 to L4, E1 to E8, M1 to M10). **Phase 4**: the Software Administrator dashboard: organisation-wide oversight and workload, the session list, the audit log viewer with filters and CSV export, system health, and administrator overrides, each with a written reason, audited and notified (V1 to V13). **Checkpoint 2d**: the page-view editor: Design, Tags, Split and XML views of a data module, with formats, schema-aware insertion, references, figures, tables, lists, an outline and validation feedback on the page, and saving that changes only what was edited (PV1 to PV10). **Phase 5**: backup and restore: verified, optionally encrypted backups of the database, the project workspaces and the frozen submissions, taken by hand or on a daily schedule, with retention, and a guarded restore with a recovery point (K1 to K12). **Phase 6**: CSDB package exchange: a project exported as one zip, and a zip of data modules and graphics imported in bulk after a check that writes nothing and replaces nothing (CX1 to CX6). **Phases 6.5 to 10**: workspaces with nested folders and project moves, new projects from an XML file or a package; S1000D and JSS projects with S1000D to JSS conversion; the project dashboard, publication settings (identity, publishers, page size and margins, watermark), ICNs, symbols and parts; the editor beside its PDF; release marking (NOT RELEASED until approved, Release N after) enforced on every PDF download (WS, FM, ST, GR, SW and RL decisions).

These steps are for Windows with **PowerShell**. Run every command from the project folder:

```powershell
cd "C:\Users\Deepraj Mhatre\Documents\agastya"
```

## 1. Prerequisites

- **Node.js 24 LTS** (recommended). Node 22.13 or later also works, but prints `ExperimentalWarning: SQLite is an experimental feature`. That warning is harmless.
- Check your version:

```powershell
node --version
```

## 2. Install

```powershell
npm install
npm --prefix client install
```

## 3. Build the client

```powershell
npm run build:client
```

This creates `client\dist`, which the server serves. Rebuild after any change under `client\src`.

## 4. Set the first administrator

The first start creates the single **Software Administrator** from two environment variables. The password must be 8 to 128 characters and not a common password. You will have to change it at first sign-in.

**Option A: environment variables for this PowerShell window only**

```powershell
$env:AGASTYA_INITIAL_ADMIN_USERNAME = "admin"
$env:AGASTYA_INITIAL_ADMIN_PASSWORD = "Bootstrap-Temp-91"
```

**Option B: a `.env` file** (read automatically by `npm start` and `npm run dev`)

```powershell
Copy-Item .env.example .env
notepad .env
```

In `.env`, set:

```
AGASTYA_INITIAL_ADMIN_USERNAME=admin
AGASTYA_INITIAL_ADMIN_PASSWORD=Bootstrap-Temp-91
```

These values are used only while no administrator exists. Once the administrator has been created they are ignored, so you can remove them afterwards.

Optional variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3535` | Port to listen on |
| `AGASTYA_DATA_DIR` | `.\data` | Folder holding `agastya.db` |

## 5. Start the server

```powershell
npm start
```

You should see:

```
[bootstrap] Created Software Administrator "admin" (password change required at first sign-in).
[agastya] listening on http://127.0.0.1:3535
```

Open **http://127.0.0.1:3535**

Stop the server with `Ctrl+C`.

## 6. First sign-in

1. Sign in as `admin` with the bootstrap password you chose.
2. Choose a new password when asked.
3. Go to **Users** and select **Create user** to make a Project Manager and an Author. Each new account gets a temporary password in the form `username@year` (for example `ravi@2026`). It is shown **once**, is valid for **24 hours** and works for **one sign-in**.
4. Sign out, then sign in as the new user with the temporary password. You will be asked to confirm your name and set a password.

Tip: each account allows only one active session, so a new sign-in for the same account signs out the old one. To be signed in as several roles at once, use separate browsers or a private window for each role.

## 7. Development mode (optional)

Development mode reloads automatically when you change code. Use two PowerShell windows. Set the environment variables (step 4) in the first window, or use `.env`.

Window 1, the API server, which restarts when server files change:

```powershell
npm run dev
```

Window 2, the client with hot reload:

```powershell
npm run dev:client
```

Open **http://localhost:5173**. The client forwards `/api` requests to the server on port 3535.

## 8. Reset the administrator password

Nobody can approve the Software Administrator's own forgot-password request. If the administrator password is lost:

1. Stop the server (`Ctrl+C`).
2. Run:

   ```powershell
   npm run reset-admin
   ```

   It prints a temporary password, for example:

   ```
   Temporary password for "admin": admin@2026
   Valid until 2026-10-21T13:44:41.043Z for one sign-in; a new password must be chosen immediately.
   ```

3. Start the server again (`npm start`), sign in with that temporary password and choose a new one.

If you set `AGASTYA_DATA_DIR`, set the same value in the window where you run `npm run reset-admin`.

Other users reset their passwords with **Forgot your password?** on the sign-in page. The request goes to the Project Manager who created them (or to the administrator), who approves it from **Users → Reset requests**.

## 9. Start again from scratch

Stop the server, then delete the data folder. The next start bootstraps a new administrator from the environment variables.

```powershell
Remove-Item -Recurse -Force .\data
```

## 10. Automated tests and checks

```powershell
npm test                  # unit, route, guard-coverage, content and golden tests
npm run test:security     # starts the real server and runs the end-to-end security checks
npm run doctor            # checks that Java, xsltproc, FOP, schemas and pipelines are inside the project
npm run golden            # builds samples\golden to PDF and compares it with the stored baseline
npm run test:e2e          # builds the client and clicks through the real UI in Chromium (no screenshots are taken)
npm run test:everything   # all of the above, in order
# Optional: real data modules through the UI (a folder of .xml files; only read, never copied into the repository)
# AGASTYA_REAL_MODULES=D:\modules npx playwright test e2e/15-real-modules.spec.js
npm run content-models    # rebuild the editor's S1000D content models from vendor\schemas (only after a schema change)
```

The browser tests use a Chromium installed inside the project. On a fresh copy, install it once with:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "0"; npx playwright install chromium
```

## 11. PDF toolchain

Everything the PDF build needs ships inside the project folder: a Java runtime (`tools\jre`), xsltproc (`tools\libxslt-1.1.28-win32-x86`), Apache FOP (`tools\fop-2.10`), the XSLT pipelines, S1000D schemas and house templates (`vendor\`). Nothing needs to be installed. See `vendor\PROVENANCE.md` for where each part came from. The first PDF build after a restart is slower while FOP warms up.

The bundled Java and xsltproc are Windows builds. On Linux, `npm run doctor` and **System health** report when `tools\jre\bin\java` or the xsltproc path is a link to a system tool instead; PDFs built that way have not been checked against the golden baseline with the bundled tools (decisions.md V12).

## 12. Backups and restore

A backup is one folder holding the database, every project workspace (without build outputs) and the frozen submissions, with a manifest that lists every file and its SHA-256. It is verified before it is listed. Build outputs (`output.pdf`, previews) are not included; build the PDF again after a restore.

**Where.** `<data folder>-backups`, so `data-backups\` beside `data\` by default. Use another disk if you can: set `AGASTYA_BACKUP_DIR` (it must not be inside the data folder). Copy the backup folders to offline storage regularly; a backup on the same disk does not survive the disk.

**Settings** (`.env`, then restart):

| Variable | Default | Meaning |
|---|---|---|
| `AGASTYA_BACKUP_DIR` | `<data folder>-backups` | Where backups are kept |
| `AGASTYA_BACKUP_SCHEDULE` | off | A time of day, `HH:MM` 24-hour server time, for one backup a day (taken at the next minute check if the server was down) |
| `AGASTYA_BACKUP_KEEP` | `14` | How many scheduled backups to keep; the newest 3 recovery points are kept too; manual backups stay until deleted |
| `AGASTYA_BACKUP_KEY` | none (not encrypted) | 32 random bytes as 64 hex characters: backups are then encrypted (AES-256-GCM). Keep the key outside Agastya and outside the backups: **without it a backup cannot be restored** |

Make a key with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**In the app** (Software Administrator): **Backups** to take one now, verify one, delete one or restore one; **System health** shows the last backup and any warning.

**Restoring** asks for the backup id typed again, your password and a reason. It verifies the backup, takes and verifies a **recovery point** of the current data, pauses the application while the data is swapped, checks the result (and puts the old data back if anything does not match), and **signs everyone out**. Audit records written since the backup are kept. To undo a restore, restore its recovery point.

**From the command line** (on the server machine):

```powershell
npm run backup -- list
npm run backup -- verify <backup id>
npm run backup -- create --note "before the upgrade"           # server stopped
npm run backup -- restore <backup id> --confirm <backup id>     # server stopped
```

`list` and `verify` work at any time; `create` and `restore` refuse while the server is running (use the Backups page instead).

## 13. CSDB packages (export and bulk import)

On a project's **Data modules** tab:

- **Export package** downloads `CSDB-<project>.zip`: every data module, the publication module and the graphics, at their project paths, with `agastya-package.json` listing each file and its SHA-256. Anyone who can see the project can export it.
- **Import package** (Authors of the project; the administrator inside an override session) takes a `.zip` of data modules and graphics, up to 200 MB. Every file is checked first and the dialog shows what will happen to each one; nothing is written until you press **Import**. Modules are stored under their own code, graphics where the PDF build looks for them. A code or graphic already in the project is skipped, never replaced. Modules with validation errors are imported as they are.

## 14. Workspaces, formats, settings and releases

- **Projects page**: a tree of workspaces and folders. *New workspace*, then *New folder*, *Rename*, *Move folder* and *Delete* on the one selected. *Move* on a project files it elsewhere; nothing in it changes. Deleting a folder moves what is in it up a level.
- **New project**: start empty, from one XML file (a data module, publication module or JSS book) or from a package; choose S1000D or JSS; choose the workspace and folder and the Authors who get access.
- **Settings tab**: Identity, Publishers (with logo upload), Page and type (page size and margins), Pipeline, Watermark, and *Convert to a JSS book* for an S1000D project (a new project; this one is not changed).
- **Graphics tab**: ICNs, Symbols and Parts, each with what is wrong with it; *Add part* writes a catalogue entry into an illustrated parts data module.
- **Editor**: *Editor*, *Beside* and *PDF* layouts; the PDF beside the editor is rebuilt after each save, or with *Refresh*.
- **Release**: until a publication is approved, and again after any change to it, every PDF is stamped **NOT RELEASED**. After approval, build again for the released PDF (with "Release N"). A PDF that no longer matches its content, settings or release state cannot be viewed or downloaded; build it again.
- **JSG** is not available: it is not defined in the reference material.

## 15. The Author Panel

- **Overview**: *Dashboard* (recently opened projects, approval requests, drafts; *View Projects* opens the Projects page), *Workspace* (every workspace, searchable; *Open* selects it on the Projects page) and *Projects* (the two-panel workspace/folder tree and project table; drag a project or folder onto a tree node to move it, or use *Move*).
- **Authoring → Graphics**: a thumbnail grid of ICNs and symbols across every project you can see, searchable; *Upload graphic* asks which project first, then uploads there as usual.
- **Other → Backup**: download a content backup (data modules or the book, graphics, publication and settings) of one project, or every project you can see as one zip, saved by your browser's own download. It does not include revision history, members or audit records; those are in the administrator's system backups.
- **Opening a project** goes straight to a focused editor: the book beside its PDF, or the most recently edited data module. Overview, the full module list, Graphics, Publication and Settings stay one click away through the **Project** menu beside it.

## Roles

| Role | Creates | Can also |
|---|---|---|
| Software Administrator (one only) | Project Managers, Authors | See everything (oversight, workload, audit log, system health); take, verify, delete and restore backups; disable/enable accounts; reset any password; switch users between Project Manager and Author; end sessions. As **overrides with a written reason** (recorded, shown to the people involved and notified): decide, reset or reassign any approval request; edit content in any project (one reason per editing session); add or remove Authors on any project. Cannot submit publications |
| Project Manager | Authors | Create and own projects; assign Authors to projects they own; reset passwords of, decide reset requests of, and disable or enable the Authors they created; review and decide the approval requests sent to them (approve, reject or request changes, always with a comment) |
| Author | nobody | Create and own projects; add existing Authors to projects they own; see only projects they own or are assigned to; submit the publication to a Project Manager and resubmit after changes |

Every project has one owner: the Project Manager or Author who created it.

## Documentation

- `docs\architecture.md`: components, authorization model, data model
- `docs\decisions.md`: decisions, the temporary-password risk note, open questions
- `docs\editor-parity.md`: what the editor does compared with the original Agastya editor, and what it does not yet
- `docs\roadmap.md`: what is done, what remains, what is blocked, and in which order
- `docs\production.md`: installing on the production Windows machine: secure settings, folder permissions, golden build, a backup and restore drill
