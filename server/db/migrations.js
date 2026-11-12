'use strict';
// Ordered, additive, named migrations. Each is applied once, inside a
// transaction, and recorded in schema_migrations. Never edit or reorder an
// applied migration: add a new one.

const MIGRATIONS = [
  {
    name: '001-users-sessions-audit',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id                       TEXT PRIMARY KEY,
        username                 TEXT NOT NULL COLLATE NOCASE UNIQUE,
        full_name                TEXT NOT NULL,
        role                     TEXT NOT NULL CHECK (role IN ('software_admin','project_manager','author')),
        password_hash            TEXT NOT NULL,
        must_change_password     INTEGER NOT NULL DEFAULT 0,
        onboarding_pending       INTEGER NOT NULL DEFAULT 0,
        temp_password_expires_at TEXT,
        temp_password_used_at    TEXT,
        disabled_at              TEXT,
        last_login_at            TEXT,
        created_by               TEXT REFERENCES users(id),
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );
      -- Exactly one Software Administrator, enforced by the database itself.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_single_admin ON users(role) WHERE role = 'software_admin';
      CREATE INDEX IF NOT EXISTS ix_users_created_by ON users(created_by);

      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id),
        token_hash    TEXT NOT NULL UNIQUE,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        last_seen_at  TEXT,
        revoked_at    TEXT,
        revoke_reason TEXT,
        ip            TEXT,
        user_agent    TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS audit_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        at             TEXT NOT NULL,
        actor_id       TEXT,
        actor_username TEXT,
        ip             TEXT,
        action         TEXT NOT NULL,
        target_type    TEXT,
        target_id      TEXT,
        project_id     TEXT,
        meta           TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log(at);
      CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_log(action);
      -- Append-only: rows can be added, never changed or removed.
      CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    `,
  },
  {
    name: '002-password-reset-requests',
    sql: `
      CREATE TABLE IF NOT EXISTS password_reset_requests (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id),
        approver_id  TEXT REFERENCES users(id),
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        requested_at TEXT NOT NULL,
        requested_ip TEXT,
        decided_by   TEXT REFERENCES users(id),
        decided_at   TEXT
      );
      -- One pending request per account.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_reset_pending ON password_reset_requests(user_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS ix_reset_approver ON password_reset_requests(approver_id, status);
    `,
  },
  {
    name: '003-projects-members',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        manager_id  TEXT NOT NULL REFERENCES users(id),
        created_by  TEXT NOT NULL REFERENCES users(id),
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_projects_manager ON projects(manager_id);

      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL REFERENCES projects(id),
        user_id    TEXT NOT NULL REFERENCES users(id),
        role       TEXT NOT NULL DEFAULT 'author' CHECK (role IN ('author')),
        added_by   TEXT NOT NULL REFERENCES users(id),
        added_at   TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS ix_members_user ON project_members(user_id);
    `,
  },
  {
    name: '004-notifications',
    sql: `
      CREATE TABLE IF NOT EXISTS notifications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL REFERENCES users(id),
        kind       TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT,
        link       TEXT,
        ref_type   TEXT,
        ref_id     TEXT,
        audit_id   INTEGER,
        created_at TEXT NOT NULL,
        read_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(user_id, read_at);
    `,
  },
  {
    /*
      A project has exactly one owner, an Author or a Project Manager
      (decisions.md R9). Additive: owner_id is added and backfilled from
      manager_id. manager_id stays only because SQLite cannot drop its NOT
      NULL without rebuilding the table; new rows mirror owner_id into it and
      no code reads it.
    */
    name: '005-project-ownership',
    sql: `
      ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id);
      UPDATE projects SET owner_id = manager_id WHERE owner_id IS NULL;
      CREATE INDEX IF NOT EXISTS ix_projects_owner ON projects(owner_id);
      CREATE TRIGGER IF NOT EXISTS projects_owner_required BEFORE INSERT ON projects
        WHEN NEW.owner_id IS NULL BEGIN SELECT RAISE(ABORT, 'projects.owner_id is required'); END;
      CREATE TRIGGER IF NOT EXISTS projects_owner_not_null BEFORE UPDATE OF owner_id ON projects
        WHEN NEW.owner_id IS NULL BEGIN SELECT RAISE(ABORT, 'projects.owner_id is required'); END;
    `,
  },
  {
    /*
      Content identity and immutable history. A document is one source file
      in a project workspace; its path is data, so a rename keeps its
      history. Revisions point at content-addressed blobs (SHA-256), and
      both tables refuse UPDATE and DELETE.
    */
    name: '006-documents-revisions',
    sql: `
      CREATE TABLE IF NOT EXISTS documents (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        rel_path   TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('dm','pm','other')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_documents_live_path ON documents(project_id, rel_path) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS blobs (
        hash       TEXT PRIMARY KEY,
        content    BLOB NOT NULL,
        size       INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS blobs_no_update BEFORE UPDATE ON blobs
        BEGIN SELECT RAISE(ABORT, 'blobs are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS blobs_no_delete BEFORE DELETE ON blobs
        BEGIN SELECT RAISE(ABORT, 'blobs are immutable'); END;

      CREATE TABLE IF NOT EXISTS revisions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL REFERENCES documents(id),
        hash        TEXT NOT NULL REFERENCES blobs(hash),
        rel_path    TEXT NOT NULL,
        reason      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        created_by  TEXT REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS ix_revisions_document ON revisions(document_id, id);
      CREATE TRIGGER IF NOT EXISTS revisions_no_update BEFORE UPDATE ON revisions
        BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON revisions
        BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
    `,
  },
  {
    // Data module records: metadata for the DM manager; the XML lives on disk.
    name: '007-data-modules',
    sql: `
      CREATE TABLE IF NOT EXISTS data_modules (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id),
        document_id  TEXT NOT NULL UNIQUE REFERENCES documents(id),
        dmc          TEXT NOT NULL,
        schema_type  TEXT NOT NULL,
        issue        TEXT,
        tech_name    TEXT NOT NULL DEFAULT '',
        info_name    TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved')),
        created_by   TEXT REFERENCES users(id),
        created_at   TEXT NOT NULL,
        updated_by   TEXT REFERENCES users(id),
        updated_at   TEXT NOT NULL,
        deleted_at   TEXT,
        deleted_by   TEXT REFERENCES users(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_dm_live_code ON data_modules(project_id, dmc) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS ix_dm_project ON data_modules(project_id);
    `,
  },
  {
    // The graphics (ICN) registry. The file itself lives in the workspace.
    name: '008-graphics',
    sql: `
      CREATE TABLE IF NOT EXISTS graphics (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id),
        icn         TEXT NOT NULL,
        rel_path    TEXT NOT NULL,
        format      TEXT NOT NULL CHECK (format IN ('png','jpeg','gif')),
        size        INTEGER NOT NULL,
        sha256      TEXT NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        uploaded_by TEXT REFERENCES users(id),
        uploaded_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_graphics_icn ON graphics(project_id, icn);
    `,
  },
  {
    /*
      Publication approval requests (PROMPT.md "Approval workflow"). The
      snapshot taken at submission lives under <dataDir>/snapshots/<id>/; its
      fingerprint and location never change once written. One pending request
      per publication.
    */
    name: '009-publication-requests',
    sql: `
      CREATE TABLE IF NOT EXISTS publication_requests (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT NOT NULL REFERENCES projects(id),
        publication_ref     TEXT NOT NULL,
        publication_title   TEXT NOT NULL DEFAULT '',
        submitted_by        TEXT NOT NULL REFERENCES users(id),
        assigned_manager_id TEXT NOT NULL REFERENCES users(id),
        status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected','changes_requested','withdrawn','stale')),
        note                TEXT NOT NULL DEFAULT '',
        content_fingerprint TEXT NOT NULL,
        snapshot_dir        TEXT NOT NULL,
        validation_errors   INTEGER NOT NULL DEFAULT 0,
        validation_warnings INTEGER NOT NULL DEFAULT 0,
        pdf_sha256          TEXT,
        submitted_at        TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        stale_reason        TEXT,
        decided_by          TEXT REFERENCES users(id),
        decided_at          TEXT,
        decision_comment    TEXT,
        override_by         TEXT REFERENCES users(id),
        override_reason     TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_requests_one_open ON publication_requests(project_id, publication_ref) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS ix_requests_submitter ON publication_requests(submitted_by);
      CREATE INDEX IF NOT EXISTS ix_requests_manager ON publication_requests(assigned_manager_id, status);
      CREATE TRIGGER IF NOT EXISTS requests_snapshot_frozen BEFORE UPDATE OF content_fingerprint, snapshot_dir, pdf_sha256, project_id, submitted_by, submitted_at ON publication_requests
        BEGIN SELECT RAISE(ABORT, 'the submitted snapshot is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS requests_no_delete BEFORE DELETE ON publication_requests
        BEGIN SELECT RAISE(ABORT, 'requests are kept'); END;
    `,
  },
  {
    // Autosaved drafts: one per user per source, private to that user, never built.
    name: '010-drafts',
    sql: `
      CREATE TABLE IF NOT EXISTS drafts (
        user_id       TEXT NOT NULL REFERENCES users(id),
        project_id    TEXT NOT NULL REFERENCES projects(id),
        doc_key       TEXT NOT NULL,
        base_revision INTEGER,
        content       TEXT NOT NULL,
        size          INTEGER NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (user_id, project_id, doc_key)
      );
    `,
  },
  {
    // The last builds and validations per project, for dashboards.
    name: '011-build-and-validation-history',
    sql: `
      CREATE TABLE IF NOT EXISTS builds (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind       TEXT NOT NULL CHECK (kind IN ('full','preview','snapshot')),
        target     TEXT,
        user_id    TEXT REFERENCES users(id),
        ok         INTEGER NOT NULL,
        ms         INTEGER,
        error_code TEXT,
        at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_builds_project ON builds(project_id, id);
      CREATE TABLE IF NOT EXISTS validation_runs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        user_id    TEXT REFERENCES users(id),
        errors     INTEGER NOT NULL,
        warnings   INTEGER NOT NULL,
        modules    INTEGER NOT NULL,
        at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_validation_project ON validation_runs(project_id, id);
    `,
  },
  {
    /*
      Phase 3: the data modules each request froze (for the status flow,
      decisions.md M3), and the request a resubmission follows (M5).
    */
    name: '012-request-modules-and-history',
    sql: `
      CREATE TABLE IF NOT EXISTS request_modules (
        request_id     TEXT NOT NULL REFERENCES publication_requests(id),
        data_module_id TEXT NOT NULL REFERENCES data_modules(id),
        rel_path       TEXT NOT NULL,
        PRIMARY KEY (request_id, data_module_id)
      );
      CREATE INDEX IF NOT EXISTS ix_request_modules_dm ON request_modules(data_module_id);
      ALTER TABLE publication_requests ADD COLUMN previous_request_id TEXT REFERENCES publication_requests(id);
    `,
  },
  {
    /*
      Phase 4: the Software Administrator's overrides (decisions.md V1-V12).
      admin_overrides is the permanent record of each one, with its written
      reason; like the audit log it is append-only. override_sessions are
      the administrator's content-editing sessions: one reason per session,
      ended after 30 minutes idle or when the administrator leaves.
    */
    name: '013-admin-overrides',
    sql: `
      CREATE TABLE IF NOT EXISTS admin_overrides (
        id          TEXT PRIMARY KEY,
        at          TEXT NOT NULL,
        admin_id    TEXT NOT NULL REFERENCES users(id),
        kind        TEXT NOT NULL CHECK (kind IN ('decision','reset','reassign','content','members')),
        action      TEXT NOT NULL,
        project_id  TEXT REFERENCES projects(id),
        request_id  TEXT REFERENCES publication_requests(id),
        target_type TEXT,
        target_id   TEXT,
        session_id  TEXT,
        reason      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_overrides_project ON admin_overrides(project_id, at);
      CREATE INDEX IF NOT EXISTS ix_overrides_request ON admin_overrides(request_id);
      CREATE TRIGGER IF NOT EXISTS admin_overrides_no_update BEFORE UPDATE ON admin_overrides
        BEGIN SELECT RAISE(ABORT, 'admin_overrides is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS admin_overrides_no_delete BEFORE DELETE ON admin_overrides
        BEGIN SELECT RAISE(ABORT, 'admin_overrides is append-only'); END;

      CREATE TABLE IF NOT EXISTS override_sessions (
        id              TEXT PRIMARY KEY,
        admin_id        TEXT NOT NULL REFERENCES users(id),
        auth_session_id TEXT NOT NULL REFERENCES sessions(id),
        project_id      TEXT NOT NULL REFERENCES projects(id),
        doc_key         TEXT NOT NULL,
        reason          TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        last_used_at    TEXT NOT NULL,
        saves           INTEGER NOT NULL DEFAULT 0,
        ended_at        TEXT,
        end_reason      TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_override_sessions_open ON override_sessions(admin_id, ended_at);
      -- The reason a session was opened with never changes.
      CREATE TRIGGER IF NOT EXISTS override_sessions_reason_fixed BEFORE UPDATE OF reason, project_id, doc_key, admin_id ON override_sessions
        BEGIN SELECT RAISE(ABORT, 'an override session keeps its reason and scope'); END;
    `,
  },
  {
    /*
      Phase 6.5: workspaces and folders (decisions.md WS1-WS6). They only
      arrange projects: ownership, membership and every permission stay on
      the project, so moving a project changes two columns and nothing else.
      Phase 7: the document format of a project (FM1).
    */
    name: '014-workspaces-and-formats',
    sql: `
      CREATE TABLE IF NOT EXISTS workspaces (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        owner_id    TEXT NOT NULL REFERENCES users(id),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_workspaces_name ON workspaces(name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS folders (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        parent_id    TEXT REFERENCES folders(id),
        name         TEXT NOT NULL,
        created_by   TEXT NOT NULL REFERENCES users(id),
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_folders_workspace ON folders(workspace_id, parent_id);
      ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
      ALTER TABLE projects ADD COLUMN folder_id TEXT REFERENCES folders(id);
      ALTER TABLE projects ADD COLUMN format TEXT NOT NULL DEFAULT 's1000d' CHECK (format IN ('s1000d','jss'));
    `,
  },
  {
    /*
      Phase 10: what each build was made from (decisions.md RL1-RL6): the
      publication fingerprint, the settings hash, the release it carried and
      the PDF's own hash, so a download can be checked against the content
      and release state of now.
    */
    name: '015-build-provenance',
    sql: `
      ALTER TABLE builds ADD COLUMN fingerprint TEXT;
      ALTER TABLE builds ADD COLUMN settings_hash TEXT;
      ALTER TABLE builds ADD COLUMN released INTEGER;
      ALTER TABLE builds ADD COLUMN release_number INTEGER;
      ALTER TABLE builds ADD COLUMN marking TEXT;
      ALTER TABLE builds ADD COLUMN pdf_sha256 TEXT;
    `,
  },
  {
    /*
      The Author Panel redesign: which project each user last opened, so a
      "Recently opened" list can be shown without reading the audit log
      (which is never a source of UI state). One row per (user, project);
      opening it again just moves the timestamp on.
    */
    name: '016-project-opens',
    sql: `
      CREATE TABLE IF NOT EXISTS project_opens (
        user_id    TEXT NOT NULL REFERENCES users(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        opened_at  TEXT NOT NULL,
        PRIMARY KEY (user_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS ix_project_opens_user ON project_opens(user_id, opened_at);
    `,
  },
  {
    /*
      "Delete project" (decisions.md UI7) archives rather than erases, so an
      archived project's name must stop blocking a new project from taking
      it. The old `UNIQUE` was declared on the column itself (003), which
      SQLite cannot drop or narrow in place; the table is rebuilt without it
      and a partial unique index takes its place, enforcing uniqueness only
      among `status = 'active'` rows. `foreignKeysOff` (below) is needed only
      for this rebuild: other tables hold live `project_id` foreign keys, and
      SQLite checks those as soon as `projects` is dropped, even mid-rebuild.
    */
    name: '017-project-name-unique-while-active',
    foreignKeysOff: true,
    sql: `
      CREATE TABLE projects_new (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL COLLATE NOCASE,
        description  TEXT NOT NULL DEFAULT '',
        manager_id   TEXT NOT NULL REFERENCES users(id),
        created_by   TEXT NOT NULL REFERENCES users(id),
        status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        owner_id     TEXT REFERENCES users(id),
        workspace_id TEXT REFERENCES workspaces(id),
        folder_id    TEXT REFERENCES folders(id),
        format       TEXT NOT NULL DEFAULT 's1000d' CHECK (format IN ('s1000d','jss'))
      );
      INSERT INTO projects_new (id, name, description, manager_id, created_by, status, created_at, updated_at, owner_id, workspace_id, folder_id, format)
        SELECT id, name, description, manager_id, created_by, status, created_at, updated_at, owner_id, workspace_id, folder_id, format FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;

      CREATE INDEX IF NOT EXISTS ix_projects_manager ON projects(manager_id);
      CREATE INDEX IF NOT EXISTS ix_projects_owner ON projects(owner_id);
      CREATE TRIGGER IF NOT EXISTS projects_owner_required BEFORE INSERT ON projects
        WHEN NEW.owner_id IS NULL BEGIN SELECT RAISE(ABORT, 'projects.owner_id is required'); END;
      CREATE TRIGGER IF NOT EXISTS projects_owner_not_null BEFORE UPDATE OF owner_id ON projects
        WHEN NEW.owner_id IS NULL BEGIN SELECT RAISE(ABORT, 'projects.owner_id is required'); END;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_live_name ON projects(name COLLATE NOCASE) WHERE status = 'active';
    `,
  },
];

module.exports = { MIGRATIONS };
