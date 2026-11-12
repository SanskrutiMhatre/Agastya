import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Card } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import ProjectShell from '../../components/ProjectShell.jsx';
import { get, post } from '../../api.js';
import BookWorkspace from './BookWorkspace.jsx';

/*
  Opening a project (decisions.md UI5): straight into a focused authoring
  workspace rather than the Overview dashboard. A JSS project has one book,
  edited beside its PDF (BookWorkspace). An S1000D project has many data
  modules, so this redirects to whichever one was edited most recently —
  the existing, fully-featured module editor (its own route, with the
  side-by-side PDF pane from Phase 9) — or, with none yet, offers to create
  one. Project management (Overview, the full module list, Graphics,
  Publication, Settings) stays one click away through the project menu.
*/
export default function ProjectWorkspaceEntry() {
  const { id } = useParams();
  const nav = useNavigate();
  const [state, setState] = useState({ loading: true });
  const opened = useRef(false);

  useEffect(() => {
    let live = true;
    setState({ loading: true });
    get(`/api/projects/${id}`).then((p) => {
      if (!live) return;
      if (!opened.current) { opened.current = true; post(`/api/projects/${id}/opened`, {}).catch(() => {}); }
      const caps = p.formatInfo ? p.formatInfo.capabilities : { dataModules: true };
      if (!caps.dataModules) { setState({ loading: false, project: p.project, permissions: p.permissions }); return; }
      get(`/api/projects/${id}/dms`).then((d) => {
        if (!live) return;
        const liveModules = d.modules.filter((m) => !m.deletedAt);
        const latest = liveModules.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || null;
        setState({ loading: false, project: p.project, permissions: p.permissions, latest, empty: !liveModules.length });
      }).catch((e) => live && setState({ loading: false, error: e }));
    }).catch((e) => live && setState({ loading: false, error: e }));
    return () => { live = false; };
  }, [id]);

  if (state.loading) return <Card className="p-6"><LoadingBlock rows={8} /></Card>;
  if (state.error) {
    return <Card>{state.error.status === 404
      ? <EmptyState icon="folder" title="Project not found">It does not exist, or you are not a member of it.</EmptyState>
      : <ErrorState error={state.error} />}</Card>;
  }
  if (state.project.format === 'jss') {
    return <BookWorkspace project={state.project} canWrite={state.permissions.write} canBuild={state.permissions.build} override={state.permissions.override} canDelete={state.permissions.delete} />;
  }
  if (state.latest) return <Navigate to={`/projects/${id}/dms/${state.latest.id}`} replace />;

  return (
    <ProjectShell project={state.project} active="dms" canDelete={state.permissions.delete}>
      <Card>
        <EmptyState icon="file" title={`${state.project.name} has no data modules yet`}
          action={state.permissions.write ? <Button variant="primary" icon="plus" onClick={() => nav(`/projects/${id}?tab=dms`)}>Create a data module</Button> : null}>
          {state.permissions.write ? 'Create one to start writing.' : 'Its Authors create data modules.'}
        </EmptyState>
      </Card>
    </ProjectShell>
  );
}
