'use strict';
/*
  How audit rows leave the server: the audit log viewer, its CSV export and
  the dashboard feed (decisions.md V9, V10). The audit table is append-only
  and keeps whatever earlier code wrote, so what is shown is decided here,
  by an explicit allow-list of metadata fields per action, never by trusting
  the sanitiser alone:

    - an action not listed shows no metadata at all;
    - decision comments are never in the audit log (only their length) and
      no listed field can carry one;
    - passwords, temporary passwords, tokens, hashes, fingerprints and
      session ids are never listed;
    - the name typed at a failed sign-in for an unknown account is not
      listed (older rows still hold it: it is dropped here, on display and
      on export alike);
    - an administrator override's written reason IS listed (V2).
*/

const OVERRIDE_FIELDS = ['overrideId'];
const CONTENT = (...f) => [...f, ...OVERRIDE_FIELDS];

const ALLOW = {
  'auth.login': ['temporary', 'displaced'],
  'auth.login.failed': ['reason'],
  'auth.logout': [],
  'auth.password.changed': ['forced', 'sessionsRevoked'],
  'auth.password.change_failed': [],
  'auth.onboarding.completed': ['sessionsRevoked'],
  'auth.session.revoked': [],
  'auth.sessions.revoked': ['username', 'count'],
  'user.bootstrap_admin_created': ['username'],
  'user.created': ['username', 'role', 'creatorRole', 'expiresAt'],
  'user.updated': ['username', 'fields'],
  'user.role.changed': ['username', 'from', 'to'],
  'user.disabled': ['username', 'sessionsRevoked'],
  'user.enabled': ['username'],
  'user.temp_password_issued': ['username', 'reason', 'lifecycle', 'sessionsRevoked', 'expiresAt'],
  'reset.requested': ['username'],
  'reset.requested.admin': [],
  'reset.approved': ['requestId', 'username', 'override'],
  'reset.rejected': ['requestId', 'override'],
  'project.created': ['projectName', 'ownerRole', 'format', 'workspaceName', 'source'],
  'project.archived': ['projectName'],
  'project.restored': ['projectName'],
  'workspace.created': ['name'],
  'workspace.renamed': ['from', 'to'],
  'workspace.deleted': ['name', 'projects'],
  'folder.created': ['name', 'workspaceName'],
  'folder.renamed': ['from', 'to', 'workspaceName'],
  'folder.moved': ['from', 'to', 'workspaceName'],
  'folder.deleted': ['name', 'workspaceName', 'projects', 'folders'],
  'project.moved': ['projectName', 'from', 'to'],
  'project.member.added': ['projectName', 'username', 'byAdmin', 'overrideId'],
  'project.member.removed': ['projectName', 'username', 'byAdmin', 'overrideId'],
  'dm.created': CONTENT('dmc', 'schemaType'),
  'dm.imported': CONTENT('dmc'),
  'dm.saved': CONTENT('dmc', 'revision', 'status'),
  'dm.renamed': CONTENT('from', 'to'),
  'dm.deleted': CONTENT('dmc'),
  'dm.restored': CONTENT('dmc'),
  'dmrl.imported': CONTENT('created', 'duplicates', 'skipped'),
  'graphic.uploaded': CONTENT('icn', 'format', 'size', 'file'),
  'project.converted': CONTENT('from', 'to', 'sourceProjectName', 'revision', 'lossy'),
  'graphic.updated': CONTENT('icn', 'fields'),
  'graphic.deleted': CONTENT('icn', 'file'),
  'graphics.exported': ['kind', 'graphics'],
  'settings.changed': CONTENT('group', 'fields', 'revision'),
  'branding.uploaded': CONTENT('file', 'format', 'size'),
  'publication.downloaded': ['buildId', 'released', 'releaseNumber', 'marking'],
  'package.exported': ['modules', 'graphics', 'bytes', 'missing'],
  'backup.bundle_exported': ['projects', 'failed', 'bytes'],
  'package.imported': CONTENT('modules', 'graphics', 'failed', 'skipped', 'refused', 'ignored'),
  'publication.built': ['ms'],
  'publication.saved': CONTENT('revision', 'entries', 'unresolved', 'via'),
  'publication.imported': CONTENT('revision', 'entries', 'unresolved'),
  'settings.wording_changed': CONTENT('fields'),
  'request.submitted': ['projectName', 'title', 'files', 'resubmission', 'modulesInReview', 'previousRequestId'],
  'request.decided': ['outcome', 'commentLength', 'projectName', 'title', 'managerName', 'modulesMoved', 'override', 'overrideId'],
  'request.withdrawn': ['projectName'],
  'request.stale': ['projectName', 'cause', 'via', 'overrideId'],
  'request.reassigned': ['projectName', 'title', 'fromName', 'toName', 'overrideId'],
  'admin.override': ['kind', 'action', 'reason', 'requestId', 'sessionId', 'projectName', 'title', 'target', 'outcome', 'commentLength', 'fromName', 'toName', 'username', 'added'],
  'override.session.started': ['key', 'reason', 'sessionId', 'projectName'],
  'audit.exported': ['filters', 'rows'],
  // Phase 5 (decisions.md K10): ids, kinds, counts and codes only; never a path or a key.
  'backup.created': ['kind', 'files', 'bytes', 'encrypted', 'projects', 'requests', 'skipped'],
  'backup.failed': ['kind', 'code'],
  'backup.verified': ['problems'],
  'backup.verify_failed': ['problems'],
  'backup.deleted': [],
  'backup.retention_deleted': [],
  'backup.restore_started': ['backupCreatedAt', 'reason'],
  'backup.restored': ['backupCreatedAt', 'recoveryPointId', 'carriedAuditRows', 'sessionsEnded', 'reason'],
  'backup.restore_failed': ['code', 'recoveryPointId'],
};

// Longest text kept per field; a reason may be up to 1000 characters.
const MAX = { reason: 1000 };

function cleanValue(key, v) {
  if (v == null) return undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.slice(0, MAX[key] || 200);
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' || typeof x === 'number').slice(0, 20).map((x) => (typeof x === 'string' ? x.slice(0, 80) : x));
  return undefined; // nested objects are never shown
}

function presentMeta(action, metaText) {
  const fields = ALLOW[action];
  if (!fields || !metaText) return {};
  let meta;
  try { meta = typeof metaText === 'string' ? JSON.parse(metaText) : metaText; } catch { return {}; }
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const k of fields) {
    const v = cleanValue(k, meta[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// One audit row as the viewer and the export show it.
function presentRow(a) {
  return {
    id: a.id,
    at: a.at,
    actor: a.actor_id ? { id: a.actor_id, username: a.actor_username || null, name: a.actor_name || null, role: a.actor_role || null } : null,
    ip: a.ip || null,
    action: a.action,
    targetType: a.target_type || null,
    targetId: a.target_id || null,
    project: a.project_id ? { id: a.project_id, name: a.project_name || null } : null,
    details: presentMeta(a.action, a.meta),
  };
}

/*
  CSV, RFC 4180: every field quoted, quotes doubled. A field that a
  spreadsheet would run as a formula (= + - @, tab, carriage return) is
  prefixed with an apostrophe.
*/
function csvField(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const CSV_HEADER = ['id', 'at', 'actor_username', 'actor_name', 'actor_role', 'ip', 'action', 'target_type', 'target_id', 'project_id', 'project_name', 'details'];
function csvLine(row) {
  const p = presentRow(row);
  const details = Object.entries(p.details).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join('; ');
  return [p.id, p.at, p.actor && p.actor.username, p.actor && p.actor.name, p.actor && p.actor.role, p.ip, p.action, p.targetType, p.targetId,
    p.project && p.project.id, p.project && p.project.name, details].map(csvField).join(',');
}

module.exports = { ALLOW, presentMeta, presentRow, csvField, csvLine, CSV_HEADER };
