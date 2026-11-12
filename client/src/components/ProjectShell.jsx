import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Button from './ui/Button.jsx';
import { ConfirmDialog } from './ui/Dialog.jsx';
import { Alert } from './ui/States.jsx';
import Icon from './Icon.jsx';
import { useToast } from './ui/Toast.jsx';
import { post } from '../api.js';

/*
  The project screen's chrome (replaces the earlier ProjectMenu dropdown):
  a left sidebar listing every section — Overview, Data modules, Graphics,
  Publication & PDF, Settings — always in view while a project is open, so
  moving between them never means hunting through a menu. The section's own
  content (whatever the caller passes as children) fills the rest of the
  screen; for the data-module and book editors that content is the existing
  editor-beside-its-PDF layout from Phase 9, unchanged, just no longer
  alone on the page. Below 1024px the sidebar becomes a horizontal strip
  above the content instead of disappearing.

  "Delete project" (decisions.md UI7) lives at the foot of the sidebar: it
  archives, never erases (`POST .../archive`), so it is offered everywhere
  in the project, not hidden away on the Projects list alone.
*/
function sectionsOf(projectId, caps) {
  return [
    { key: 'overview', to: `/projects/${projectId}`, label: 'Overview', icon: 'grid' },
    ...(caps.dataModules ? [{ key: 'dms', to: `/projects/${projectId}?tab=dms`, label: 'Data modules', icon: 'file' }] : []),
    { key: 'graphics', to: `/projects/${projectId}?tab=graphics`, label: 'Graphics', icon: 'image' },
    { key: 'publication', to: `/projects/${projectId}?tab=publication`, label: caps.builder === false ? 'Book & PDF' : 'Publication & PDF', icon: 'book' },
    { key: 'settings', to: `/projects/${projectId}?tab=settings`, label: 'Settings', icon: 'activity' },
  ];
}

/*
  A vertical tablist (decisions.md UI6): each section is a real navigation
  (a different URL — Data modules, Graphics and Settings are routes, not
  client-only state), but carries `role="tab"` / `aria-selected` so it is
  still a tab to anyone or anything that asks, including the Playwright
  coverage written when these were a horizontal `<Tabs>` strip. A vertical
  tablist is standard ARIA (`aria-orientation="vertical"` on the tablist).
*/
function SectionLink({ s, active }) {
  return (
    <Link key={s.key} to={s.to} role="tab" aria-selected={active} data-testid={`section-${s.key}`}
      className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] whitespace-nowrap ${active ? 'bg-accent-soft text-accent-soft-ink font-medium' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`}>
      <Icon name={s.icon} size={16} className={active ? '' : 'text-ink-3'} />{s.label}
    </Link>
  );
}

export default function ProjectShell({ project, active, caps = { dataModules: true, builder: true }, canDelete = false, onChanged, children }) {
  const nav = useNavigate();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const sections = sectionsOf(project.id, caps);
  const archived = project.status === 'archived';

  async function archive() {
    await post(`/api/projects/${project.id}/archive`, {});
    toast.success('Project deleted', `${project.name} moved out of your projects. Restore it any time.`);
    nav('/projects');
  }
  async function restore() {
    try { await post(`/api/projects/${project.id}/restore`, {}); toast.success('Project restored', project.name); if (onChanged) onChanged(); }
    catch (e) { toast.error('Not restored', e.message); }
  }

  return (
    <>
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink mb-4">
        <Icon name="arrowLeft" size={15} />All projects
      </Link>
      {archived ? (
        <Alert tone="warn" className="mb-4" title={`${project.name} is deleted`}>
          It is hidden from your project list but nothing was removed.
          <div className="mt-2"><Button size="sm" variant="primary" icon="refresh" onClick={restore}>Restore it</Button></div>
        </Alert>
      ) : null}

      {/* Narrow screens: the sections as a horizontal strip above the content. */}
      <div role="tablist" aria-label="Project sections" className="lg:hidden mb-4 -mx-1 flex gap-1 overflow-x-auto pb-1">
        {sections.map((s) => <SectionLink key={s.key} s={s} active={active === s.key} />)}
      </div>

      <div className="flex gap-6 items-start">
        <aside className="hidden lg:block w-56 shrink-0">
          <p className="px-3 pb-2 text-[13px] font-semibold text-ink truncate" title={project.name}>{project.name}</p>
          <div role="tablist" aria-label="Project sections" aria-orientation="vertical" className="flex flex-col gap-0.5">
            {sections.map((s) => <SectionLink key={s.key} s={s} active={active === s.key} />)}
          </div>
          {canDelete ? (
            <>
              <div className="my-2 border-t border-line" />
              <button type="button" onClick={() => setDeleting(true)} data-testid="delete-project"
                className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] text-danger hover:bg-danger-soft text-left">
                <Icon name="trash" size={16} />Delete project
              </button>
            </>
          ) : null}
        </aside>
        <div className="flex-1 min-w-0">{children}</div>
      </div>

      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} title={`Delete ${project.name}?`} confirmLabel="Delete project" tone="danger" onConfirm={archive}>
        <p>This moves it out of your project list. Nothing is removed: every data module, revision, graphic and setting stays exactly as it is, and you (or the administrator) can restore it from <strong className="text-ink">Projects → Show deleted</strong> at any time.</p>
      </ConfirmDialog>
    </>
  );
}
