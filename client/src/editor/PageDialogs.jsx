import { useEffect, useMemo, useRef, useState } from 'react';
import Button from '../components/ui/Button.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { Field, Input, Select } from '../components/ui/Field.jsx';
import { Alert, LoadingBlock } from '../components/ui/States.jsx';
import Tabs, { TabPanel } from '../components/ui/Tabs.jsx';
import { get, postForm } from '../api.js';
import { elementAt, childNames } from './xmlDoc.js';
import { elementIndexAt, ensureId, internalRefSpec, dmRefSpec, externalPubRefSpec, figureSpec, tableSpec, allIds, declareEntity, identOf, checkIdent } from './ops.js';
import { fullDmRefSpec, pmCodeOf, pmRefSpec } from './commands.js';

// A fresh id with a prefix, unique in the document being edited.
function newId(doc, prefix) {
  const ids = allIds(doc);
  let n = 1;
  while (ids.has(`${prefix}-${String(n).padStart(4, '0')}`)) n++;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

/*
  The insert palette (the Insert button, "/" in an empty line, the right
  mouse button): every element the content model allows near the selection,
  at the cursor first, then inside the selected element, then after it or
  after one of its ancestors. Type to filter; arrows and Enter to choose.
*/
export function InsertPalette({ doc, model, path, caret, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const options = useMemo(() => {
    const out = [];
    const seen = new Set();
    const add = (o) => { if (!seen.has(`${o.name}|${o.where}`)) { seen.add(`${o.name}|${o.where}`); out.push(o); } };
    const el = elementAt(doc, path);
    if (!el) return out;
    if (caret && model.holdsText(el.nodeName)) {
      for (const name of model.insertableAt(el.nodeName, childNames(el), elementIndexAt(el, caret.nodeIndex))) add({ name, inline: true, where: 'at the cursor' });
    } else if (!model.holdsText(el.nodeName)) {
      for (const name of model.insertableAt(el.nodeName, childNames(el), childNames(el).length)) add({ name, parentPath: path, index: childNames(el).length, where: `inside <${el.nodeName}>, at the end` });
    }
    for (let p = path; p.length; p = p.slice(0, -1)) {
      const parentPath = p.slice(0, -1);
      const parent = elementAt(doc, parentPath);
      const me = elementAt(doc, p);
      for (const name of model.insertableAt(parent.nodeName, childNames(parent), p[p.length - 1] + 1)) add({ name, parentPath, index: p[p.length - 1] + 1, where: `after <${me.nodeName}>` });
    }
    // Before the selected element itself (as the original's "Insert before this…").
    if (path.length) {
      const parentPath = path.slice(0, -1);
      const parent = elementAt(doc, parentPath);
      if (!model.holdsText(parent.nodeName)) for (const name of model.insertableAt(parent.nodeName, childNames(parent), path[path.length - 1])) add({ name, parentPath, index: path[path.length - 1], where: `before <${el.nodeName}>` });
    }
    return out;
  }, [doc, model, path, caret]);
  const shown = options.filter((o) => !q || o.name.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => { setAt(0); }, [q]);
  return (
    <Dialog open onClose={onClose} title="Insert" size="sm" description="Only what the S1000D schema allows here is listed.">
      <div onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(i + 1, shown.length - 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
        if (e.key === 'Enter' && shown[at]) { e.preventDefault(); onPick(shown[at]); }
      }}>
        <Input aria-label="Filter elements" placeholder="Filter, for example para or figure" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <ul role="listbox" aria-label="Elements allowed here" className="mt-2 max-h-72 overflow-y-auto divide-y divide-line rounded-md border border-line" data-testid="insert-options">
          {shown.length ? shown.map((o, i) => (
            <li key={`${o.name}|${o.where}`} role="option" aria-selected={i === at}>
              <button type="button" onClick={() => onPick(o)} onMouseEnter={() => setAt(i)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] ${i === at ? 'bg-accent-soft' : ''}`}>
                <span className="font-mono text-ink">&lt;{o.name}&gt;</span><span className="text-[11.5px] text-ink-3">{o.where}</span>
              </button>
            </li>
          )) : <li className="px-3 py-3 text-[13px] text-ink-3">{options.length ? 'Nothing matches.' : 'Nothing can be inserted here. Select another element.'}</li>}
        </ul>
      </div>
    </Dialog>
  );
}

// The identification fields a data module reference may carry, read from the target module's XML.
function identFields(xml) {
  const attr = (el, a) => { const m = new RegExp(`<${el}\\b[^>]*\\b${a}="([^"]*)"`).exec(xml); return m ? m[1] : ''; };
  const text = (el) => { const m = new RegExp(`<${el}>([^<]*)</${el}>`).exec(xml); return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim() : ''; };
  return { issueNumber: attr('issueInfo', 'issueNumber'), inWork: attr('issueInfo', 'inWork'), techName: text('techName'), infoName: text('infoName') };
}

const KIND_LABEL = { figure: 'Figures', table: 'Tables', levelledPara: 'Paragraphs', proceduralStep: 'Steps' };

/*
  References at the cursor: to a figure, table, paragraph or step in this
  module (an id is given to the target if it has none), to another data
  module of the project (optionally with its issue and title), to the
  project's publication module, or to an external publication.
*/
export function ReferenceDialog({ targets, modules, allowed, projectId, onInsert, onClose }) {
  const first = allowed.internalRef ? 'internal' : allowed.dmRef ? 'dm' : allowed.pmRef ? 'pm' : 'external';
  const [tab, setTab] = useState(first);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [withTitle, setWithTitle] = useState(false);
  const [withIssue, setWithIssue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [pm, setPm] = useState(undefined);
  const [pmTitle, setPmTitle] = useState(true);
  useEffect(() => {
    if (tab !== 'pm' || pm !== undefined || !projectId) return;
    get(`/api/projects/${projectId}/publication`).then((d) => setPm(pmCodeOf(d.xml)), () => setPm(null));
  }, [tab, pm, projectId]);
  const pickDm = async (x) => {
    setErr(null);
    if (!withTitle && !withIssue) { onInsert(() => dmRefSpec(x.dmc)); return; }
    // The reference goes in at once, with the title from the project's list; the issue, which only the
    // target module holds, follows when it has been read (the author can type on meanwhile).
    const ident = { techName: x.techName || '', infoName: x.infoName || '' };
    const issue = withIssue ? get(`/api/projects/${projectId}/dms/${x.id}`).then((d) => identFields(d.xml)) : null;
    onInsert(() => fullDmRefSpec(dmRefSpec(x.dmc), ident, { withTitle, withIssue: false }), { issue });
  };
  const t = targets.filter((x) => (!kind || x.kind === kind) && (!q || `${x.label} ${x.title} ${x.id || ''}`.toLowerCase().includes(q.toLowerCase())));
  const m = modules.filter((x) => !q || `${x.dmc} ${x.title}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Dialog open onClose={onClose} title="Insert a reference" size="md">
      <Tabs idBase="ref" value={tab} onChange={(v) => { setTab(v); setQ(''); }} tabs={[
        ...(allowed.internalRef ? [{ value: 'internal', label: 'In this module' }] : []),
        ...(allowed.dmRef ? [{ value: 'dm', label: 'Data module' }] : []),
        ...(allowed.pmRef ? [{ value: 'pm', label: 'Publication module' }] : []),
        ...(allowed.externalPubRef ? [{ value: 'external', label: 'External publication' }] : []),
      ]} />
      <TabPanel idBase="ref" value="internal" active={tab}>
        <div className="flex gap-2">
          <Select aria-label="Target type" value={kind} onChange={(e) => setKind(e.target.value)} className="w-40">
            <option value="">Everything</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          <Input aria-label="Filter targets" placeholder="Filter by label, title or id" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ul className="mt-2 max-h-64 overflow-y-auto divide-y divide-line rounded-md border border-line" data-testid="ref-targets">
          {t.length ? t.map((x) => (
            <li key={x.path.join('.')}>
              <button type="button" className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-3"
                onClick={() => onInsert((p) => internalRefSpec({ ...x, id: x.id || ensureId(p, x.path) }))}>
                <span className="font-mono text-[12px] text-ink-3 shrink-0">{x.label}</span><span className="truncate text-ink">{x.title || 'untitled'}</span>
                {!x.id ? <span className="ml-auto text-[11px] text-ink-3 shrink-0">gets an id</span> : null}
              </button>
            </li>
          )) : <li className="px-3 py-3 text-[13px] text-ink-3">No figures, tables, paragraphs or steps to refer to.</li>}
        </ul>
      </TabPanel>
      <TabPanel idBase="ref" value="dm" active={tab}>
        <Input aria-label="Filter data modules" placeholder="Filter by code or title" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="mt-2 max-h-64 overflow-y-auto divide-y divide-line rounded-md border border-line" data-testid="ref-modules">
          {m.length ? m.map((x) => (
            <li key={x.dmc}>
              <button type="button" disabled={busy} className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-3" onClick={() => pickDm(x)}>
                <span className="font-mono text-[12px] text-ink shrink-0">{x.dmc}</span><span className="truncate text-ink-2">{x.title}</span>
              </button>
            </li>
          )) : <li className="px-3 py-3 text-[13px] text-ink-3">No other data modules.</li>}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-4 text-[13px] text-ink-2">
          <span>Also include:</span>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={withTitle} onChange={(e) => setWithTitle(e.target.checked)} />Technical and information name</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={withIssue} onChange={(e) => setWithIssue(e.target.checked)} />Issue</label>
        </div>
        {err ? <Alert className="mt-2" title="Not inserted">{err}</Alert> : null}
      </TabPanel>
      <TabPanel idBase="ref" value="pm" active={tab}>
        {pm === undefined ? <LoadingBlock rows={1} /> : pm === null ? (
          <p className="text-[13px] text-ink-3">This project's publication module has no complete code yet; give it one in the publication builder first.</p>
        ) : (
          <div className="space-y-3" data-testid="ref-pm">
            <p className="text-[13px]"><span className="font-mono">{pm.label}</span>{pm.title ? <span className="text-ink-2"> – {pm.title}</span> : null}</p>
            <label className="flex items-center gap-1.5 text-[13px] text-ink-2"><input type="checkbox" checked={pmTitle} onChange={(e) => setPmTitle(e.target.checked)} disabled={!pm.title} />Include the title</label>
            <Button variant="primary" onClick={() => onInsert(() => pmRefSpec(pm, { withTitle: pmTitle }))}>Insert reference</Button>
          </div>
        )}
      </TabPanel>
      <TabPanel idBase="ref" value="external" active={tab}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (code.trim() || title.trim()) onInsert(() => externalPubRefSpec({ code: code.trim(), title: title.trim() })); }}>
          <Field label="Publication code">{(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value)} maxLength={120} />}</Field>
          <Field label="Title">{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />}</Field>
          <Button type="submit" variant="primary" disabled={!code.trim() && !title.trim()}>Insert reference</Button>
        </form>
      </TabPanel>
    </Dialog>
  );
}

/*
  A figure in one step: a title, and artwork chosen from the project's
  graphics or uploaded now under a suggested ICN (it lands where the PDF
  build looks for it). The figure gets an id, so it can be referred to.
*/
export function FigureDialog({ projectId, onInsert, onClose }) {
  const [list, setList] = useState(null);
  const [icn, setIcn] = useState('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState(null);
  const [newIcn, setNewIcn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);
  useEffect(() => {
    get(`/api/projects/${projectId}/graphics`).then((r) => setList(r.graphics)).catch((e) => setError(e));
    get(`/api/projects/${projectId}/graphics/next-icn`).then((r) => setNewIcn(r.icn)).catch(() => {});
  }, [projectId]);
  async function submit(e) {
    e.preventDefault();
    setError(null);
    let chosen = icn;
    let format = chosen && list ? (list.find((g) => g.icn === chosen) || {}).format : null;
    if (file) {
      setBusy(true);
      try {
        const r = await postForm(`/api/projects/${projectId}/graphics`, { icn: newIcn.trim() }, file);
        chosen = r.icn;
        format = (/\.(png|jpe?g|gif)$/i.exec(r.file || '') || [])[1];
      } catch (err) { setError(err); setBusy(false); return; }
      setBusy(false);
    }
    if (!chosen) { setError({ message: 'Choose artwork, or upload an image.' }); return; }
    // The graphic's ICN must be declared as an entity in the module's DOCTYPE to be valid S1000D (decisions.md PV7).
    onInsert((p) => { declareEntity(p, chosen, String(format || 'png').toLowerCase()); return figureSpec({ id: newId(p.doc, 'fig'), title: title.trim() || 'Figure', icn: chosen }); });
  }
  return (
    <Dialog open onClose={() => !busy && onClose()} title="Insert a figure" size="md"
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="figure-form" variant="primary" loading={busy}>Insert figure</Button></>}>
      <form id="figure-form" onSubmit={submit} className="space-y-4" data-testid="figure-form">
        {error ? <Alert title="Not inserted">{error.message}</Alert> : null}
        <Field label="Title">{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} autoFocus />}</Field>
        <Field label="Artwork in this project">
          {(p) => (list === null ? <LoadingBlock rows={1} /> : (
            <Select {...p} value={icn} onChange={(e) => { setIcn(e.target.value); if (e.target.value) setFile(null); }} disabled={!!file}>
              <option value="">{list.length ? 'Choose…' : 'None yet'}</option>
              {list.filter((g) => g.present).map((g) => <option key={g.icn} value={g.icn}>{g.icn}{g.title ? ` – ${g.title}` : ''}</option>)}
            </Select>
          ))}
        </Field>
        <div className="rounded-md border border-line p-3 space-y-2">
          <p className="text-[12.5px] text-ink-2">Or upload an image (PNG, JPEG or GIF) as a new graphic:</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon="upload" onClick={() => input.current && input.current.click()}>Choose image</Button>
            <input ref={input} type="file" accept="image/png,image/jpeg,image/gif" className="sr-only" tabIndex={-1} aria-label="Image to upload"
              onChange={(e) => { setFile(e.target.files[0] || null); if (e.target.files[0]) setIcn(''); e.target.value = ''; }} />
            <span className="text-[12.5px] text-ink-3 truncate">{file ? file.name : 'No file chosen'}</span>
          </div>
          {file ? <Field label="ICN for the new graphic">{(p) => <Input {...p} value={newIcn} onChange={(e) => setNewIcn(e.target.value)} className="font-mono" />}</Field> : null}
        </div>
      </form>
    </Dialog>
  );
}

// A CALS table with the shape asked for; it gets an id, so it can be referred to.
export function TableDialog({ onInsert, onClose }) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [header, setHeader] = useState(true);
  const [title, setTitle] = useState('');
  const ok = rows >= 1 && rows <= 100 && cols >= 1 && cols <= 20;
  return (
    <Dialog open onClose={onClose} title="Insert a table" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="table-form" variant="primary" disabled={!ok}>Insert table</Button></>}>
      <form id="table-form" className="space-y-3" data-testid="table-form"
        onSubmit={(e) => { e.preventDefault(); if (ok) onInsert((p) => tableSpec({ id: newId(p.doc, 'tab'), title: title.trim(), rows, cols, header })); }}>
        <Field label="Title (optional)">{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Rows">{(p) => <Input {...p} type="number" min={1} max={100} value={rows} onChange={(e) => setRows(Number(e.target.value))} />}</Field>
          <Field label="Columns">{(p) => <Input {...p} type="number" min={1} max={20} value={cols} onChange={(e) => setCols(Number(e.target.value))} />}</Field>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />Header row</label>
        {!ok ? <p className="text-[12px] text-danger">Between 1 and 100 rows and 1 and 20 columns.</p> : null}
      </form>
    </Dialog>
  );
}

/*
  The identification and status section (decisions.md PV12): titles, issue,
  date, language and security, checked before anything changes. The data
  module code is shown but not edited here: it is the module's identity and
  its file name.
*/
export function IdentDialog({ doc, model, dmc, onSave, onClose }) {
  const current = useMemo(() => identOf(doc), [doc]);
  const [values, setValues] = useState(current ? current.values : {});
  const [tried, setTried] = useState(false);
  if (!current) return null;
  const bad = checkIdent(values, model, current);
  const set = (k) => (e) => setValues({ ...values, [k]: e.target.value });
  const classes = (model && model.attributesOf('security').securityClassification) || [];
  const err = (k) => (tried ? bad[k] : undefined);
  return (
    <Dialog open onClose={onClose} title="Identification and status" size="md" description={`DMC-${dmc}: the code is the module's identity and file name; change it in the XML view.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="ident-form" variant="primary">Apply</Button></>}>
      <form id="ident-form" className="space-y-3" data-testid="ident-form" noValidate
        onSubmit={(e) => { e.preventDefault(); setTried(true); if (!Object.keys(bad).length) onSave(values); }}>
        {tried && Object.keys(bad).length ? <Alert title="Not applied">Correct the fields marked below.</Alert> : null}
        <Field label="Technical name" required error={err('techName')}>{(p) => <Input {...p} value={values.techName} onChange={set('techName')} maxLength={300} readOnly={!current.editable.techName} />}</Field>
        <Field label="Information name" hint="Optional." error={err('infoName')}>{(p) => <Input {...p} value={values.infoName} onChange={set('infoName')} maxLength={300} readOnly={!current.editable.infoName} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Issue number" error={err('issueNumber')}>{(p) => <Input {...p} value={values.issueNumber} onChange={set('issueNumber')} maxLength={3} inputMode="numeric" />}</Field>
          <Field label="In work" error={err('inWork')}>{(p) => <Input {...p} value={values.inWork} onChange={set('inWork')} maxLength={2} inputMode="numeric" />}</Field>
          <Field label="Issue date" error={err('issueDate')}>{(p) => <Input {...p} type="date" value={values.issueDate} onChange={set('issueDate')} />}</Field>
          <Field label="Security classification" error={err('securityClassification')}>
            {(p) => (
              <Select {...p} value={values.securityClassification} onChange={set('securityClassification')}>
                {classes.length ? classes.map((c) => <option key={c} value={c}>{c}</option>) : <option value={values.securityClassification}>{values.securityClassification}</option>}
              </Select>
            )}
          </Field>
          <Field label="Language" error={err('languageIsoCode')}>{(p) => <Input {...p} value={values.languageIsoCode} onChange={set('languageIsoCode')} maxLength={3} />}</Field>
          <Field label="Country" error={err('countryIsoCode')}>{(p) => <Input {...p} value={values.countryIsoCode} onChange={set('countryIsoCode')} maxLength={2} />}</Field>
        </div>
      </form>
    </Dialog>
  );
}
