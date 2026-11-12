import { useRef, useState } from 'react';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import { Alert } from '../../components/ui/States.jsx';
import { Field, Input, Select } from '../../components/ui/Field.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import { postBlob, postForm, postFormBlob } from '../../api.js';

function saveBlob(blob, name) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

let nextKey = 1;
const blankRow = () => ({ key: nextKey++, dmc: '', techName: '', infoName: '', schemaType: 'descript' });

/*
  DMC creator (decisions.md UI9): what a piece of work needs - how many data
  modules, each one's code, title and schema - typed in here, not first
  built as a spreadsheet elsewhere. Creates nothing by itself: the rows
  become a zip of shell XML files to download, then bring into a project
  with New project -> From a package, or that project's own Import package.
*/
export default function DmcCreatorPage() {
  const toast = useToast();
  const [rows, setRows] = useState([blankRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const setRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));
  const addRows = (n) => setRows((rs) => [...rs, ...Array.from({ length: n }, blankRow)]);

  const ready = rows.filter((r) => r.dmc.trim() && r.techName.trim());

  async function create() {
    setBusy(true); setError(null);
    try {
      const blob = await postBlob('/api/tools/dmc/shells.zip', { rows: ready.map((r) => ({ dmc: r.dmc.trim(), techName: r.techName.trim(), infoName: r.infoName.trim(), schemaType: r.schemaType })) });
      saveBlob(blob, `dmc-shells-${ready.length}.zip`);
      toast.success('Shells downloaded', `${ready.length} data module${ready.length === 1 ? '' : 's'}`);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <>
      <PageHeader eyebrow="Authoring" title="DMC creator" subtitle="Say what you need - code, title, schema - and get the shell files back." />
      <Alert tone="info" className="mb-4">
        This creates nothing by itself: download the shells, then bring them into a project with New project → From a package, or that project's own Import package.
      </Alert>
      <Card className="mb-4">
        <CardHeader title="Data modules" subtitle="One row per module. A code looks like AGS-A-24-00-00-00A-040A-D." />
        <div className="px-5 pb-5 space-y-3">
          {error ? <Alert>{error}</Alert> : null}
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={r.key} className="grid gap-2 sm:grid-cols-[1.3fr_1.2fr_1.2fr_1fr_auto] items-end rounded-md border border-line p-2.5">
                <Field label={i === 0 ? 'Code' : undefined}>
                  {(p) => <Input {...p} value={r.dmc} onChange={(e) => setRow(r.key, { dmc: e.target.value })} placeholder="AGS-A-24-00-00-00A-040A-D" className="font-mono text-[12.5px]" maxLength={60} />}
                </Field>
                <Field label={i === 0 ? 'Technical name' : undefined}>
                  {(p) => <Input {...p} value={r.techName} onChange={(e) => setRow(r.key, { techName: e.target.value })} placeholder="e.g. Cooling fan tray" maxLength={200} />}
                </Field>
                <Field label={i === 0 ? 'Information name' : undefined}>
                  {(p) => <Input {...p} value={r.infoName} onChange={(e) => setRow(r.key, { infoName: e.target.value })} placeholder="e.g. Removal procedure" maxLength={200} />}
                </Field>
                <Field label={i === 0 ? 'Schema' : undefined}>
                  {(p) => (
                    <Select {...p} value={r.schemaType} onChange={(e) => setRow(r.key, { schemaType: e.target.value })}>
                      <option value="descript">Descriptive</option>
                      <option value="proced">Procedural</option>
                      <option value="ipd">Parts data</option>
                    </Select>
                  )}
                </Field>
                <Button variant="ghost" size="sm" icon="trash" aria-label={`Remove row ${i + 1}`} onClick={() => removeRow(r.key)} disabled={rows.length === 1} />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="ghost" icon="plus" onClick={() => addRows(1)}>Add a row</Button>
            <Button variant="ghost" onClick={() => addRows(5)}>Add 5 more</Button>
            <span className="text-[12px] text-ink-3 ml-auto">{ready.length} of {rows.length} ready (code and technical name filled in)</span>
          </div>
          <Button variant="primary" icon="download" onClick={create} loading={busy} disabled={!ready.length}>
            Create and download {ready.length || ''} shell{ready.length === 1 ? '' : 's'}
          </Button>
        </div>
      </Card>

      <SpreadsheetImport />
    </>
  );
}

// The other direction: a DMRL spreadsheet someone already has, read the same way a project's own import dialog reads one.
function SpreadsheetImport() {
  const toast = useToast();
  const input = useRef(null);
  const [file, setFile] = useState(null);
  const [schemaType, setSchemaType] = useState('descript');
  const [preview, setPreview] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function choose(f, schema = schemaType) {
    if (!f) return;
    setFile(f); setBusy(true); setError(null); setPreview(null);
    try {
      const p = await postForm('/api/tools/dmrl/preview', { schemaType: schema }, f);
      setPreview(p);
      setPicked(new Set(p.rows.map((r) => r.row)));
    } catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function download() {
    setBusy(true); setError(null);
    try {
      const blob = await postFormBlob('/api/tools/dmrl/shells.zip', { schemaType, rows: [...picked].sort((a, b) => a - b).join(',') }, file);
      saveBlob(blob, 'dmc-shells.zip');
      toast.success('Shells downloaded', `${picked.size} data module${picked.size === 1 ? '' : 's'}`);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }
  const toggle = (row) => setPicked((s) => { const n = new Set(s); if (n.has(row)) n.delete(row); else n.add(row); return n; });

  return (
    <details className="group">
      <summary className="cursor-pointer text-[13px] font-medium text-ink-2 mb-2">Or, read an existing DMRL spreadsheet instead</summary>
      <Card>
        <CardHeader title="Spreadsheet" subtitle='Sheet "DMRL" or the first sheet; header row within the first 10 rows.' />
        <div className="px-5 pb-5 space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button icon="table" onClick={() => input.current && input.current.click()} disabled={busy}>{file ? 'Choose another file' : 'Choose .xlsx file'}</Button>
            <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" tabIndex={-1}
              onChange={(e) => { choose(e.target.files[0]); e.target.value = ''; }} aria-label="Choose DMRL spreadsheet" />
            <div className="w-56">
              <Select aria-label="Schema for the new modules" value={schemaType} disabled={busy} onChange={(e) => { setSchemaType(e.target.value); if (file) choose(file, e.target.value); }}>
                <option value="descript">All descriptive</option>
                <option value="proced">All procedural</option>
                <option value="ipd">All illustrated parts data</option>
                <option value="auto">By info code</option>
              </Select>
            </div>
            {file ? <span className="font-mono text-[12px] text-ink-2 truncate">{file.name}</span> : null}
          </div>
          {preview ? (
            <>
              <p className="text-[13px] text-ink-3">Sheet <span className="text-ink">{preview.sheetName}</span> · {preview.rows.length} rows read · {preview.skipped.length} skipped</p>
              <div className="max-h-96 overflow-auto rounded-md border border-line">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-surface-2"><tr className="text-left text-ink-3 text-[12px]">
                    <th className="px-3 py-2"><span className="sr-only">Select</span></th><th className="px-2 py-2">Row</th><th className="px-2 py-2">Code</th><th className="px-2 py-2">Title</th><th className="px-2 py-2">Schema</th>
                  </tr></thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.row} className="border-t border-line">
                        <td className="px-3 py-1.5"><input type="checkbox" checked={picked.has(r.row)} onChange={() => toggle(r.row)} aria-label={`Include row ${r.row}`} /></td>
                        <td className="px-2 py-1.5 tabular text-ink-3">{r.row}</td>
                        <td className="px-2 py-1.5 font-mono text-[12px]">{r.dmc}</td>
                        <td className="px-2 py-1.5">{r.techName}{r.infoName ? ` – ${r.infoName}` : ''}</td>
                        <td className="px-2 py-1.5 text-ink-3"><Badge>{r.schemaType}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.skipped.length ? (
                <Alert tone="warn" title="Skipped rows">
                  <ul className="list-disc pl-4">{preview.skipped.slice(0, 20).map((s) => <li key={`${s.row}-${s.reason}`}>{s.row ? `Row ${s.row}: ` : ''}{s.reason}</li>)}</ul>
                </Alert>
              ) : null}
              <Button variant="primary" icon="download" onClick={download} loading={busy} disabled={!picked.size}>
                Download {picked.size || ''} shell{picked.size === 1 ? '' : 's'} as a zip
              </Button>
            </>
          ) : null}
        </div>
      </Card>
    </details>
  );
}
