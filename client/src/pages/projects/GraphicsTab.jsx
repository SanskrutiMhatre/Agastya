import { useEffect, useState } from 'react';
import { Card } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import DataTable from '../../components/ui/DataTable.jsx';
import { Dialog } from '../../components/ui/Dialog.jsx';
import { Field, Input, Select } from '../../components/ui/Field.jsx';
import { Badge, Mono } from '../../components/ui/Badge.jsx';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import useResource from '../../lib/useResource.js';
import { del, fetchBlob, patch, post } from '../../api.js';
import Tabs from '../../components/ui/Tabs.jsx';
import { useOverrideSession } from '../../components/OverrideSession.jsx';
import UploadGraphicDialog from '../../components/UploadGraphicDialog.jsx';
import { fmtRelative } from '../../lib/format.js';

const PROBLEM = { missing: 'Missing', misplaced: 'Wrong place', duplicate: 'Duplicate image', conflict: 'Name conflict' };

function Problems({ list }) {
  if (!list || !list.length) return <Badge tone="ok" icon="checkCircle">OK</Badge>;
  return (
    <div className="space-y-1">
      {list.map((p) => <div key={p.code + p.message}><Badge tone={p.code === 'missing' ? 'danger' : 'warn'} icon="alert">{PROBLEM[p.code] || p.code}</Badge><p className="text-[12px] text-ink-3 mt-0.5">{p.message}</p></div>)}
    </div>
  );
}

// Title of a registered graphic, edited in place.
function TitleCell({ projectId, row, canWrite, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.title || '');
  const toast = useToast();
  if (!editing) {
    return (
      <div>
        <Mono className="!text-[12px] text-ink">{row.icn}</Mono>
        <p className="text-[12px] text-ink-3">{row.title || (row.registered ? 'No title' : '')}{canWrite && row.registered ? <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setEditing(true)} aria-label={`Edit the title of ${row.icn}`}>Edit</button> : null}</p>
      </div>
    );
  }
  return (
    <form className="flex gap-1.5" onSubmit={async (e) => {
      e.preventDefault();
      try { await patch(`/api/projects/${projectId}/graphics/${encodeURIComponent(row.icn)}`, { title: value }); setEditing(false); onSaved(); } catch (err) { toast.error('Not saved', err.message); }
    }}>
      <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={200} aria-label={`Title of ${row.icn}`} autoFocus />
      <Button size="sm" variant="primary" type="submit">Save</Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
    </form>
  );
}

function AddPartDialog({ open, onClose, onDone, projectId, ipdModules }) {
  const empty = { dmId: '', figureNumber: '01', item: '', indenture: '1', partNumber: '', manufacturer: '', description: '', quantity: '1' };
  const [f, setF] = useState(empty);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setF({ ...empty, dmId: ipdModules[0] ? ipdModules[0].id : '' }); setError(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await post(`/api/projects/${projectId}/parts`, f); onDone(); onClose(); } catch (err) { setError(err.message); }
    setBusy(false);
  }
  return (
    <Dialog open={open} onClose={onClose} title="Add a part" size="md"
      description="The part goes into the illustrated parts data module as a catalogue entry (catalogSeqNumber), saved as a new revision of that module."
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" form="add-part" loading={busy}>Add part</Button></>}>
      <form id="add-part" onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
        {error ? <Alert className="sm:col-span-2">{error}</Alert> : null}
        <Field label="Parts data module" required className="sm:col-span-2">{(p) => (
          <Select {...p} value={f.dmId} onChange={set('dmId')}>{ipdModules.map((m) => <option key={m.id} value={m.id}>{m.dmc}</option>)}</Select>
        )}</Field>
        <Field label="Part number" required>{(p) => <Input {...p} value={f.partNumber} onChange={set('partNumber')} maxLength={32} />}</Field>
        <Field label="Manufacturer code (CAGE)" required hint="Five letters or digits.">{(p) => <Input {...p} value={f.manufacturer} onChange={set('manufacturer')} maxLength={5} />}</Field>
        <Field label="Description" className="sm:col-span-2">{(p) => <Input {...p} value={f.description} onChange={set('description')} maxLength={200} />}</Field>
        <Field label="Figure" required>{(p) => <Input {...p} value={f.figureNumber} onChange={set('figureNumber')} maxLength={4} />}</Field>
        <Field label="Item" required hint="Three digits, for example 010.">{(p) => <Input {...p} value={f.item} onChange={set('item')} maxLength={4} />}</Field>
        <Field label="Indenture">{(p) => <Input {...p} value={f.indenture} onChange={set('indenture')} maxLength={1} />}</Field>
        <Field label="Quantity" hint="A number, or AR.">{(p) => <Input {...p} value={f.quantity} onChange={set('quantity')} maxLength={4} />}</Field>
      </form>
    </Dialog>
  );
}

/*
  The graphics module (decisions.md GR1-GR6): ICNs (illustrations), symbols
  (ICNs used inside text) and parts (from the illustrated parts data), each
  with what is wrong with it. Uploads, titles, deletion of unused graphics,
  export of ICNs or symbols as a zip, and parts added to an IPD module.
*/
export default function GraphicsTab({ project, canWrite: mayWrite, override = false }) {
  const toast = useToast();
  // The administrator uploads only as an override (decisions.md V3).
  const ov = useOverrideSession({ projectId: project.id, docKey: 'graphics', label: 'the graphics', enabled: override });
  const canWrite = mayWrite || ov.active;
  const { data, loading, error, reload } = useResource(`/api/projects/${project.id}/assets`);
  const [upload, setUpload] = useState(null);
  const [view, setView] = useState('icns');
  const [adding, setAdding] = useState(false);
  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;

  async function exportZip(kind) {
    try {
      const blob = await fetchBlob(`/api/projects/${project.id}/graphics.zip?kind=${kind}`);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href; a.download = `GRAPHICS-${kind}-${project.name.replace(/[^A-Za-z0-9._-]+/g, '_')}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
    } catch (e) { toast.error('Export failed', e.message); }
  }
  async function remove(row) {
    try { await del(`/api/projects/${project.id}/graphics/${encodeURIComponent(row.icn)}`, {}); toast.success('Graphic deleted', row.icn); reload(); } catch (e) { toast.error('Not deleted', e.message); }
  }

  const icnColumns = (kind) => [
    { key: 'thumb', header: <span className="sr-only">Preview</span>, render: (g) => (g.present
      ? <img src={`/api/projects/${project.id}/graphics/${encodeURIComponent(g.icn)}/file`} alt="" className="h-10 w-16 object-contain rounded border border-line bg-white" loading="lazy" />
      : <span className="grid h-10 w-16 place-items-center rounded border border-dashed border-line-strong text-[10px] text-ink-3">none</span>) },
    { key: 'icn', header: kind === 'symbol' ? 'Symbol (ICN)' : 'ICN', sortValue: (g) => g.icn, render: (g) => <TitleCell projectId={project.id} row={g} canWrite={canWrite} onSaved={reload} /> },
    { key: 'issue', header: 'Issue', sortValue: (g) => g.issue || '', hideBelow: 'md', render: (g) => <span className="text-[12px] text-ink-2">{g.issue || '—'}{g.issues && g.issues.length > 1 ? <span className="block text-ink-3">{g.issues.length} issues</span> : null}</span> },
    { key: 'status', header: 'Status', sortValue: (g) => g.problems.length, render: (g) => <Problems list={g.problems} /> },
    { key: 'used', header: 'Used by', sortValue: (g) => g.usedBy.length, render: (g) => (g.usedBy.length ? <span className="font-mono text-[12px] text-ink-2">{g.usedBy.slice(0, 2).join(', ')}{g.usedBy.length > 2 ? ` +${g.usedBy.length - 2}` : ''}</span> : <span className="text-ink-3">not used</span>), hideBelow: 'md' },
    { key: 'expected', header: 'Build looks for', render: (g) => <Mono className="!text-[12px]">{g.expected}</Mono>, hideBelow: 'lg' },
    { key: 'act', header: <span className="sr-only">Actions</span>, align: 'right', render: (g) => (
      <span className="inline-flex gap-1">
        {g.present ? <a className="inline-flex items-center px-2 text-[12.5px] text-accent hover:underline" href={`/api/projects/${project.id}/graphics/${encodeURIComponent(g.icn)}/file`} download={g.file ? g.file.split('/').pop() : undefined} aria-label={`Download ${g.icn}`}>Download</a> : null}
        {canWrite ? <Button size="sm" variant={g.present ? 'ghost' : 'secondary'} onClick={() => setUpload({ icn: g.icn })}>{g.present ? 'Replace' : 'Upload'}</Button> : null}
        {canWrite && !g.usedBy.length && (g.present || g.registered) ? <Button size="sm" variant="danger-ghost" onClick={() => remove(g)} aria-label={`Delete ${g.icn}`}>Delete</Button> : null}
      </span>
    ) },
  ];

  const counts = data ? { icns: data.icns.length, symbols: data.symbols.length, parts: data.parts.length } : {};
  const problemsIn = (list) => (list || []).filter((x) => x.problems.length).length;

  return (
    <Card>
      {ov.bar ? <div className="m-4 mb-0">{ov.bar}</div> : null}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-line">
        <p className="text-[13px] text-ink-3 flex-1" data-testid="assets-summary">
          {data ? `${counts.icns} ICNs · ${counts.symbols} symbols · ${counts.parts} parts · ` : ''}
          {data ? (data.problems ? <span className="text-warn">{data.problems} problem{data.problems === 1 ? '' : 's'}</span> : 'no problems') : ''}
        </p>
        {view !== 'parts' ? <Button size="sm" variant="ghost" icon="download" onClick={() => exportZip(view === 'symbols' ? 'symbol' : 'icn')}>Export {view === 'symbols' ? 'symbols' : 'ICNs'}</Button> : null}
        {canWrite && view !== 'parts' ? <Button size="sm" variant="primary" icon="plus" onClick={() => setUpload({ icn: '' })}>Upload graphic</Button> : null}
        {canWrite && view === 'parts' && data && data.ipdModules.length ? <Button size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)}>Add part</Button> : null}
      </div>
      <div className="px-4 pt-2">
        <Tabs idBase="assets" value={view} onChange={setView} tabs={[
          { value: 'icns', label: 'ICNs', count: problemsIn(data && data.icns) },
          { value: 'symbols', label: 'Symbols', count: problemsIn(data && data.symbols) },
          { value: 'parts', label: 'Parts', count: problemsIn(data && data.parts) },
        ]} />
      </div>
      {loading ? <div className="p-4"><LoadingBlock rows={4} /></div> : view === 'parts' ? (
        <DataTable
          caption="Parts"
          rows={data.parts}
          rowKey={(p) => `${p.manufacturer}|${p.partNumber}`}
          initialSort={{ key: 'pn', dir: 'asc' }}
          empty={<EmptyState icon="list" title="No parts">{data.ipdModules.length ? 'Add a part to an illustrated parts data module.' : 'Parts come from illustrated parts data (IPD) modules. Create one with the IPD schema on the Data modules tab.'}</EmptyState>}
          columns={[
            { key: 'pn', header: 'Part number', sortValue: (p) => p.partNumber, render: (p) => <div><Mono className="!text-[12px] text-ink">{p.partNumber}</Mono><p className="text-[12px] text-ink-3">{p.description || 'No description'}</p></div> },
            { key: 'mfr', header: 'Manufacturer', sortValue: (p) => p.manufacturer, render: (p) => <Mono className="!text-[12px]">{p.manufacturer}</Mono> },
            { key: 'where', header: 'Catalogue entries', render: (p) => <span className="text-[12px] text-ink-2">{p.entries.map((e) => `${e.dmc} fig ${e.figureNumber} item ${e.item}${e.quantity ? ` (qty ${e.quantity})` : ''}`).join('; ')}</span> },
            { key: 'icns', header: 'Illustrated by', hideBelow: 'lg', render: (p) => <span className="font-mono text-[12px] text-ink-2">{[...new Set(p.entries.flatMap((e) => e.icns))].slice(0, 2).join(', ') || '—'}</span> },
            { key: 'used', header: 'Referenced in', hideBelow: 'md', render: (p) => (p.usedBy.length ? <span className="font-mono text-[12px] text-ink-2">{p.usedBy.join(', ')}</span> : <span className="text-ink-3">only the catalogue</span>) },
            { key: 'status', header: 'Status', render: (p) => <Problems list={p.problems} /> },
          ]}
        />
      ) : (
        <DataTable
          caption={view === 'symbols' ? 'Symbols' : 'ICNs'}
          rows={view === 'symbols' ? data.symbols : data.icns}
          rowKey={(g) => g.icn}
          initialSort={{ key: 'status', dir: 'desc' }}
          empty={<EmptyState icon="layers" title={view === 'symbols' ? 'No symbols' : 'No graphics yet'}>{view === 'symbols' ? 'Symbols are ICNs used inside text with <symbol>.' : 'Figures in data modules refer to graphics by ICN; they appear here once referenced or uploaded.'}</EmptyState>}
          columns={icnColumns(view === 'symbols' ? 'symbol' : 'icn')}
        />
      )}
      <UploadGraphicDialog open={!!upload} icn={upload && upload.icn} projectId={project.id} onClose={() => setUpload(null)}
        onDone={() => { reload(); toast.success('Graphic uploaded'); }} />
      {data ? <AddPartDialog open={adding} onClose={() => setAdding(false)} projectId={project.id} ipdModules={data.ipdModules} onDone={() => { reload(); toast.success('Part added'); }} /> : null}
    </Card>
  );
}
