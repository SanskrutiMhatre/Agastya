import { useEffect, useRef, useState } from 'react';
import { Dialog } from './ui/Dialog.jsx';
import Button from './ui/Button.jsx';
import { Field, Input, Select } from './ui/Field.jsx';
import { Alert } from './ui/States.jsx';
import { Mono } from './ui/Badge.jsx';
import { get, postForm } from '../api.js';

/*
  Upload a graphic (decisions.md GR5, GL3). Used from a project's own
  Graphics tab, where the project is fixed, and from the cross-project
  graphics library, where the project is chosen first — the same upload
  (POST /api/projects/:id/graphics) either way, so an ICN is still
  registered, matched and placed by exactly one set of rules.
*/
export default function UploadGraphicDialog({ open, onClose, onDone, projectId: fixedProjectId, projects, icn: presetIcn }) {
  const input = useRef(null);
  const [projectId, setProjectId] = useState(fixedProjectId || '');
  const [icn, setIcn] = useState('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  /*
    Reset only when the dialog actually opens, not on every render with new
    `projects` while it is already open: `onDone` commonly reloads the
    caller's data (a fresh `uploadTargets` array), which must not wipe out
    the just-shown "Uploaded" result before the person has read it.
  */
  useEffect(() => {
    if (open) { setProjectId(fixedProjectId || (projects && projects[0] ? projects[0].id : '')); setIcn(presetIcn || ''); setTitle(''); setFile(null); setError(null); setResult(null); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    if (!projectId) { setError('Choose which project this graphic belongs to.'); return; }
    if (!file) { setError('Choose an image file.'); return; }
    setBusy(true); setError(null);
    try { const r = await postForm(`/api/projects/${projectId}/graphics`, { icn: icn.trim(), title: title.trim() }, file); setResult(r); onDone(); }
    catch (err) { setError(err.message); }
    setBusy(false);
  }
  async function suggest() {
    if (!projectId) { setError('Choose a project first.'); return; }
    try { const r = await get(`/api/projects/${projectId}/graphics/next-icn`); setIcn(r.icn); } catch (err) { setError(err.message); }
  }

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title="Upload a graphic"
      description="PNG, JPEG or GIF, up to 64 MB. The file is stored where the PDF build will look for this ICN."
      footer={result ? <Button variant="primary" onClick={onClose}>Done</Button>
        : <><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" form="upload-icn" loading={busy}>Upload</Button></>}>
      {result ? (
        <Alert tone={result.resolves ? 'ok' : 'warn'} title={result.resolves ? 'Uploaded' : 'Uploaded, but it will not appear in the PDF yet'}>
          Stored as <Mono>{result.file}</Mono>.{result.warning ? ` ${result.warning}` : ''}
        </Alert>
      ) : (
        <form id="upload-icn" onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          {projects ? (
            <Field label="Project" required hint="The graphic is registered and placed inside this project.">
              {(p) => (
                <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">Choose a project…</option>
                  {projects.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                </Select>
              )}
            </Field>
          ) : null}
          <Field label="ICN" hint="Leave empty to take it from the file name, e.g. ICN-AGS-A-240000-A-0AGS1-00001-A-01-1.png. The case you type is kept.">
            {(p) => (
              <div className="flex gap-2">
                <Input {...p} className="font-mono flex-1" value={icn} onChange={(e) => setIcn(e.target.value)} maxLength={90} spellCheck={false} />
                {!presetIcn ? <Button type="button" size="sm" variant="secondary" onClick={suggest} disabled={!projectId}>Suggest</Button> : null}
              </div>
            )}
          </Field>
          <Field label="Title" hint="Optional, for the registry.">
            {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}
          </Field>
          <div className="flex items-center gap-3">
            <Button icon="plus" onClick={() => input.current && input.current.click()}>Choose image</Button>
            <input ref={input} type="file" accept="image/png,image/jpeg,image/gif" className="sr-only" tabIndex={-1} aria-label="Choose image"
              onChange={(e) => { setFile(e.target.files[0] || null); e.target.value = ''; }} />
            <span className="text-[13px] text-ink-2 truncate">{file ? file.name : 'No file chosen'}</span>
          </div>
        </form>
      )}
    </Dialog>
  );
}
