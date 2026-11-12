# Production setup and verification (Windows, NTFS)

For the person installing Agastya on the production Windows machine. Run the
checks in order and fill in the results sheet (section 6). **Do not run
section 4 against the live data folder**: it works on a copy, so production
data is never changed by the drill.

All commands are PowerShell, run from the Agastya folder (for example
`C:\Agastya`) as the Windows account the server runs under, unless a step
says otherwise.

**Marks used below**

- **[Windows]**: can only be checked on a real Windows machine (NTFS, the
  bundled Windows tools, antivirus, Windows services). Nobody has run it yet.
- **[Checked here]**: the same command and its result were checked on the
  Linux development machine on 29 October 2026 (Node 24.21.0 and 22.23.4).
  The messages quoted are the ones seen there. It still has to be repeated
  on Windows, but a different result there is a Windows problem, not a
  mistake in this document.

## 1. Before you start

- [Windows] Node.js 24 LTS: `node --version` shows `v24.x`. (Node 22 also
  passes every test, but 24 is the version to run.)
- [Windows] The bundled tools are real files, not links to system copies.
  Both commands must print nothing under `LinkType`:

  ```powershell
  Get-Item tools\jre\bin\java.exe, tools\libxslt-1.1.28-win32-x86\bin\xsltproc.exe |
    Select-Object FullName, Length, LinkType
  ```

  (On the Linux development machine these are links to system tools,
  decisions.md V12, so the bundled Windows tools have **never** been run.)
- [Windows] `npm ci` and `npm --prefix client ci`, then `npm run build:client`.
- Agastya ships no Windows service wrapper. If it runs as a service (NSSM,
  Task Scheduler or similar), use that tool's start and stop; otherwise it
  runs in a console window and stops with Ctrl+C. "Stop the server" below
  means either. A normal stop removes `server.pid` from the data folder.

## 2. Secure configuration

Edit `.env` (never commit it; it is ignored by Git):

```
AGASTYA_DATA_DIR=D:\Agastya\data
AGASTYA_BACKUP_DIR=E:\AgastyaBackups
AGASTYA_BACKUP_SCHEDULE=02:30
AGASTYA_BACKUP_KEEP=14
AGASTYA_BACKUP_KEY=<64 hexadecimal characters>
```

- **Backup folder on another disk** than the data (`E:` above). It must not be,
  contain or lie inside the data folder; Agastya refuses that, however either
  path is capitalised (decisions.md K14). [Checked here, including the
  Windows case rules]
- **The key**: make it once, keep it outside this machine and outside the
  backups (a password manager, or printed and sealed). Without it an
  encrypted backup cannot be restored. Changing it later means older backups
  need the old key.

  ```powershell
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

### 2.1 NTFS permissions [Windows]

NTFS ignores the `0700`/`0600` modes Agastya sets on Linux, so the folder
permissions are the only protection of the data, the backups and the key.
Give the data, the backups and `.env` to the service account, SYSTEM and
Administrators only. The SIDs (`*S-1-5-…`) are used instead of names because
the name "Administrators" is translated on non-English Windows.

```powershell
$acct = "$env:USERDOMAIN\$env:USERNAME"   # or the service account, e.g. "CORP\svc-agastya"
foreach ($d in 'D:\Agastya\data', 'E:\AgastyaBackups') {
  New-Item -ItemType Directory -Force $d | Out-Null
  icacls $d /inheritance:r /grant:r "${acct}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
}
icacls .env /inheritance:r /grant:r "${acct}:F" "*S-1-5-18:F" "*S-1-5-32-544:F"
```

The program folder holds the Java runtime and xsltproc that Agastya runs,
so other users must not be able to change it. Writing there is for
Administrators only; the service account only needs to read and run it:

```powershell
icacls C:\Agastya /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "${acct}:(OI)(CI)RX" "*S-1-5-32-545:(OI)(CI)RX"
```

Check:

1. `icacls D:\Agastya\data`, `icacls E:\AgastyaBackups` and `icacls .env`
   list only the service account, `NT AUTHORITY\SYSTEM` and
   `BUILTIN\Administrators`, with nothing marked `(I)` (inherited).
2. Signed in as an ordinary user (not an administrator):
   `Get-ChildItem D:\Agastya\data` and `Get-Content C:\Agastya\.env` both
   fail with "Access to the path … is denied", and
   `New-Item C:\Agastya\tools\x.txt` fails too.
3. As the service account, after the server has run: create a data module,
   build a preview, take a backup on the **Backups** screen. New files inherit
   the folder's permissions; check `icacls` on one new file under
   `D:\Agastya\data\projects`.
4. `npm run doctor` and `npm run golden` (section 3) still pass with the
   program folder read-only for the service account.

### 2.2 Antivirus and paths [Windows]

- Exclude `D:\Agastya\data` and `E:\AgastyaBackups` from real-time scanning
  if your policy allows. A scanner briefly holding a file makes a backup or
  restore retry for about three seconds (decisions.md K13); a hold that lasts
  makes it fail safely (`FILE_BUSY`, nothing replaced). The retry logic is
  covered by tests; whether it is enough for your scanner is only known on
  Windows.
- Long paths: keep the folders short (as above); Windows' 260-character limit
  applies to very deep workspace paths.

Restart the server after changing `.env`.

## 3. Toolchain and PDF output (bundled Windows tools)

```powershell
npm run doctor
npm run golden
```

Expected [Windows; the same commands are Checked here with system tools]:

- `All N checks passed. Everything the build needs is inside C:\Agastya.`
  (no "links to tools outside" note: that note means a system tool is being
  used instead of the bundled one)
- `Golden OK: 38 pages, text identical to the baseline.`

Record both lines in the release notes. If either fails, stop: PDFs built on
this machine have not been checked. The golden build is the **first** run of
the bundled 32-bit xsltproc (libxslt 1.1.28, libxml2 2.9.3) and the bundled
Java runtime; nothing else checks them.

Then, in the application [Windows; Checked here]:

- **Missing artwork**: open a data module with a figure whose ICN file has
  not been uploaded and press **Preview PDF**. The PDF builds; where the
  picture would be, a dashed box reads `Artwork not available: ICN-….png`,
  the figure title is still under it, and the build log says
  `Drew N "artwork not available" placeholder(s) for missing images`
  (decisions.md PV39). A symbol whose artwork is missing shows the same box
  inside its line of text.

**Decision needed before go-live** (decisions.md X1): the bundled xsltproc
uses libxml2 2.9.3, which has known published vulnerabilities. The risk was
accepted with mitigations for development; someone responsible for the
production machine must accept it again or replace the build.

## 4. Backup and restore drill, on a copy

Every command and message in this section was run on Linux, on throwaway
folders: [Checked here]. Running it on Windows is the actual test of NTFS
renames, read-only snapshot files, antivirus and permissions [Windows].

```powershell
# 4.1 A private folder for the drill, with the same permissions as the data:
#     robocopy below does not copy permissions, so files take the folder's.
New-Item -ItemType Directory -Force D:\AgastyaDrill | Out-Null
icacls D:\AgastyaDrill /inheritance:r /grant:r "${acct}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"

# 4.2 A copy of the data, taken while the server is stopped.
#     Stop the server (service, or Ctrl+C in its window).
robocopy D:\Agastya\data D:\AgastyaDrill\data /MIR
# After a forced stop the copy may carry production's server.pid; the backup
# command would then see the live server and refuse to work on the copy.
Remove-Item D:\AgastyaDrill\data\server.pid -ErrorAction SilentlyContinue
#     Start the server again: production runs on its own data.

# 4.3 The drill uses the copy only. Values set here win over the same names
#     in .env (checked on Node 22 and 24), so production's folders are not used.
$env:AGASTYA_DATA_DIR   = 'D:\AgastyaDrill\data'
$env:AGASTYA_BACKUP_DIR = 'D:\AgastyaDrill\backups'
# keep AGASTYA_BACKUP_KEY as in .env, so encryption is exercised

npm run backup -- create --note "Windows drill"
npm run backup -- list
npm run backup -- verify <id from the list>
```

Expected:

- `Created bk-…: N files, … MB, encrypted. Verified.`
- the list shows it as `manual  ok  …  encrypted  …  Windows drill`
- `bk-…: OK. Every file matches its checksum and the database passes its integrity check.`

If `create` says `The Agastya server is running on this data folder`, the
`server.pid` step was missed (or the variables were not set in this window).

```powershell
# 4.4 Restore onto the copy (no server is running on the copy).
npm run backup -- restore <id>                    # refused: asks for --confirm
npm run backup -- restore <id> --confirm <id>
npm run backup -- list
```

Expected: first `A restore replaces all data. Repeat the backup id after
--confirm to go ahead.`, then `Restored bk-…. Recovery point of the previous
data: bk-…. N session(s) ended; N audit record(s) carried over.`, and a
`pre-restore` line in the list. Then start a server on the copy:

```powershell
$env:PORT = '3636'
npm start
```

Sign in at `http://127.0.0.1:3636`, open a project, a data module and a
submitted request's PDF; open **Backups** and **System health** (the last
backup shows; no warning about damaged folders). Stop it, then:

```powershell
# 4.5 Clean up the drill, and check production was not touched.
Remove-Item -Recurse -Force D:\AgastyaDrill
Remove-Item Env:AGASTYA_DATA_DIR, Env:AGASTYA_BACKUP_DIR, Env:PORT
npm run backup -- list   # production's list: no "Windows drill" backup in it
```

Things specific to Windows that only the drill there checks: the read-only
snapshot files are moved, restored and removed; folders are renamed during
the swap while antivirus is active; the restored files get the drill
folder's permissions; the key works with the same `.env` as production.

## 5. After going live

- Look at **System health** the morning after the first scheduled backup.
- Copy `E:\AgastyaBackups` off the machine regularly (a backup on the same
  machine does not survive the machine).
- Repeat section 4 after every upgrade.

## 6. Results sheet

Fill in on the production machine; keep it with the release notes.

| # | Check | Where it was checked before | Windows result |
|---|---|---|---|
| 1 | Node 24, `npm ci`, client build | Linux, Node 24 and 22 | |
| 2 | Bundled `java.exe` and `xsltproc.exe` are real files (no `LinkType`) | **[Windows] only** | |
| 3 | `.env` set; backup folder on another disk; key stored off the machine | Folder rule checked here (case-insensitive) | |
| 4 | NTFS: data, backups, `.env` limited to the service account, SYSTEM, Administrators; program folder read-only for others (2.1, checks 1 to 4) | **[Windows] only** | |
| 5 | Antivirus exclusions, or the drill passes with scanning on | **[Windows] only** | |
| 6 | `npm run doctor`: all checks passed, no "links" note | Linux, with links to system tools | |
| 7 | `npm run golden`: 38 pages, identical | Linux, system tools only | |
| 8 | Preview with missing artwork shows the placeholder box | Linux | |
| 9 | libxml2 2.9.3 risk accepted or tool replaced (X1) | Decision, not a test | |
| 10 | Drill 4.1 to 4.3: create, list (note shown), verify | Linux | |
| 11 | Drill 4.4: restore refused without `--confirm`, then restored with a recovery point; server on the copy shows the data, Backups and System health | Linux (sign-in and health on a copy with no projects; projects and PDFs after a restore are covered by the automated tests) | |
| 12 | Drill 4.5: drill folder removed; production's backups unchanged | Linux | |
