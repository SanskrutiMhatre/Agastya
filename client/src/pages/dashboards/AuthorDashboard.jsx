import { Link, useNavigate } from 'react-router-dom';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card.jsx';
import StatTile from '../../components/ui/StatTile.jsx';
import Button from '../../components/ui/Button.jsx';
import { Badge, OwnerTag } from '../../components/ui/Badge.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import Icon from '../../components/Icon.jsx';
import useResource from '../../lib/useResource.js';
import { useAuth } from '../../auth.jsx';
import { fmtRelative } from '../../lib/format.js';
import { RequestBadge } from '../projects/ApprovalCard.jsx';

const STATUS = { draft: 'Draft', in_review: 'In review', approved: 'Approved' };
const FORMAT_LABEL = { s1000d: 'S1000D', jss: 'JSS' };

function draftLink(d) {
  if (d.key.startsWith('dm-')) return `/projects/${d.projectId}/dms/${d.key.slice(3)}`;
  return `/projects/${d.projectId}?tab=publication`;
}
const draftTitle = (d) => (d.key.startsWith('dm-') ? 'Data module' : d.key === 'publication' ? 'Publication module (XML)' : 'Publication (builder)');

/*
  The redesigned Author dashboard: a quick orientation, not a second
  project manager. Projects are created and organised on the Projects
  page (which "View Projects" opens); this shows only the ones actually
  opened recently, by this person, in this browser session or an earlier
  one (decisions.md UI1, server/db/store.js listRecentlyOpened).
*/
export default function AuthorDashboard() {
  const { me } = useAuth();
  const nav = useNavigate();
  const { data, loading, error, reload } = useResource('/api/dashboard/author');
  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  const d = data;
  const first = me.user.fullName.split(' ')[0];
  const t = d ? d.totals : null;

  return (
    <>
      <PageHeader eyebrow="Author" title={`Welcome, ${first}`}
        subtitle="Your projects, data modules, publications and approval requests."
        actions={<Button variant="primary" icon="folder" onClick={() => nav('/projects')}>View Projects</Button>} />

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile loading={loading} label="My projects" icon="folder" to="/projects" value={t && t.projects}
          hint={t ? `${t.owned} owned · ${t.assigned} assigned` : null} />
        <StatTile loading={loading} label="My data modules" icon="file" to="/projects" value={t && t.dataModules}
          hint={d ? Object.entries(STATUS).map(([k, l]) => `${d.dataModules.byStatus[k] || 0} ${l.toLowerCase()}`).join(' · ') : null} />
        <StatTile loading={loading} label="My publications" icon="book" to="/projects" value={t && t.publications}
          hint={t ? `${t.pendingRequests} pending approval` : null} />
        <StatTile loading={loading} label="Validation issues" icon="alert" tone={t && t.validationErrors ? 'warn' : undefined} value={t && t.validationErrors}
          hint={t ? `${t.validationWarnings} warnings${t.unvalidated ? ` · ${t.unvalidated} project${t.unvalidated === 1 ? '' : 's'} not validated yet` : ''}` : null} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5 items-start">
        <div className="lg:col-span-3 space-y-6">
          <Card>
            <CardHeader title="Recently opened projects" subtitle="Projects you have actually opened, most recent first"
              actions={<Button size="sm" variant="ghost" onClick={() => nav('/projects')}>All projects</Button>} />
            {loading ? <div className="px-5 pb-5"><LoadingBlock rows={3} /></div>
              : d.recentlyOpened.length ? (
                <ul className="divide-y divide-line border-t border-line" data-testid="recently-opened">
                  {d.recentlyOpened.map((p) => (
                    <li key={p.id}>
                      <Link to={`/projects/${p.id}/workspace`} className="flex items-center gap-4 px-5 py-3.5 hover:bg-surface-2 group">
                        <span className="grid place-items-center h-9 w-9 rounded-md bg-accent-soft text-accent-soft-ink"><Icon name="folder" size={18} /></span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-ink group-hover:text-accent truncate">{p.name}</p>
                            <Badge>{FORMAT_LABEL[p.format] || p.format}</Badge>
                            {p.relation === 'owner' ? <Badge tone="accent" icon="key">Owner</Badge> : <Badge icon="users">Assigned</Badge>}
                          </div>
                          <p className="text-[12px] text-ink-3 flex flex-wrap items-center gap-x-3 mt-0.5">
                            <OwnerTag owner={p.owner} size={16} /><span>Opened {fmtRelative(p.openedAt)}</span>
                          </p>
                        </div>
                        <Icon name="chevronRight" size={16} className="text-ink-3" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon="folder" title="Nothing opened yet" action={<Button variant="primary" icon="folder" onClick={() => nav('/projects')}>View Projects</Button>}>
                  Open a project to start writing. It will show up here next time.
                </EmptyState>
              )}
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader title="Approval requests" subtitle="Publications you submitted" />
            {loading ? <div className="px-5 pb-5"><LoadingBlock rows={2} /></div> : d.requests.length ? (
              <ul className="divide-y divide-line border-t border-line" data-testid="dashboard-requests">
                {d.requests.map((r) => (
                  <li key={r.id}>
                    <Link to={`/projects/${r.projectId}?tab=publication`} className="block px-5 py-3 hover:bg-surface-2">
                      <div className="flex flex-wrap items-center gap-2"><RequestBadge status={r.status} /><span className="text-[13px] text-ink truncate">{r.projectName}</span></div>
                      <p className="text-[12px] text-ink-3 mt-0.5">To {r.manager.name} · {fmtRelative(r.submittedAt)}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="px-5 pb-5 text-[13px] text-ink-3">None yet. Submit a publication from its project's Publication & PDF tab.</p>}
          </Card>
          <Card>
            <CardHeader title="Drafts" subtitle="Unsaved work, autosaved while you edit" />
            {loading ? <div className="px-5 pb-5"><LoadingBlock rows={2} /></div> : d.drafts.length ? (
              <ul className="divide-y divide-line border-t border-line" data-testid="dashboard-drafts">
                {d.drafts.map((x) => (
                  <li key={`${x.projectId}-${x.key}`}>
                    <Link to={draftLink(x)} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2">
                      <Icon name="edit" size={16} className="text-ink-3" />
                      <div className="min-w-0 flex-1"><p className="text-[13px] text-ink truncate">{draftTitle(x)}</p><p className="text-[12px] text-ink-3 truncate">{x.projectName}</p></div>
                      <span className="text-[12px] text-ink-3">{fmtRelative(x.updatedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="px-5 pb-5 text-[13px] text-ink-3">No unsaved drafts.</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
