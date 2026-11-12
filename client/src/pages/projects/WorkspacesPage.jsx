import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, PageHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import DataTable from '../../components/ui/DataTable.jsx';
import { SearchInput } from '../../components/ui/Field.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import Icon from '../../components/Icon.jsx';
import NameDialog from '../../components/NameDialog.jsx';
import useResource from '../../lib/useResource.js';
import { post } from '../../api.js';

/*
  All the workspaces the signed-in person can see (decisions.md UI2), with a
  search box and each one's folder and project counts. "Open" goes to the
  Projects page's two-panel explorer with that workspace already selected
  (?ws=<id>, read by ProjectsPage). Creating a workspace here is the same
  action the Projects page offers; nothing new is invented.
*/
export default function WorkspacesPage() {
  const toast = useToast();
  const nav = useNavigate();
  const { data, loading, error, reload } = useResource('/api/workspaces');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = data ? data.workspaces : [];
    return q ? list.filter((w) => w.name.toLowerCase().includes(q) || w.owner.fullName.toLowerCase().includes(q)) : list;
  }, [data, search]);

  return (
    <>
      <PageHeader eyebrow="Overview" title="Workspace" subtitle="Every workspace you can see, and how much is filed in each."
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New workspace</Button>} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search workspaces or owners" label="Search workspaces" className="w-full sm:w-80" />
          <p className="sm:ml-auto text-[13px] text-ink-3" aria-live="polite">{data ? `${rows.length} of ${data.workspaces.length}` : ''}</p>
        </div>
        {error ? <ErrorState error={error} onRetry={reload} />
          : loading ? <div className="px-4 pb-4"><LoadingBlock rows={3} /></div>
            : (
              <DataTable
                caption="Workspaces"
                rows={rows}
                rowKey={(w) => w.id}
                initialSort={{ key: 'name', dir: 'asc' }}
                empty={search
                  ? <EmptyState icon="search" title="No workspaces match" />
                  : <EmptyState icon="layers" title="No workspaces yet" action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Create one</Button>}>
                      A workspace holds folders and projects. Projects not filed into one still show up on the Projects page.
                    </EmptyState>}
                columns={[
                  { key: 'name', header: 'Workspace', sortValue: (w) => w.name, render: (w) => (
                    <div className="flex items-center gap-2.5">
                      <span className="grid place-items-center h-8 w-8 rounded-md bg-accent-soft text-accent-soft-ink"><Icon name="layers" size={16} /></span>
                      <div className="min-w-0">
                        <span className="font-medium text-ink">{w.name}</span>
                        {!w.canManage ? <span className="ml-2 text-[11px] text-ink-3">shared with you</span> : null}
                      </div>
                    </div>
                  ) },
                  { key: 'owner', header: 'Owner', sortValue: (w) => w.owner.fullName, hideBelow: 'sm', render: (w) => <span className="text-ink-2">{w.owner.fullName}</span> },
                  { key: 'folders', header: 'Folders', align: 'right', sortValue: (w) => w.folders.length, render: (w) => w.folders.length },
                  { key: 'projects', header: 'Projects', align: 'right', sortValue: (w) => w.projects.length, render: (w) => w.projects.length },
                  { key: 'open', header: <span className="sr-only">Open</span>, align: 'right', render: (w) => (
                    <Button size="sm" onClick={() => nav(`/projects?ws=${w.id}`)}>Open<Icon name="chevronRight" size={14} className="ml-0.5" /></Button>
                  ) },
                ]}
              />
            )}
      </Card>
      <NameDialog open={creating} onClose={() => setCreating(false)} title="New workspace" label="Workspace name" action="Create workspace"
        description="A workspace holds folders and projects. It arranges them and gives nobody access."
        onSubmit={async (name) => {
          const r = await post('/api/workspaces', { name });
          toast.success('Workspace created', name);
          reload();
          nav(`/projects?ws=${r.workspace.id}`);
        }} />
    </>
  );
}
