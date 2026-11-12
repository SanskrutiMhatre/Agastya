// Display formatting shared by every screen.

const dtf = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
const dttf = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export const fmtDate = (iso) => (iso ? dtf.format(new Date(iso)) : '—');
export const fmtDateTime = (iso) => (iso ? dttf.format(new Date(iso)) : '—');

export function fmtRelative(iso) {
  if (!iso) return 'never';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(iso);
}

export const fmtNumber = (n) => (n == null ? '—' : new Intl.NumberFormat(undefined, { notation: n >= 10000 ? 'compact' : 'standard' }).format(n));

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// Audit actions in plain language for the activity feed.
const ACTIONS = {
  'auth.login': () => 'signed in',
  'auth.login.failed': (m) => (m && m.reason === 'unknown-user' ? 'failed sign-in for an unknown username' : 'failed sign-in'),
  'auth.logout': () => 'signed out',
  'auth.password.changed': () => 'changed their password',
  'auth.password.change_failed': () => 'failed a password change',
  'auth.onboarding.completed': () => 'completed first sign-in setup',
  'auth.session.revoked': () => 'revoked a session',
  'auth.sessions.revoked': (m) => `signed ${m && m.username} out everywhere`,
  'user.bootstrap_admin_created': () => 'Software Administrator created by bootstrap',
  'user.created': (m) => `created ${m && m.role === 'project_manager' ? 'Project Manager' : 'Author'} ${m && m.username}`,
  'user.updated': (m) => `renamed ${m && m.username}`,
  'user.role.changed': (m) => `changed ${m && m.username} to ${m && m.to === 'project_manager' ? 'Project Manager' : 'Author'}`,
  'user.disabled': (m) => `disabled ${m && m.username}`,
  'user.enabled': (m) => `enabled ${m && m.username}`,
  'user.temp_password_issued': (m) => `issued a temporary password to ${m && m.username}`,
  'reset.requested': () => 'requested a password reset',
  'reset.requested.admin': () => 'requested an administrator password reset',
  'reset.approved': (m) => `approved a password reset for ${m && m.username}`,
  'reset.rejected': () => 'declined a password reset',
  'project.created': (m) => `created project ${m && m.projectName}`,
  'project.archived': (m) => `deleted project ${m && m.projectName}`,
  'project.restored': (m) => `restored project ${m && m.projectName}`,
  'project.member.added': (m) => `assigned ${m && m.username} to ${m && m.projectName}`,
  'project.member.removed': (m) => `removed ${m && m.username} from ${m && m.projectName}`,
  'dm.created': () => 'created a data module',
  'dm.imported': () => 'imported a data module',
  'dm.saved': () => 'saved a data module',
  'dm.renamed': () => 'renamed a data module',
  'dm.deleted': () => 'deleted a data module',
  'dm.restored': () => 'restored a data module',
  'publication.saved': () => 'saved the publication module',
  'publication.imported': () => 'imported a publication module',
  'publication.built': () => 'built the PDF',
  'graphic.uploaded': () => 'uploaded a graphic',
  'request.submitted': (m) => `${m.resubmission ? 'resubmitted' : 'submitted'} ${m.projectName || 'a publication'} for approval`,
  'request.decided': (m) => `${{ approved: 'approved', rejected: 'rejected', changes_requested: 'requested changes to' }[m.outcome] || 'decided'} ${m.projectName || 'a publication'}`,
  'request.withdrawn': (m) => `withdrew the request for ${m.projectName || 'a publication'}`,
  'request.stale': (m) => `request for ${m.projectName || 'a publication'} went out of date${m.cause === 'admin.reset' ? ' (reset by the administrator)' : m.cause === 'admin.override' ? ' (administrator edit)' : ''}`,
  'request.reassigned': (m) => `reassigned the request for ${m.projectName || 'a publication'} from ${m.fromName || '?'} to ${m.toName || '?'}`,
  'admin.override': (m) => `override (${{ decision: 'decision', reset: 'reset', reassign: 'reassignment', content: 'content edit', members: 'members' }[m.kind] || m.kind})${m.projectName ? ` on ${m.projectName}` : ''}`,
  'override.session.started': (m) => `started editing ${m.key || 'a document'}${m.projectName ? ` in ${m.projectName}` : ''} as an override`,
  'audit.exported': (m) => `exported the audit log (${m.rows != null ? m.rows : '?'} rows)`,
  'backup.created': (m) => `took a ${m.kind || ''} backup`.replace('  ', ' '),
  'backup.failed': (m) => `backup failed (${m.code || 'error'})`,
  'backup.verified': () => 'verified a backup',
  'backup.verify_failed': () => 'verified a backup: it failed its checks',
  'backup.deleted': () => 'deleted a backup',
  'backup.retention_deleted': () => 'removed an old backup (retention)',
  'backup.restore_started': () => 'started restoring a backup',
  'backup.restored': () => 'restored a backup',
  'backup.restore_failed': (m) => `restore failed (${m.code || 'error'}); nothing was replaced`,
  'dmrl.imported': () => 'imported a DMRL spreadsheet',
  'package.exported': () => 'exported the project as a CSDB package',
  'backup.bundle_exported': (m) => `downloaded a backup of ${m.projects || 0} project${m.projects === 1 ? '' : 's'}`,
  'package.imported': (m) => `imported a CSDB package (${m.modules || 0} modules, ${m.graphics || 0} graphics)`,
  'settings.wording_changed': () => 'changed the front-matter wording',
};

export function describeAction(action, meta) {
  const f = ACTIONS[action];
  return f ? f(meta || {}) : action;
}

export const isFailureAction = (action) => /failed|_failed$/.test(action);
