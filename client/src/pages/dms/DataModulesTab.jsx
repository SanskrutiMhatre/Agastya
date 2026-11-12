import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import DataTable from '../../components/ui/DataTable.jsx';
import { SearchInput, Select } from '../../components/ui/Field.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { ConfirmDialog } from '../../components/ui/Dialog.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import Icon from '../../components/Icon.jsx';
import useResource from '../../lib/useResource.js';
import { del, fetchBlob, get, post } from '../../api.js';
import { fmtRelative } from '../../lib/format.js';
import { snsOf } from '../../lib/dmc.js';
import NewDmDialog from './NewDmDialog.jsx';
import { useOverrideSession } from '../../components/OverrideSession.jsx';
import { LockBanner, LockedBadge } from '../../components/LockBanner.jsx';
import ImportDialog from './ImportDialog.jsx';
import DmrlDialog from './DmrlDialog.jsx';
import PackageDialog from './PackageDialog.jsx';

// SNS tree: model > system > sub-system, with counts. Selecting a node filters the table.
function SnsTree({ modules, selected, onSelect, names }) {
  const tree = useMemo(() => {
    const t = new Map();
    for (const m of modules) {
      const s = snsOf(m.dmc);
      const sysKey = `${s.model}-${s.system}`;
      if (!t.has(sysKey)) t.set(sysKey, { label: `${s.model} · ${s.system}`, title: names.get(s.system), count: 0, subs: new Map() });
      const node = t.get(sysKey);
      node.count++;
      const subKey = `${sysKey}-${s.sub}`;
      node.subs.set(subKey, { label: `${s.system}-${s.sub}`, count: (node.subs.get(subKey) || { count: 0 }).count + 1 });
    }
    return [...t.entries()].sort();
  }, [modules, names]);
  const item = (key, label, count, depth, title) => (
    <li key={key}>
      <button type="button" onClick={() => onSelect(selected === key ? null : key)} aria-pressed={selected === key}
        className={`w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] ${selected === key ? 'bg-accent-soft text-accent-soft-ink' : 'hover:bg-surface-3 text-ink-2'}`}
        style={{ paddingLeft: 8 + depth * 14 }}>
        <Icon name={depth ? 'chevronRight' : 'layers'} size={14} className="text-ink-3" />
        <span className="flex-1 min-w-0 truncate"><span className="font-mono text-[12px]">{label}</span>{title ? <span className="ml-1.5 text-[12px] text-ink-3">{title}</span> : null}</span>
        <span className="text-[11px] tabular text-ink-3">{count}</span>
      </button>
    </li>
  );
  return (
    <nav aria-label="Standard numbering system" className="p-3">
      <p className="px-2 mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-3">SNS</p>
      <ul className="space-y-0.5">
        {item('all', 'All modules', modules.length, 0)}
        {tree.map(([key, n]) => [item(key, n.label, n.count, 0, n.title), ...[...n.subs.entries()].sort().map(([sk, s]) => item(sk, s.label, s.count, 1))])}
      </ul>
    </nav>
  );
}

const STATUS_TONE = { draft: 'neutral', in_review: 'warn', approved: 'ok' };

export default function DataModulesTab({ project, canWrite: mayWrite, override = false }) {
  const toast = useToast();
  // The administrator creates, imports, deletes and restores modules only as an override (decisions.md V3).
  const ov = useOverrideSession({ projectId: project.id, docKey: 'modules', label: 'the data module list', enabled: override });
  const canWrite = mayWrite || ov.active;
  const [showDeleted, setShowDeleted] = useState(false);
  const { data, loading, error, reload } = useResource(`/api/projects/${project.id}/dms${showDeleted ? '?deleted=1' : ''}`);
  const { data: refData } = useResource('/api/reference-data');
  // SNS system names from the reference data (the original's config-sns seed).
  const snsNames = useMemo(() => new Map(((refData && refData.sns) || []).map((x) => [x.code, x.name])), [refData]);
  const [search, setSearch] = useState('');
  const [field, setField] = useState('title,code');
  const [contentHits, setContentHits] = useState(null);
  const [node, setNode] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const modules = data ? data.modules : [];
  const newDefaults = useMemo(() => (modules[0] ? { modelIdentCode: modules[0].dmc.split('-')[0] } : null), [modules]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return modules.filter((m) => {
      if (node && node !== 'all') {
        const s = snsOf(m.dmc);
        if (!(`${s.model}-${s.system}` === node || `${s.model}-${s.system}-${s.sub}` === node)) return false;
      }
      if (!q) return true;
      if (field === 'content') return contentHits ? contentHits.has(m.id) : true;
      return m.dmc.toLowerCase().includes(q) || `${m.techName} ${m.infoName}`.toLowerCase().includes(q);
    });
  }, [modules, search, node, field, contentHits]);

  async function runContentSearch(q) {
    if (!q.trim()) { setContentHits(null); return; }
    try {
      const r = await get(`/api/projects/${project.id}/dms?search=${encodeURIComponent(q)}&fields=content${showDeleted ? '&deleted=1' : ''}`);
      setContentHits(new Set(r.modules.map((m) => m.id)));
    } catch (e) { toast.error('Search failed', e.message); }
  }

  async function download(url, name) {
    try {
      const blob = await fetchBlob(url);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
    } catch (e) { toast.error('Export failed', e.message); }
  }
  const safeName = project.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const exportDmrl = () => download(`/api/projects/${project.id}/dmrl`, `DMRL-${safeName}.xlsx`);
  const exportPackage = () => download(`/api/projects/${project.id}/package.zip`, `CSDB-${safeName}.zip`);

  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  return (
    <Card className="overflow-hidden">
      {ov.bar ? <div className="m-4 mb-0">{ov.bar}</div> : null}
      {data && data.lock ? <LockBanner lock={data.lock} override={ov.active} what={`The ${data.modules.filter((x) => x.locked).length} modules marked Locked are part of a submitted publication. Each`} className="m-4 mb-0" /> : null}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line">
        <div className="w-full sm:w-72">
          <SearchInput value={search} label="Search data modules" placeholder={field === 'content' ? 'Search inside the XML (press Enter)' : 'Search code or title'}
            onChange={(v) => { setSearch(v); if (field === 'content') setContentHits(null); }} />
        </div>
        <div className="w-40">
          <Select aria-label="Search in" value={field} onChange={(e) => { setField(e.target.value); setContentHits(null); if (e.target.value === 'content') runContentSearch(search); }}>
            <option value="title,code">Code and title</option>
            <option value="content">Full text</option>
          </Select>
        </div>
        {field === 'content' ? <Button size="sm" icon="search" onClick={() => runContentSearch(search)}>Search</Button> : null}
        <label className="flex items-center gap-2 text-[13px] text-ink-2 ml-1">
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Show deleted
        </label>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" icon="table" onClick={exportDmrl}>Export DMRL</Button>
        <Button size="sm" variant="ghost" icon="download" onClick={exportPackage}>Export package</Button>
        {canWrite ? (
          <>
            <Button size="sm" icon="upload" onClick={() => setDialog('package')}>Import package</Button>
            <Button size="sm" icon="table" onClick={() => setDialog('dmrl')}>Import DMRL</Button>
            <Button size="sm" icon="file" onClick={() => setDialog('import')}>Import XML</Button>
            <Button size="sm" variant="primary" icon="plus" onClick={() => setDialog('new')}>New data module</Button>
          </>
        ) : null}
      </div>
      <div className="grid md:grid-cols-[220px_1fr]">
        <div className="hidden md:block border-r border-line bg-surface-2 min-h-60">
          {loading ? <div className="p-3"><LoadingBlock rows={4} /></div> : <SnsTree names={snsNames} modules={modules} selected={node} onSelect={setNode} />}
        </div>
        <div className="min-w-0">
          {loading ? <div className="p-4"><LoadingBlock rows={5} /></div> : (
            <DataTable
              caption="Data modules"
              rows={rows}
              initialSort={{ key: 'dmc', dir: 'asc' }}
              empty={modules.length
                ? <EmptyState icon="search" title="No matching data modules" />
                : <EmptyState icon="file" title="No data modules yet"
                    action={canWrite ? <Button variant="primary" icon="plus" onClick={() => setDialog('new')}>Create the first one</Button> : null}>
                    {canWrite ? 'Create one from the S1000D shell, or import XML files, a CSDB package or a DMRL spreadsheet.' : 'Authors on this project create them.'}
                  </EmptyState>}
              columns={[
                { key: 'dmc', header: 'Data module code', sortValue: (m) => m.dmc, render: (m) => (
                  <Link to={`/projects/${project.id}/dms/${m.id}`} className={`font-mono text-[12.5px] whitespace-nowrap hover:text-accent hover:underline ${m.deletedAt ? 'text-ink-3 line-through' : 'text-ink'}`}>{m.dmc}</Link>
                ) },
                { key: 'title', header: 'Title', sortValue: (m) => m.techName, render: (m) => (
                  <span className="text-ink">{m.techName}{m.infoName ? <span className="text-ink-3"> – {m.infoName}</span> : null}</span>
                ) },
                { key: 'schema', header: 'Schema', sortValue: (m) => m.schemaType, render: (m) => <span className="font-mono text-[12px] text-ink-2">{m.schemaType}</span>, hideBelow: 'lg' },
                { key: 'status', header: 'Status', sortValue: (m) => m.status, render: (m) => (m.deletedAt ? <Badge tone="danger" icon="trash">Deleted</Badge> : (
                  <span className="inline-flex flex-wrap gap-1"><Badge tone={STATUS_TONE[m.status]}>{m.status.replace('_', ' ')}</Badge>{m.locked ? <LockedBadge /> : null}</span>
                )), hideBelow: 'sm' },
                { key: 'updated', header: 'Updated', sortValue: (m) => m.updatedAt, render: (m) => <span className="text-ink-2" title={m.updatedBy || ''}>{fmtRelative(m.updatedAt)}</span>, hideBelow: 'md' },
                // Export DMC: the stored file, byte for byte (decisions.md GR6).
                { key: 'file', header: <span className="sr-only">Download</span>, align: 'right', hideBelow: 'sm', render: (m) => (
                  <a href={`/api/projects/${project.id}/dms/${m.id}/file`} download={m.file} className="text-[12.5px] text-accent hover:underline" title={`Download ${m.file}`}>Download XML</a>
                ) },
                ...(canWrite ? [{ key: 'act', header: <span className="sr-only">Actions</span>, align: 'right', render: (m) => (m.deletedAt
                  ? <Button size="sm" variant="ghost" icon="refresh" onClick={() => setConfirm({ kind: 'restore', m })}>Restore</Button>
                  : m.locked && !ov.active ? <span className="text-[12px] text-ink-3">Read-only</span>
                    : <Button size="sm" variant="danger-ghost" onClick={() => setConfirm({ kind: 'delete', m })} aria-label={`Delete ${m.dmc}`}>Delete</Button>) }] : []),
              ]}
            />
          )}
        </div>
      </div>

      <NewDmDialog open={dialog === 'new'} onClose={() => setDialog(null)} projectId={project.id}
        defaults={newDefaults} shells={data ? data.shells || [] : []} refData={refData}
        onCreated={(m) => { setDialog(null); toast.success('Data module created', m.dmc); reload(); }} />
      <ImportDialog open={dialog === 'import'} onClose={() => setDialog(null)} projectId={project.id} onDone={reload} />
      <DmrlDialog open={dialog === 'dmrl'} onClose={() => setDialog(null)} projectId={project.id} onDone={reload} />
      <PackageDialog open={dialog === 'package'} onClose={() => setDialog(null)} projectId={project.id} onDone={reload} />
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)}
        title={confirm && confirm.kind === 'delete' ? 'Delete data module?' : 'Restore data module?'}
        confirmLabel={confirm && confirm.kind === 'delete' ? 'Delete' : 'Restore'} tone={confirm && confirm.kind === 'delete' ? 'danger' : 'primary'}
        onConfirm={async () => {
          const { kind, m } = confirm;
          if (kind === 'delete') await del(`/api/projects/${project.id}/dms/${m.id}`); else await post(`/api/projects/${project.id}/dms/${m.id}/restore`);
          toast.success(kind === 'delete' ? 'Data module deleted' : 'Data module restored', m.dmc);
          setConfirm(null); reload();
        }}>
        {confirm ? (confirm.kind === 'delete'
          ? <p><span className="font-mono text-ink">{confirm.m.dmc}</span> moves out of the publication build. Its history is kept and it can be restored.</p>
          : <p><span className="font-mono text-ink">{confirm.m.dmc}</span> returns to the project's CSDB.</p>) : null}
      </ConfirmDialog>
    </Card>
  );
}
