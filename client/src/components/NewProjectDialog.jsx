import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './ui/Dialog.jsx';
import Button from './ui/Button.jsx';
import { Field, Input, Select, Textarea } from './ui/Field.jsx';
import { Alert } from './ui/States.jsx';
import { useToast } from './ui/Toast.jsx';
import { get, post, postForm } from '../api.js';

/*
  New project (decisions.md WS2, WS3): where it starts from (empty, one XML
  file, or a package), its document format, its details, where it is filed,
  and who has access. The project is owned by whoever creates it. Starting
  from a file puts content in it, so it is offered to Authors only (D2).
*/
const SOURCES = [
  { v: 'empty', t: 'Empty project', d: 'A new workspace with an empty publication.' },
  { v: 'xml', t: 'From an XML file', d: 'A data module, a publication module or a JSS book.', authorOnly: true },
  { v: 'package', t: 'From a package', d: 'A .zip of modules and graphics, such as an Agastya export.', authorOnly: true },
];
const FORMATS = [
  { v: 's1000d', t: 'S1000D', d: 'Data modules and a publication module, checked against the S1000D schemas and BREX.' },
  { v: 'jss', t: 'JSS book', d: 'One <jssbook>, rendered straight to PDF by the JSS stylesheets.' },
  { v: 'jsg', t: 'JSG', d: 'Not available: JSG is not defined in the reference material (no schema, sample or stylesheet).', disabled: true },
];

// "Workspace / Folder / Sub-folder" labels for every folder of a workspace.
export function folderPaths(ws) {
  const byId = new Map(ws.folders.map((f) => [f.id, f]));
  const label = (f) => { const parts = []; for (let x = f; x; x = x.parentId ? byId.get(x.parentId) : null) parts.unshift(x.name); return parts.join(' / '); };
  return ws.folders.map((f) => ({ id: f.id, label: label(f) })).sort((a, b) => a.label.localeCompare(b.label));
}

export default function NewProjectDialog({ open, onClose, onCreated, role = 'project_manager', placeIn = null }) {
  const toast = useToast();
  const file = useRef(null);
  const [source, setSource] = useState('empty');
  const [format, setFormat] = useState('s1000d');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState(null);
  const [place, setPlace] = useState('');
  const [members, setMembers] = useState(new Set());
  const [workspaces, setWorkspaces] = useState([]);
  const [authors, setAuthors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);

  useEffect(() => {
    if (!open) return;
    setSource('empty'); setFormat('s1000d'); setName(''); setDescription(''); setChosen(null); setError(null); setReport(null); setMembers(new Set());
    setPlace(placeIn ? `${placeIn.workspaceId}|${placeIn.folderId || ''}` : '');
    get('/api/workspaces').then((r) => setWorkspaces(r.workspaces.filter((w) => w.canManage))).catch(() => setWorkspaces([]));
    get('/api/authors/assignable').then((r) => setAuthors(r.authors)).catch(() => setAuthors([]));
  }, [open, placeIn]);

  const places = useMemo(() => workspaces.flatMap((w) => [
    { v: `${w.id}|`, t: w.name },
    ...folderPaths(w).map((f) => ({ v: `${w.id}|${f.id}`, t: `${w.name} / ${f.label}` })),
  ]), [workspaces]);

  async function submit(e) {
    e.preventDefault();
    if (name.trim().length < 3) { setError('A project name needs at least 3 characters.'); return; }
    if (source !== 'empty' && !chosen) { setError(source === 'xml' ? 'Choose the XML file.' : 'Choose the .zip package.'); return; }
    const [workspaceId, folderId] = place ? place.split('|') : ['', ''];
    setBusy(true); setError(null); setReport(null);
    try {
      let r;
      const fields = { name: name.trim(), description: description.trim(), format, workspaceId, folderId };
      if (source === 'empty') r = await post('/api/projects', { ...fields, members: [...members] });
      else r = await postForm(source === 'xml' ? '/api/projects/from-xml' : '/api/projects/from-package', { ...fields, members: [...members].join(',') }, chosen);
      toast.success('Project created', r.project.name);
      onCreated(r.project, r);
      if (r.failed && r.failed.length) { setReport(r); return; }
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id) => setMembers((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="New project"
      description="You will own this project. Choose where it starts from, its document format, where it is filed and who works on it."
      footer={report
        ? <Button variant="primary" onClick={onClose}>Done</Button>
        : <><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-project" loading={busy}>Create project</Button></>}>
      <form id="new-project" onSubmit={submit} className="space-y-4" noValidate>
        {error ? <Alert>{error}</Alert> : null}
        {report ? <Alert tone="warn" title="Created, with files that could not be imported">
          <ul className="list-disc pl-4">{report.failed.map((f) => <li key={f.name}><span className="font-mono">{f.name}</span>: {f.message}</li>)}</ul>
        </Alert> : null}
        <fieldset>
          <legend className="text-[13px] font-medium mb-1.5">Start from</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {SOURCES.filter((s) => !s.authorOnly || role === 'author').map((s) => (
              <label key={s.v} className={`rounded-md border px-3 py-2 cursor-pointer text-[13px] ${source === s.v ? 'border-accent bg-accent-soft' : 'border-line'}`}>
                <input type="radio" name="source" value={s.v} checked={source === s.v} onChange={() => { setSource(s.v); setChosen(null); }} className="mr-2" />
                <span className="font-medium">{s.t}</span>
                <span className="block text-ink-3 text-[12px] mt-0.5">{s.d}</span>
              </label>
            ))}
          </div>
          {role !== 'author' ? <p className="text-[12px] text-ink-3 mt-1.5">Starting from a file puts content in the project, which Authors do; create it empty and assign Authors.</p> : null}
        </fieldset>
        {source !== 'empty' ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button icon="upload" onClick={() => file.current && file.current.click()}>{chosen ? 'Choose another file' : source === 'xml' ? 'Choose XML file' : 'Choose .zip package'}</Button>
            <input ref={file} type="file" className="sr-only" tabIndex={-1} aria-label={source === 'xml' ? 'Choose the source XML file' : 'Choose the source package'}
              accept={source === 'xml' ? '.xml,application/xml,text/xml' : '.zip,application/zip'}
              onChange={(e) => { setChosen(e.target.files[0] || null); e.target.value = ''; }} />
            {chosen ? <span className="font-mono text-[12px] text-ink-2 truncate">{chosen.name}</span> : null}
          </div>
        ) : null}
        <fieldset>
          <legend className="text-[13px] font-medium mb-1.5">Document format</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {FORMATS.map((f) => (
              <label key={f.v} className={`rounded-md border px-3 py-2 text-[13px] ${f.disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'} ${format === f.v ? 'border-accent bg-accent-soft' : 'border-line'}`}>
                <input type="radio" name="format" value={f.v} checked={format === f.v} disabled={f.disabled} onChange={() => setFormat(f.v)} className="mr-2" />
                <span className="font-medium">{f.t}</span>
                <span className="block text-ink-3 text-[12px] mt-0.5">{f.d}</span>
              </label>
            ))}
          </div>
          {source !== 'empty' ? <p className="text-[12px] text-ink-3 mt-1.5">The file is checked against the format you choose; a mismatch is refused and nothing is created.</p> : null}
        </fieldset>
        <Field label="Project name" required hint="Unique across the organisation, for example “RDR-A Radar Maintenance Manual”.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />}
        </Field>
        <Field label="Description" hint="Optional. Up to 500 characters.">
          {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />}
        </Field>
        <Field label="Workspace and folder" hint="Optional. Filing a project changes where it is listed, never who can see it.">
          {(p) => (
            <Select {...p} value={place} onChange={(e) => setPlace(e.target.value)}>
              <option value="">No workspace</option>
              {places.map((x) => <option key={x.v} value={x.v}>{x.t}</option>)}
            </Select>
          )}
        </Field>
        <fieldset>
          <legend className="text-[13px] font-medium mb-1.5">Access: Authors who work on it</legend>
          {authors.length ? (
            <div className="max-h-36 overflow-auto rounded-md border border-line divide-y divide-line">
              {authors.map((a) => (
                <label key={a.id} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                  <input type="checkbox" checked={members.has(a.id)} onChange={() => toggle(a.id)} aria-label={`Give ${a.fullName} access`} />
                  {a.fullName} <span className="text-ink-3 font-mono text-[12px]">{a.username}</span>
                </label>
              ))}
            </div>
          ) : <p className="text-[13px] text-ink-3">No other Authors to add. You can add them later on the project.</p>}
        </fieldset>
      </form>
    </Dialog>
  );
}
