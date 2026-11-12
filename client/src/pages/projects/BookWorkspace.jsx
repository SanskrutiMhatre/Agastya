import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Alert } from '../../components/ui/States.jsx';
import ProjectShell from '../../components/ProjectShell.jsx';
import SplitPane from '../../components/SplitPane.jsx';
import PdfFrame from '../../components/PdfFrame.jsx';
import { get, post } from '../../api.js';
import { fmtRelative } from '../../lib/format.js';
import { useBuildLog } from '../../lib/useLive.js';
import BookEditor from '../../editor/BookEditor.jsx';

/*
  A JSS project's focused authoring workspace (decisions.md UI5): the book,
  edited as XML (the same XmlView the Publication tab uses), beside its
  built PDF. Reuses the Phase 9 SplitPane rather than a new layout, and the
  same release/currentness rules as every other PDF in the app (RL4):
  a stale PDF is refused and must be built again.
*/
export default function BookWorkspace({ project, canWrite, canBuild, override, canDelete }) {
  const [last, setLast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [buildError, setBuildError] = useState(null);
  const [pdfVersion, setPdfVersion] = useState(Date.now());
  const { log } = useBuildLog(project.id, (e) => e.kind === 'full');

  const loadLast = useCallback(async () => { try { setLast(await get(`/api/projects/${project.id}/builds/last`)); } catch { setLast(null); } }, [project.id]);
  useEffect(() => { loadLast(); }, [loadLast]);
  useEffect(() => { if (log && log.phase === 'done') { setPdfVersion(Date.now()); loadLast(); } }, [log, loadLast]);

  async function build() {
    setBusy(true); setBuildError(null);
    try { await post(`/api/projects/${project.id}/build`); setPdfVersion(Date.now()); } catch (e) { setBuildError(e); }
    setBusy(false);
    loadLast();
  }

  return (
    <ProjectShell project={project} active="publication" caps={{ dataModules: false, builder: false }} canDelete={canDelete}>
      <header className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold text-ink">{project.name}</h1>
          <p className="text-[13px] text-ink-3 mt-1 flex flex-wrap items-center gap-2">
            <Badge icon="book">JSS book</Badge>
            {last && last.release ? (last.release.released ? <Badge tone="ok" icon="checkCircle">Release {last.release.releaseNumber}</Badge> : <Badge tone="warn">NOT RELEASED</Badge>) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canBuild ? <Button variant="primary" icon="book" onClick={build} loading={busy}>Build PDF</Button> : null}
        </div>
      </header>

      <SplitPane mode="split" storageKey="agastya.book.split" label="Resize the book editor and the PDF"
        left={<BookEditor project={project} canWrite={canWrite} overriding={override} onSaved={loadLast} />}
        right={(
          <Card className="overflow-hidden" data-testid="book-pdf-pane">
            <CardHeader title="PDF" subtitle={last && last.build ? `${last.build.ok ? 'Built' : 'Build failed'} ${fmtRelative(last.build.at)}` : 'Not built yet'} />
            <div className="px-5 pb-5 space-y-3">
              {buildError ? <Alert title="The build failed">{buildError.message}</Alert> : null}
              {last && last.pdfAvailable && !last.pdfCurrent ? <Alert tone="warn" title="The PDF on the server is out of date">{last.outOfDate}. Build it again.</Alert> : null}
              {last && last.pdfAvailable && last.pdfCurrent ? <PdfFrame src={`/api/projects/${project.id}/output.pdf`} version={pdfVersion} title={`Book: ${project.name}`} height="70vh" /> : (
                <div className="h-40 grid place-items-center text-ink-3 text-[13px]">{canBuild ? 'Build the PDF to see it here.' : 'No PDF built yet.'}</div>
              )}
            </div>
          </Card>
        )} />
    </ProjectShell>
  );
}
