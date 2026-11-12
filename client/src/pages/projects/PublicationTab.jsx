import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Field, Input } from '../../components/ui/Field.jsx';
import Tabs, { TabPanel } from '../../components/ui/Tabs.jsx';
import { Alert, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import BuildLog from '../../components/BuildLog.jsx';
import PdfFrame from '../../components/PdfFrame.jsx';
import { api, fetchBlob, get, post, put } from '../../api.js';
import { fmtRelative } from '../../lib/format.js';
import { useBuildLog } from '../../lib/useLive.js';
import { useAuth } from '../../auth.jsx';
import PmcBuilder from './PmcBuilder.jsx';
import ApprovalCard from './ApprovalCard.jsx';
import { useOverrideSession } from '../../components/OverrideSession.jsx';
import { LockBanner } from '../../components/LockBanner.jsx';
import BookEditor from '../../editor/BookEditor.jsx';

const KIND = { schema: 'XSD', brex: 'BREX', graphic: 'Graphic', reference: 'Reference', id: 'Id', file: 'File' };

/*
  The fixed JSS wording on the front-matter pages, as project settings
  (project.json frontMatter.labels). Blank uses the default; "-" leaves an
  authority line out.
*/
function WordingCard({ project, canWrite, overriding = false }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    get(`/api/projects/${project.id}/settings/wording`).then((r) => { setData(r); setValues(r.wording); }).catch(setError);
  }, [project.id]);
  if (error) return <Card><ErrorState error={error} /></Card>;
  if (!data) return null;
  const writable = canWrite && (!data.lock || overriding);
  const dirty = Object.keys(values).some((k) => values[k] !== data.wording[k]);
  async function save() {
    setBusy(true);
    try { const r = await put(`/api/projects/${project.id}/settings/wording`, values); setData({ ...data, wording: r.wording }); setValues(r.wording); toast.success('Wording saved', 'Rebuild the PDF to see it.'); }
    catch (e) { toast.error('Not saved', e.message); }
    setBusy(false);
  }
  return (
    <Card>
      <CardHeader title="Front-matter wording" subtitle="Leave blank for the default. Enter - to leave an authority line out." />
      <div className="px-5 pb-5 space-y-3">
        {Object.entries(data.fields).map(([k, f]) => (
          <Field key={k} label={f.label} hint={`Default: ${f.default.trim()}`}>
            {(p) => <Input {...p} value={values[k] || ''} placeholder={f.default.trim()} readOnly={!writable} maxLength={200} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />}
          </Field>
        ))}
        {data.lock ? <p className="text-[12px] text-warn">{overriding ? 'Part of a pending request: saving makes it out of date (you are asked first).' : 'Locked with the submitted publication.'}</p> : null}
        {writable ? <div className="flex justify-end"><Button size="sm" variant="primary" onClick={save} loading={busy} disabled={!dirty}>Save wording</Button></div> : null}
      </div>
    </Card>
  );
}

// The publication module as XML text, with the save guards and an autosaved draft.
// Exported for BookWorkspace.jsx: a JSS project's focused authoring workspace reuses this exact editor beside its PDF.
export function XmlView({ project, canWrite: mayWrite, onSaved, overriding = false, drafts = true }) {
  const toast = useToast();
  const [pm, setPm] = useState(null);
  const [xml, setXml] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveNotes, setSaveNotes] = useState(null);
  const [draft, setDraft] = useState(null);
  const timer = useRef(null);
  const canWrite = mayWrite && (!(pm && pm.lock) || overriding);

  const load = useCallback(async () => {
    try {
      const r = await get(`/api/projects/${project.id}/publication`);
      setPm(r); setXml(r.xml); setError(null);
      if (mayWrite && drafts && !r.lock) {
        try { const d = (await get(`/api/projects/${project.id}/drafts/publication`)).draft; setDraft(d && d.content !== r.xml ? d : null); } catch { setDraft(null); }
      }
    } catch (e) { setError(e); }
  }, [project.id, mayWrite, drafts]);
  useEffect(() => { load(); }, [load]);

  const dirty = pm && xml !== pm.xml;
  useEffect(() => {
    if (!canWrite || !drafts || !dirty) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { put(`/api/projects/${project.id}/drafts/publication`, { content: xml, baseRevision: pm.revision }).catch(() => {}); }, 2000);
    return () => clearTimeout(timer.current);
  }, [xml, dirty, canWrite, drafts, pm, project.id]);

  async function save(allowEmpty = false) {
    setBusy(true); setSaveError(null); setSaveNotes(null);
    try {
      const r = await put(`/api/projects/${project.id}/publication${allowEmpty ? '?allowEmpty=1' : ''}`, { xml, baseRevision: pm.revision });
      setPm({ ...pm, xml, revision: r.revision, revisionAt: new Date().toISOString(), revisionBy: 'you' }); setDraft(null);
      if ((r.unresolved && r.unresolved.length) || (r.warnings && r.warnings.length)) setSaveNotes(r);
      toast.success('Publication module saved', r.counts ? `${r.counts.dms} data module entries in ${r.counts.folders} chapters` : undefined);
      onSaved && onSaved();
    } catch (e) {
      if (e.code === 'CONFLICT' && drafts) {
        // The refused text becomes the user's draft at once (decisions.md B11).
        clearTimeout(timer.current);
        await put(`/api/projects/${project.id}/drafts/publication`, { content: xml, baseRevision: pm.revision }).catch(() => {});
      }
      setSaveError(e.code === 'CONFLICT' ? { message: 'Someone else saved the publication module after you opened it. Your text is kept as your draft: reload, restore it, and apply your changes again.' } : e);
    }
    setBusy(false);
  }

  if (error) return <Card><ErrorState error={error} onRetry={load} /></Card>;
  if (!pm) return <Card className="p-6"><LoadingBlock rows={6} /></Card>;
  return (
    <Card className="overflow-hidden">
      {pm.lock ? <LockBanner lock={pm.lock} override={overriding} what="The publication module" className="m-4" /> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-line bg-surface-2">
        <span className="text-[13px] text-ink-2">publication.xml <a href={`/api/projects/${project.id}/publication/file`} className="ml-2 text-[12.5px] text-accent hover:underline">Download</a></span>
        <span className="text-[12px] text-ink-3">{pm.revisionAt ? `saved ${fmtRelative(pm.revisionAt)}${pm.revisionBy ? ` by ${pm.revisionBy}` : ''}` : ''}{dirty ? ' · unsaved' : ''}</span>
      </div>
      {draft ? (
        <Alert tone="info" className="m-4" title="You have an unsaved draft of this XML">
          Autosaved {fmtRelative(draft.updatedAt)}.
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" onClick={() => { setXml(draft.content); setDraft(null); }}>Restore draft</Button>
            <Button size="sm" variant="ghost" onClick={async () => { try { await api(`/api/projects/${project.id}/drafts/publication`, { method: 'DELETE' }); } catch { /* gone */ } setDraft(null); }}>Discard</Button>
          </div>
        </Alert>
      ) : null}
      {saveError ? (
        <Alert className="m-4">
          {saveError.message}
          {saveError.code === 'EMPTY_PUBLICATION' && canWrite ? <div className="mt-2"><Button size="sm" variant="danger-ghost" onClick={() => save(true)}>Save it empty anyway</Button></div> : null}
        </Alert>
      ) : null}
      {saveNotes ? (
        <Alert tone="warn" className="m-4" title="Saved, with notes">
          {saveNotes.unresolved.map((u) => <p key={u.code}>No data module in this project has the code {u.code}{u.title ? ` ("${u.title}")` : ''}.</p>)}
          {saveNotes.warnings.map((w) => <p key={w}>{w}</p>)}
        </Alert>
      ) : null}
      <textarea value={xml} onChange={(e) => setXml(e.target.value)} readOnly={!canWrite} spellCheck={false} aria-label="Publication module XML" wrap="off"
        className="block w-full h-[55vh] min-h-72 resize-y bg-surface p-4 font-mono text-[12.5px] leading-5 text-ink outline-none" />
      {canWrite ? <div className="flex justify-end gap-2 px-4 py-3 border-t border-line"><Button variant="primary" onClick={() => save()} loading={busy} disabled={!dirty}>{dirty ? 'Save publication module' : 'Saved'}</Button></div> : null}
    </Card>
  );
}

/*
  The publication: the builder (or its XML), the PDF with live build
  progress and an inline viewer, approval submission, validation, and the
  front-matter wording.
*/
export default function PublicationTab({ project, canWrite: mayWrite, canBuild, override = false, drafts = true, formatInfo = null }) {
  // A JSS book has no publication builder: it is edited as XML (decisions.md FM2).
  const hasBuilder = !formatInfo || formatInfo.capabilities.builder !== false;
  const toast = useToast();
  const { me } = useAuth();
  // The administrator edits the publication module and its wording only as an override (decisions.md V3).
  const ov = useOverrideSession({ projectId: project.id, docKey: 'publication', label: 'the publication module and its wording', enabled: override });
  const canWrite = mayWrite || ov.active;
  const [view, setView] = useState(hasBuilder ? 'builder' : 'xml');
  const [downloadError, setDownloadError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [report, setReport] = useState(null);
  const [build, setBuild] = useState(null);
  const [last, setLast] = useState(null);
  const [showPdf, setShowPdf] = useState(false);
  const [pdfVersion, setPdfVersion] = useState(Date.now());
  const [refreshKey, setRefreshKey] = useState(0);
  const { log } = useBuildLog(project.id, (e) => e.kind === 'full' || e.kind === 'snapshot');

  const loadLast = useCallback(async () => { try { setLast(await get(`/api/projects/${project.id}/builds/last`)); } catch { setLast(null); } }, [project.id]);
  useEffect(() => { loadLast(); }, [loadLast, refreshKey]);
  // A build finishing (yours or someone else's) refreshes the viewer.
  useEffect(() => { if (log && log.phase === 'done') { setPdfVersion(Date.now()); loadLast(); } }, [log, loadLast]);

  async function validate() {
    setBusy('validate');
    try { setReport(await post(`/api/projects/${project.id}/validate`)); loadLast(); } catch (e) { toast.error('Validation failed', e.message); }
    setBusy(null);
  }
  // The server decides whether the PDF on it may be downloaded (decisions.md RL4): refused when out of date.
  async function download() {
    setDownloadError(null);
    try {
      const blob = await fetchBlob(`/api/projects/${project.id}/output.pdf?download=1`);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href; a.download = `${project.name.replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
    } catch (e) { setDownloadError(e.message); loadLast(); }
  }
  async function runBuild() {
    setBusy('build'); setBuild(null);
    try {
      const r = await post(`/api/projects/${project.id}/build`);
      setBuild({ ok: true, ...r }); setPdfVersion(Date.now()); setShowPdf(true);
      toast.success('PDF built', `${(r.totalMs / 1000).toFixed(1)} s`);
    } catch (e) { setBuild({ ok: false, error: e }); }
    setBusy(null); loadLast();
  }

  const errors = report ? report.findings.filter((f) => f.sev !== 'info') : [];
  const canSubmit = me.user.role === 'author' && mayWrite;

  return (
    <div className="space-y-6">
      {ov.bar}
      <div>
        <Tabs idBase="pub" value={view} onChange={setView} tabs={hasBuilder ? [{ value: 'builder', label: 'Builder' }, { value: 'xml', label: 'XML' }] : [{ value: 'xml', label: 'JSS book' }]} />
        {hasBuilder ? <TabPanel idBase="pub" value="builder" active={view}><PmcBuilder key={ov.active ? 'override' : 'normal'} project={project} canWrite={canWrite} overriding={ov.active} drafts={drafts} onSaved={() => setRefreshKey((k) => k + 1)} /></TabPanel> : null}
        <TabPanel idBase="pub" value="xml" active={view}>
          {hasBuilder
            ? <XmlView key={ov.active ? 'override' : 'normal'} project={project} canWrite={canWrite} overriding={ov.active} drafts={drafts} onSaved={() => setRefreshKey((k) => k + 1)} />
            : <BookEditor key={ov.active ? 'override' : 'normal'} project={project} canWrite={canWrite} overriding={ov.active} drafts={drafts} onSaved={() => setRefreshKey((k) => k + 1)} />}
        </TabPanel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_420px] items-start">
        <Card>
          <CardHeader title="PDF" subtitle="Built with the bundled Java, xsltproc and Apache FOP; progress appears as it happens"
            actions={(
              <div className="flex flex-wrap gap-2">
                {canBuild ? <Button variant="primary" icon="book" onClick={runBuild} loading={busy === 'build'}>Build PDF</Button> : null}
                {last && last.pdfAvailable && last.pdfCurrent ? <Button icon="eye" onClick={() => setShowPdf((s) => !s)}>{showPdf ? 'Hide PDF' : 'Show PDF'}</Button> : null}
                {last && last.pdfAvailable ? <Button icon="download" onClick={download}>Download PDF</Button> : null}
              </div>
            )} />
          <div className="px-5 pb-5 space-y-3">
            {last && last.build ? (
              <p className="text-[13px] text-ink-3 flex flex-wrap items-center gap-2" data-testid="last-build">
                {last.build.ok ? <Badge tone="ok" icon="checkCircle">Last build succeeded</Badge> : <Badge tone="danger" icon="alert">Last build failed</Badge>}
                <span>{fmtRelative(last.build.at)}{last.build.by ? ` by ${last.build.by}` : ''}{last.build.ms ? ` · ${(last.build.ms / 1000).toFixed(1)} s` : ''}</span>
              </p>
            ) : <p className="text-[13px] text-ink-3">Not built yet.</p>}
            {last && last.release ? (
              <p className="text-[13px] flex flex-wrap items-center gap-2" data-testid="release-state">
                {last.release.released ? <Badge tone="ok" icon="checkCircle">Release {last.release.releaseNumber}</Badge> : <Badge tone="warn" icon="alert">NOT RELEASED</Badge>}
                <span className="text-ink-3">{last.release.released
                  ? `Approved ${fmtRelative(last.release.approvedAt)}: a build now is the released publication.`
                  : last.release.stale ? `Release ${last.release.releaseNumber} was approved for different content: builds are stamped NOT RELEASED until it is approved again.`
                    : 'Not approved yet: every build is stamped NOT RELEASED.'}</span>
              </p>
            ) : null}
            {last && last.build && last.build.marking ? <p className="text-[12.5px] text-ink-3" data-testid="last-marking">Last build stamped “{last.build.marking}”.</p> : null}
            {last && last.pdfAvailable && !last.pdfCurrent ? <Alert tone="warn" title="The PDF on the server is out of date">It cannot be shown or downloaded: {last.outOfDate}. Build it again.</Alert> : null}
            {downloadError ? <Alert title="Not downloaded">{downloadError}</Alert> : null}
            <BuildLog log={log} />
            {build && !build.ok ? <Alert title="The build failed">{build.error.message}{build.error.body && build.error.body.hint ? <p className="mt-1">{build.error.body.hint}</p> : null}</Alert> : null}
            {build && build.ok && build.notes.length ? <Alert tone="warn" title="Notes">{build.notes.map((n) => <p key={n}>{n}</p>)}</Alert> : null}
            {showPdf && last && last.pdfAvailable && last.pdfCurrent ? <PdfFrame src={`/api/projects/${project.id}/output.pdf`} version={pdfVersion} title="Publication PDF" onClose={() => setShowPdf(false)} /> : null}
          </div>
        </Card>

        <div className="space-y-6">
          <ApprovalCard project={project} canSubmit={canSubmit} buildLog={log} refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />
          <Card>
            <CardHeader title="Project validation" subtitle="Every data module, plus graphics, references and ids"
              actions={<Button size="sm" icon="checkCircle" onClick={validate} loading={busy === 'validate'}>Validate</Button>} />
            <div className="px-5 pb-5">
              {!report ? (
                <p className="text-[13px] text-ink-3">
                  {last && last.validation ? `Last run ${fmtRelative(last.validation.at)}: ${last.validation.errors} errors, ${last.validation.warnings} warnings.` : 'Check the whole project before you build or submit.'}
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2 mb-3 text-[13px]">
                    {report.counts.error ? <Badge tone="danger" icon="alert">{report.counts.error} errors</Badge> : <Badge tone="ok" icon="checkCircle">No errors</Badge>}
                    {report.counts.warning ? <Badge tone="warn">{report.counts.warning} warnings</Badge> : null}
                    <span className="text-ink-3">{report.counts.modules} modules checked</span>
                  </div>
                  {errors.length ? (
                    <ul className="divide-y divide-line rounded-md border border-line max-h-80 overflow-y-auto">
                      {errors.map((f, i) => (
                        <li key={i} className="px-3 py-2 text-[13px]">
                          <div className="flex items-center gap-2"><Badge tone={f.sev === 'error' ? 'danger' : 'warn'}>{KIND[f.kind] || f.kind}</Badge><span className="font-mono text-[11.5px] text-ink-3 truncate">{f.rel.split('/').pop()}{f.line > 1 ? `:${f.line}` : ''}</span></div>
                          <p className="text-ink-2 mt-1">{f.message}</p>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </div>
          </Card>
          <WordingCard project={project} canWrite={canWrite} overriding={ov.active} />
        </div>
      </div>
    </div>
  );
}
