import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Card, CardHeader, DetailList } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import DataTable from '../../components/ui/DataTable.jsx';
import { Field, Select } from '../../components/ui/Field.jsx';
import { Avatar, Badge, Mono, OwnerTag, StatusBadge } from '../../components/ui/Badge.jsx';
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog.jsx';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import OverrideDialog from '../../components/OverrideDialog.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import useResource from '../../lib/useResource.js';
import { TabPanel } from '../../components/ui/Tabs.jsx';
import ProjectShell from '../../components/ProjectShell.jsx';
import DataModulesTab from '../dms/DataModulesTab.jsx';
import GraphicsTab from './GraphicsTab.jsx';
import PublicationTab from './PublicationTab.jsx';
import SettingsTab from './SettingsTab.jsx';
import { del, get, post } from '../../api.js';
import { describeAction, fmtDate, fmtRelative } from '../../lib/format.js';

// The administrator assigns as an override: the reason is asked in OverrideDialog (decisions.md V7).
function AssignDialog({ open, onClose, projectId, onAssigned, asAdmin = false }) {
  const [authors, setAuthors] = useState(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setChoice(''); setError(null); setAuthors(null);
    get(`/api/projects/${projectId}/assignable`).then((r) => setAuthors(r.authors)).catch((e) => setError(e.message));
  }, [open, projectId]);

  async function submit(e) {
    e.preventDefault();
    if (!choice) { setError('Choose an Author.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await post(`/api/projects/${projectId}/members`, { userId: choice });
      onAssigned(r.authors, authors.find((a) => a.id === choice));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const picker = (
    <>
      {error ? <Alert>{error}</Alert> : null}
      {authors == null && !error ? <LoadingBlock rows={1} /> : null}
      {authors && !authors.length ? <Alert tone="info">Every active Author is already on this project. Create an Author account first.</Alert> : null}
      {authors && authors.length ? (
        <Field label="Author" required>
          {(p) => (
            <Select {...p} value={choice} onChange={(e) => setChoice(e.target.value)} autoFocus>
              <option value="">Select an Author…</option>
              {authors.map((a) => <option key={a.id} value={a.id}>{a.fullName} ({a.username}){a.status === 'pending' ? ' · setup pending' : ''}</option>)}
            </Select>
          )}
        </Field>
      ) : null}
    </>
  );
  if (asAdmin) {
    return (
      <OverrideDialog open={open} onClose={onClose} title="Assign an Author (override)" confirmLabel="Assign" valid={!!choice}
        description="The Author gains access to this project only." people="the Author and the project's owner"
        onSubmit={async (reason) => {
          if (!choice) throw new Error('Choose an Author.');
          const r = await post(`/api/projects/${projectId}/members`, { userId: choice, reason });
          onAssigned(r.authors, authors.find((a) => a.id === choice));
        }}>
        {picker}
      </OverrideDialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Assign an Author" description="The Author gains access to this project only. They are notified."
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" form="assign" loading={busy} disabled={!authors || !authors.length}>Assign</Button></>}>
      <form id="assign" onSubmit={submit} className="space-y-3" noValidate>
        {error ? <Alert>{error}</Alert> : null}
        {authors == null && !error ? <LoadingBlock rows={1} /> : null}
        {authors && !authors.length ? <Alert tone="info">Every active Author is already on this project. Create an Author account first.</Alert> : null}
        {authors && authors.length ? (
          <Field label="Author" required>
            {(p) => (
              <Select {...p} value={choice} onChange={(e) => setChoice(e.target.value)} autoFocus>
                <option value="">Select an Author…</option>
                {authors.map((a) => <option key={a.id} value={a.id}>{a.fullName} ({a.username}){a.status === 'pending' ? ' · setup pending' : ''}</option>)}
              </Select>
            )}
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}

/*
  The project dashboard (Phase 8): every area of the project in one view,
  each with a link to where it is managed: content, graphics, validation,
  members, the publication and its release state.
*/
function Tile({ title, value, detail, tone, action, onClick, testid }) {
  return (
    <button type="button" onClick={onClick} data-testid={testid} className="text-left rounded-lg border border-line bg-surface shadow-card px-4 py-3 hover:border-accent focus-visible:border-accent">
      <p className="text-[12px] uppercase tracking-wide text-ink-3">{title}</p>
      <p className={`text-[20px] font-semibold ${tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-ink'}`}>{value}</p>
      <p className="text-[12.5px] text-ink-3">{detail}</p>
      {action ? <p className="text-[12.5px] text-accent mt-1">{action} →</p> : null}
    </button>
  );
}
function ProjectDashboard({ project, detail, onTab }) {
  const caps = detail.formatInfo ? detail.formatInfo.capabilities : { dataModules: true };
  const [d, setD] = useState({});
  useEffect(() => {
    let live = true;
    const load = async (key, url) => { try { const v = await get(url); if (live) setD((x) => ({ ...x, [key]: v })); } catch { if (live) setD((x) => ({ ...x, [key]: null })); } };
    if (caps.dataModules) load('dms', `/api/projects/${project.id}/dms`);
    load('assets', `/api/projects/${project.id}/assets`);
    load('last', `/api/projects/${project.id}/builds/last`);
    load('conversion', `/api/projects/${project.id}/conversion-report`);
    return () => { live = false; };
  }, [project.id, caps.dataModules]);
  const mods = d.dms ? d.dms.modules : [];
  const by = (st) => mods.filter((m) => m.status === st).length;
  const last = d.last;
  const rel = last && last.release;
  return (
    <div className="mb-6 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6" data-testid="project-dashboard">
        {caps.dataModules ? <Tile testid="tile-dms" title="Data modules" value={d.dms ? mods.length : '…'} detail={d.dms ? `${by('draft')} draft · ${by('in_review')} in review · ${by('approved')} approved` : ''} action="Editor and DMs" onClick={() => onTab('dms')} />
          : <Tile testid="tile-dms" title="Book" value="JSS" detail="One <jssbook>, edited as XML" action="Edit the book" onClick={() => onTab('publication')} />}
        <Tile testid="tile-graphics" title="Graphics" value={d.assets ? d.assets.icns.length + d.assets.symbols.length : '…'} tone={d.assets && d.assets.problems ? 'warn' : undefined}
          detail={d.assets ? `${d.assets.icns.length} ICNs · ${d.assets.symbols.length} symbols · ${d.assets.parts.length} parts${d.assets.problems ? ` · ${d.assets.problems} problems` : ''}` : ''} action="ICNs, symbols, parts" onClick={() => onTab('graphics')} />
        <Tile testid="tile-validation" title="Validation" value={last && last.validation ? `${last.validation.errors} errors` : 'Not run'} tone={last && last.validation ? (last.validation.errors ? 'danger' : 'ok') : undefined}
          detail={last && last.validation ? `${last.validation.warnings} warnings · ${fmtRelative(last.validation.at)}` : 'Run it on the publication tab'} action="Validate" onClick={() => onTab('publication')} />
        <Tile testid="tile-members" title="Members" value={detail.authors.length + 1} detail={`${project.owner.fullName} (owner)${detail.authors.length ? ` and ${detail.authors.length} Author${detail.authors.length === 1 ? '' : 's'}` : ''}`} />
        <Tile testid="tile-publication" title="Publication" value={last && last.build ? (last.build.ok ? 'Built' : 'Failed') : 'Not built'} tone={last && last.build ? (last.build.ok ? (last.pdfCurrent ? 'ok' : 'warn') : 'danger') : undefined}
          detail={last && last.build ? `${fmtRelative(last.build.at)}${last.pdfAvailable && !last.pdfCurrent ? ' · out of date' : ''}` : 'Build the PDF'} action="Publication and PDF" onClick={() => onTab('publication')} />
        <Tile testid="tile-release" title="Release" value={rel ? (rel.released ? `Release ${rel.releaseNumber}` : 'Not released') : '…'} tone={rel ? (rel.released ? 'ok' : rel.stale ? 'warn' : undefined) : undefined}
          detail={rel ? (rel.released ? `Approved ${fmtRelative(rel.approvedAt)}` : rel.stale ? `Release ${rel.releaseNumber} no longer matches: changed since approval` : 'PDFs are stamped NOT RELEASED') : ''} action="Settings" onClick={() => onTab('settings')} />
      </div>
      {d.conversion ? (
        <Alert tone="info" title={`Converted from ${d.conversion.report.sourceProject.name}`}>
          {d.conversion.report.modules} S1000D modules became this book through s1000dtojss. The original files are kept under source/. {d.conversion.report.lossy ? 'The conversion report lists content that was transformed or dropped.' : 'Nothing was reported lost.'}
        </Alert>
      ) : null}
    </div>
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { data, loading, error, reload, setData } = useResource(`/api/projects/${encodeURIComponent(id)}`);
  const [assigning, setAssigning] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [params, setParams] = useSearchParams();
  const caps = data && data.formatInfo ? data.formatInfo.capabilities : { dataModules: true };
  const TABS = ['dms', 'graphics', 'publication', 'settings'].filter((t) => t !== 'dms' || caps.dataModules);
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'overview';

  if (error) {
    return <Card>{error.status === 404 ? <EmptyState icon="folder" title="Project not found">It does not exist, or you are not a member of it.</EmptyState> : <ErrorState error={error} onRetry={reload} />}</Card>;
  }
  if (loading) return <Card className="p-6"><LoadingBlock rows={6} /></Card>;

  const p = data.project;
  const asAdmin = data.relation === 'oversight';
  // The administrator's assign check needs a reason, so it reads "not allowed" here; they assign as an override.
  const canAssign = data.permissions.assign || asAdmin;

  return (
    <ProjectShell project={p} active={tab} caps={caps} canDelete={data.permissions.delete} onChanged={reload}>
      {caps.dataModules ? <TabPanel idBase="project" value="dms" active={tab}><DataModulesTab project={p} canWrite={data.permissions.write} override={data.permissions.override} /></TabPanel> : null}
      <TabPanel idBase="project" value="settings" active={tab}>{tab === 'settings' ? <SettingsTab project={p} canWrite={data.permissions.write} override={data.permissions.override} format={p.format} /> : null}</TabPanel>
      <TabPanel idBase="project" value="graphics" active={tab}><GraphicsTab project={p} canWrite={data.permissions.write} override={data.permissions.override} /></TabPanel>
      <TabPanel idBase="project" value="publication" active={tab}><PublicationTab project={p} canWrite={data.permissions.write} canBuild={data.permissions.build} override={data.permissions.override} drafts={data.permissions.drafts} formatInfo={data.formatInfo} /></TabPanel>

      <TabPanel idBase="project" value="overview" active={tab}>
      {tab === 'overview' ? (
        <>
          <div className="flex justify-between items-start gap-4 mb-2">
            <h1 className="text-[20px] font-semibold text-ink">{p.name}</h1>
            {canAssign ? <Button variant="primary" icon="plus" onClick={() => setAssigning(true)}>Assign Author</Button> : null}
          </div>
          {p.description ? <p className="text-[14px] text-ink-2 mb-4">{p.description}</p> : null}
          <ProjectDashboard project={p} detail={data} onTab={(v) => setParams({ tab: v })} />
        </>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader title="Assigned Authors" subtitle={`${data.authors.length} assigned in addition to the owner`} />
            <DataTable
              caption="Assigned Authors"
              rows={data.authors}
              initialSort={{ key: 'name', dir: 'asc' }}
              empty={<EmptyState icon="users" title="No Authors assigned" action={canAssign ? <Button icon="plus" onClick={() => setAssigning(true)}>Assign an Author</Button> : null} />}
              columns={[
                { key: 'name', header: 'Author', sortValue: (a) => a.fullName, render: (a) => (
                  <div className="flex items-center gap-2.5">
                    <Avatar name={a.fullName} size={28} />
                    <div className="min-w-0">
                      <span className="font-medium text-ink">{a.fullName}</span>
                      <p className="font-mono text-[12px] text-ink-3">{a.username}</p>
                    </div>
                  </div>
                ) },
                { key: 'status', header: 'Status', sortValue: (a) => a.status, render: (a) => <StatusBadge status={a.status} />, hideBelow: 'sm' },
                { key: 'added', header: 'Assigned', sortValue: (a) => a.addedAt, render: (a) => <span className="text-ink-2">{fmtDate(a.addedAt)}</span>, hideBelow: 'md' },
                { key: 'work', header: 'Last activity', sortValue: (a) => (a.lastActivity ? a.lastActivity.at : ''), render: (a) => (a.lastActivity
                  ? <span className="text-[12.5px] text-ink-2">{describeAction(a.lastActivity.action, {})}<span className="block text-[12px] text-ink-3">{fmtRelative(a.lastActivity.at)}</span></span>
                  : <span className="text-[12px] text-ink-3">None yet</span>), hideBelow: 'lg' },
                ...(canAssign ? [{ key: 'remove', header: <span className="sr-only">Actions</span>, align: 'right', render: (a) => (
                  <Button size="sm" variant="danger-ghost" onClick={() => setRemoving(a)} aria-label={`Remove ${a.fullName} from ${p.name}`}>Remove</Button>
                ) }] : []),
              ]}
            />
          </Card>
          {!data.permissions.write ? (
            <Alert tone="info">{asAdmin
              ? 'You are viewing this project as the administrator. To change content, open a data module, the module list, the graphics or the publication and choose Edit as administrator: each editing session needs a written reason, and every save is recorded and told to the people involved.'
              : "You can read this project's content; the Authors who own or are assigned to it edit it."}</Alert>
          ) : null}
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Details" />
            <div className="px-5 pb-3">
              <DetailList items={[
                ['Project id', <Mono key="i">{p.id}</Mono>],
                ['Owner', <OwnerTag key="o" owner={p.owner} size={20} />],
                ['Your access', <span key="r">{data.relation === 'owner' ? <Badge tone="accent" icon="key">Owner</Badge> : data.relation === 'assigned' ? <Badge icon="users">Assigned</Badge> : <Badge icon="shield">Administrator oversight</Badge>}</span>],
                ['Created', fmtDate(p.createdAt)],
                ['Status', <span key="s" className="capitalize">{p.status}</span>],
                ['Format', <Badge key="f">{data.formatInfo ? data.formatInfo.label : 'S1000D'}</Badge>],
                ['Filed in', <span key="pl" className="text-ink-2">{data.placement ? `${data.placement.workspaceName}${data.placement.folderName ? ` / ${data.placement.folderName}` : ''}` : 'No workspace'}</span>],
                ['Workspace', <span key="w" className="text-ink-2">{p.format === 'jss' ? 'publication.xml (the book), csdb/, Media/, project.json' : 'csdb/, Media/, publication.xml, project.json'}</span>],
              ]} />
            </div>
          </Card>
        </div>
      </div>
      </TabPanel>

      <AssignDialog open={assigning} onClose={() => setAssigning(false)} projectId={p.id} asAdmin={asAdmin}
        onAssigned={(authors, who) => { setAssigning(false); setData({ ...data, authors }); toast.success('Author assigned', who ? who.fullName : undefined); }} />
      {asAdmin ? (
        <OverrideDialog open={!!removing} onClose={() => setRemoving(null)} title="Remove Author from project (override)" confirmLabel="Remove" tone="danger"
          people="the Author and the project's owner"
          description={removing ? `${removing.fullName} will lose access to ${p.name}. Their account is not affected.` : ''}
          onSubmit={async (reason) => {
            const r = await del(`/api/projects/${p.id}/members/${removing.id}`, { reason });
            setData({ ...data, authors: r.authors });
            toast.success('Author removed', removing.fullName);
            setRemoving(null);
          }} />
      ) : (
        <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} title="Remove Author from project?" confirmLabel="Remove" tone="danger"
          onConfirm={async () => {
            const r = await del(`/api/projects/${p.id}/members/${removing.id}`);
            setData({ ...data, authors: r.authors });
            toast.success('Author removed', removing.fullName);
            setRemoving(null);
          }}>
          {removing ? <p><strong className="text-ink">{removing.fullName}</strong> will lose access to {p.name}. Their account is not affected.</p> : null}
        </ConfirmDialog>
      )}
    </ProjectShell>
  );
}
