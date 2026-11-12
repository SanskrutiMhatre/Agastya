// Role -> navigation. Pure data so it can be unit-tested. The server is the
// authority on every permission; this only decides what is worth showing.

export const ROLE_LABELS = {
  software_admin: 'Software Administrator',
  project_manager: 'Project Manager',
  author: 'Author',
};

const ITEMS = {
  dashboard: { to: '/', label: 'Dashboard', icon: 'grid', end: true },
  users: { to: '/users', label: 'Users', icon: 'users', badge: 'resets' },
  authors: { to: '/users', label: 'Authors', icon: 'users', badge: 'resets' },
  projects: { to: '/projects', label: 'Projects', icon: 'folder' },
  myProjects: { to: '/projects', label: 'My projects', icon: 'folder' },
  workspaces: { to: '/workspaces', label: 'Workspace', icon: 'layers' },
  dataModules: { to: '/data-modules', label: 'Data modules', icon: 'file' },
  publications: { to: '/publications', label: 'Publications', icon: 'book' },
  graphicsLibrary: { to: '/graphics', label: 'Graphics', icon: 'image' },
  converter: { to: '/tools/converter', label: 'Converter', icon: 'refresh' },
  dmcCreator: { to: '/tools/dmc-creator', label: 'DMC creator', icon: 'file' },
  backup: { to: '/backup', label: 'Backup', icon: 'download' },
  approvals: { to: '/approvals', label: 'Approvals', icon: 'check', badge: 'approvals' },
  audit: { to: '/audit', label: 'Audit log', icon: 'list' },
  health: { to: '/health', label: 'System health', icon: 'activity' },
  backups: { to: '/backups', label: 'Backups', icon: 'download' },
};

const BY_ROLE = {
  software_admin: [
    { heading: 'Overview', items: ['dashboard', 'projects'] },
    { heading: 'Administration', items: ['users', 'approvals', 'audit', 'health', 'backups'] },
  ],
  project_manager: [
    { heading: 'Overview', items: ['dashboard', 'projects'] },
    { heading: 'Team', items: ['authors', 'approvals'] },
  ],
  // Redesigned Author Panel: Overview (dashboard, workspace list, the two-panel
  // project explorer), Authoring (the cross-project graphics library), Other
  // (project backup downloads). The old standalone "Data modules" and
  // "Publications" cross-project pickers are superseded by opening a project
  // directly into its focused editor workspace; their routes still work, they
  // are just no longer linked from here.
  author: [
    { heading: 'Overview', items: ['dashboard', 'workspaces', 'myProjects'] },
    { heading: 'Authoring', items: ['graphicsLibrary', 'converter', 'dmcCreator'] },
    { heading: 'Other', items: ['backup'] },
  ],
};

export function navFor(role) {
  const sections = BY_ROLE[role] || [];
  return sections.map((s) => ({ heading: s.heading, items: s.items.map((k) => ({ key: k, ...ITEMS[k] })) }));
}

// Every path a role's navigation can lead to (for the route guard tests).
export function pathsFor(role) {
  return navFor(role).flatMap((s) => s.items.map((i) => i.to));
}
