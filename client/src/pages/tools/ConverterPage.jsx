import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Field, Input, Select } from '../../components/ui/Field.jsx';
import { Alert } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import { post, postForm } from '../../api.js';

/*
  A package (.zip) in, a JSS book you can edit and download out, in one
  place rather than New project -> From a package, then hunting for Convert
  on its Settings tab. Nothing new runs underneath: this calls the same two
  existing, already-tested steps (project.import, decisions.md WS3; the
  conversion itself, FM4) one after the other. Both the S1000D copy it
  imports from and the JSS result it converts to are real projects, visible
  and deletable from Projects like any other - this is a shortcut through
  the existing flow, not a separate, throwaway converter.

  Only S1000D -> JSS exists (FM4): it is the reference's own s1000dtojss
  stage. JSS -> S1000D is refused everywhere in Agastya, including here,
  because the reference defines no such stage to build or check it against.
*/
export default function ConverterPage() {
  const nav = useNavigate();
  const toast = useToast();
  const input = useRef(null);
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(null); // null | 'importing' | 'converting'
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { source, jss, report }

  async function run() {
    if (!file || name.trim().length < 3) return;
    setError(null); setResult(null);
    setBusy('importing');
    let source;
    try {
      const r = await postForm('/api/projects/from-package', { name: name.trim(), format: 's1000d' }, file);
      source = r.project;
    } catch (e) { setError(e.message); setBusy(null); return; }

    setBusy('converting');
    try {
      const r = await post(`/api/projects/${source.id}/convert`, { to: 'jss', name: `${name.trim()} (JSS)` });
      setResult({ source, jss: r.project, report: r.report });
      toast.success('Converted', r.project.name);
    } catch (e) {
      setError(`The package imported as "${source.name}", but converting it to JSS failed: ${e.message}`);
    }
    setBusy(null);
  }

  return (
    <>
      <PageHeader eyebrow="Authoring" title="Converter" subtitle="S1000D to JSS, from a package you upload here." />
      <Card className="mb-4">
        <CardHeader title="S1000D package to JSS book" subtitle="Runs the reference's own s1000dtojss stage - the same conversion a project's Settings tab offers" />
        <div className="px-5 pb-5 space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project name" required hint="Used for both the imported S1000D copy and the JSS result.">
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={70} placeholder="e.g. Radar Manual" />}
            </Field>
            <Field label="Direction">
              {(p) => (
                <Select {...p} value="s1000d-jss" disabled>
                  <option value="s1000d-jss">S1000D → JSS</option>
                </Select>
              )}
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button icon="upload" onClick={() => input.current && input.current.click()} disabled={!!busy}>{file ? 'Choose another package' : 'Choose .zip package'}</Button>
            <input ref={input} type="file" accept=".zip,application/zip" className="sr-only" tabIndex={-1}
              onChange={(e) => { setFile(e.target.files[0] || null); e.target.value = ''; }} aria-label="Choose CSDB package" />
            {file ? <span className="font-mono text-[12px] text-ink-2 truncate">{file.name}</span> : null}
          </div>
          <Button variant="primary" icon="refresh" onClick={run} loading={!!busy} disabled={!file || name.trim().length < 3}>
            {busy === 'importing' ? 'Importing the package…' : busy === 'converting' ? 'Converting to JSS…' : 'Convert to JSS'}
          </Button>
          <p className="text-[12px] text-ink-3">
            JSS → S1000D is not offered: the reference material defines no such stage, so there is nothing to build this against. Converting the other way (S1000D → JSS) stays one-way for the same reason (decisions.md FM6).
          </p>
        </div>
      </Card>

      {result ? (
        <Card data-testid="conversion-report">
          <CardHeader title={`${result.jss.name} created`} subtitle={result.report.lossy ? 'Check the report below' : 'Nothing lost in the conversion'} />
          <div className="px-5 pb-5 space-y-3 text-[13px]">
            <p className="text-ink-2">
              {result.report.modules} modules, {result.report.frontMatterPagesInlined} front-matter pages inlined, {result.report.images} images copied.
              {' '}The original S1000D package was imported as <strong className="text-ink">{result.source.name}</strong> and is kept unchanged; a copy of it also sits under the new project's <code>source/</code> folder.
            </p>
            {result.report.changed && result.report.changed.length ? <p className="text-warn">Changed counts: {result.report.changed.join('; ')}</p> : null}
            {result.report.unmapped && result.report.unmapped.length ? <p className="text-warn">Dropped by the conversion: {result.report.unmapped.map((u) => `<${u.name || u}>`).join(', ')}</p> : null}
            {result.report.unhandled && result.report.unhandled.length ? <p className="text-ink-3">Not named by the conversion (text kept, markup not): {result.report.unhandled.slice(0, 12).map((u) => `<${u.name}>`).join(', ')}{result.report.unhandled.length > 12 ? ', …' : ''}</p> : null}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="primary" icon="book" onClick={() => nav(`/projects/${result.jss.id}/workspace`)}>Open {result.jss.name} to edit</Button>
              <Button variant="ghost" onClick={() => nav(`/projects/${result.source.id}`)}>Open the imported S1000D copy</Button>
            </div>
            <p className="text-ink-3">To download either as a file, use <Badge icon="download">Backup</Badge> from its project, or the Workspace page.</p>
          </div>
        </Card>
      ) : null}
    </>
  );
}
