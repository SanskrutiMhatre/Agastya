import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../components/ui/Dialog.jsx';
import Button from '../../components/ui/Button.jsx';
import { Alert } from '../../components/ui/States.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { postForm } from '../../api.js';

/*
  CSDB package import (decisions.md CX3): upload a zip -> the server checks
  every file and says what would happen (nothing is written) -> import what
  it accepts. The server reads the zip again on import and writes only what
  the check accepted.
*/
const STATUS = {
  import: { label: 'will import', tone: 'ok' },
  exists: { label: 'already here', tone: 'neutral' },
  duplicate: { label: 'duplicate', tone: 'warn' },
  refused: { label: 'refused', tone: 'danger' },
  ignored: { label: 'ignored', tone: 'neutral' },
};
const KIND = { module: 'Data module', graphic: 'Graphic', publication: 'Publication module', other: 'Other file' };
const ORDER = { refused: 0, duplicate: 1, import: 2, exists: 3, ignored: 4 };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function PackageDialog({ open, onClose, onDone, projectId }) {
  const input = useRef(null);
  const [file, setFile] = useState(null);
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (open) { setFile(null); setPlan(null); setResult(null); setError(null); } }, [open]);

  async function choose(f) {
    if (!f) return;
    setFile(f); setBusy(true); setError(null); setResult(null); setPlan(null);
    try { setPlan(await postForm(`/api/projects/${projectId}/package/preview`, {}, f)); } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function doImport() {
    setBusy(true); setError(null);
    try {
      setResult(await postForm(`/api/projects/${projectId}/package/import`, {}, file));
      onDone();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  const n = plan ? plan.counts.import : 0;
  const items = plan ? [...plan.items].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name)) : [];
  const invalid = plan ? plan.items.filter((i) => i.status === 'import' && i.validation && i.validation.errors).length : 0;

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} size="lg" title="Import a CSDB package"
      description="A .zip of data modules and their graphics. Every file is checked first; nothing already in the project is replaced."
      footer={result
        ? <Button variant="primary" onClick={onClose}>Done</Button>
        : <><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={doImport} loading={busy && !!plan} disabled={!plan || !n}>Import {n ? plural(n, 'file') : ''}</Button></>}>
      <div className="space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        {!result ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button icon="upload" onClick={() => input.current && input.current.click()} disabled={busy}>{file ? 'Choose another package' : 'Choose .zip package'}</Button>
            <input ref={input} type="file" accept=".zip,application/zip" className="sr-only" tabIndex={-1}
              onChange={(e) => { choose(e.target.files[0]); e.target.value = ''; }} aria-label="Choose CSDB package" />
            {file ? <span className="font-mono text-[12px] text-ink-2 truncate">{file.name}</span> : <span className="text-[13px] text-ink-3">Up to 200 MB. Modules are placed by their code, graphics where the PDF build looks for them.</span>}
            {busy && !plan ? <span className="text-[13px] text-ink-3" role="status">Checking every file…</span> : null}
          </div>
        ) : null}

        {plan && !result ? (
          <>
            <p className="text-[13px] text-ink-2" data-testid="package-summary">
              {plural(plan.counts.modules, 'data module')} and {plural(plan.counts.graphics, 'graphic')} to import
              {plan.counts.exists ? ` · ${plan.counts.exists} already here` : ''}
              {plan.counts.duplicate ? ` · ${plural(plan.counts.duplicate, 'duplicate')}` : ''}
              {plan.counts.refused ? ` · ${plan.counts.refused} refused` : ''}
              {plan.counts.ignored ? ` · ${plan.counts.ignored} ignored` : ''}
              {plan.manifest ? <span className="text-ink-3"> · exported from {plan.manifest.project} on {plan.manifest.exportedAt.slice(0, 10)}</span> : null}
            </p>
            {invalid ? <Alert tone="warn">{plural(invalid, 'module')} to import {invalid === 1 ? 'has' : 'have'} validation errors. They are imported as they are; fix them in the editor.</Alert> : null}
            {plan.notValidated ? <Alert tone="info">{plan.notValidated} modules were not validated in this check (only the first 300 are). Validate the project after the import.</Alert> : null}
            <div className="max-h-80 overflow-auto rounded-md border border-line">
              <table className="w-full text-[13px]" data-testid="package-plan">
                <thead className="sticky top-0 bg-surface-2"><tr className="text-left text-ink-3 text-[12px]">
                  <th className="px-3 py-2">File</th><th className="px-2 py-2">What</th><th className="px-2 py-2">Result</th>
                </tr></thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.name} className="border-t border-line align-top" data-status={it.status}>
                      <td className="px-3 py-1.5">
                        <div className="font-mono text-[12px] break-all">{it.name}</div>
                        {it.code && it.status === 'import' ? <div className="text-ink-3 text-[12px]">{it.techName}{it.infoName ? ` – ${it.infoName}` : ''}</div> : null}
                      </td>
                      <td className="px-2 py-1.5 text-ink-3 whitespace-nowrap">{KIND[it.kind]}</td>
                      <td className="px-2 py-1.5">
                        <Badge tone={STATUS[it.status].tone}>{STATUS[it.status].label}</Badge>
                        {it.validation ? (it.validation.errors
                          ? <Badge tone="warn" className="ml-1">{plural(it.validation.errors, 'error')}</Badge>
                          : <Badge tone="ok" className="ml-1">valid</Badge>) : null}
                        {it.message ? <div className="text-[12px] text-ink-2 mt-1">{it.message}</div> : null}
                        {it.validation && it.validation.firstError ? <div className="text-[12px] text-ink-3 mt-1">{it.validation.firstError}</div> : null}
                        {it.warnings.map((w) => <div key={w} className="text-[12px] text-warn mt-1">{w}</div>)}
                      </td>
                    </tr>
                  ))}
                  {!items.length ? <tr><td colSpan={3} className="px-3 py-4 text-ink-3">The package holds no files.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {result ? (
          <Alert tone={result.failed.length ? 'warn' : 'ok'} title={`${plural(result.modules.length, 'data module')} and ${plural(result.graphics.length, 'graphic')} imported`}>
            {result.failed.length
              ? <ul className="list-disc pl-4">{result.failed.map((f) => <li key={f.name}><span className="font-mono">{f.name}</span>: {f.message}</li>)}</ul>
              : 'Validate the project to check them together.'}
          </Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
