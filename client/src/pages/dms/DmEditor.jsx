import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import { Badge, Mono } from '../../components/ui/Badge.jsx';
import { Dialog } from '../../components/ui/Dialog.jsx';
import { Alert, EmptyState, ErrorState, LoadingBlock, Spinner } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import Icon from '../../components/Icon.jsx';
import { api, get, post, put } from '../../api.js';
import BuildLog from '../../components/BuildLog.jsx';
import PdfFrame from '../../components/PdfFrame.jsx';
import SplitPane from '../../components/SplitPane.jsx';
import useLive, { useBuildLog } from '../../lib/useLive.js';
import { useAuth } from '../../auth.jsx';
import { useOverrideSession } from '../../components/OverrideSession.jsx';
import { LockBanner } from '../../components/LockBanner.jsx';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import StructuredEditor, { Inspector } from '../../editor/StructuredEditor.jsx';
import { contentModelFor } from '../../schema/contentModel.js';
import { parseXml, pathAtLine, contentProblems, elementAt } from '../../editor/xmlDoc.js';
import PageView, { Outline, activeRun, commitRunKeepingCaret } from '../../editor/PageView.jsx';
import ProjectShell from '../../components/ProjectShell.jsx';

// Monaco is large: loaded only when the XML panel is shown.
const XmlPanel = lazy(() => import('../../editor/XmlPanel.jsx'));
const VIEW_KEY = 'agastya-editor-view';
/*
  Views (checkpoint 2d, decisions.md PV1): Design (the page), Tags (the
  element blocks with their tags), Split (the last of those two beside the
  XML) and XML. All four edit the same XML text.
*/
const VIEWS = [['design', 'Design'], ['tags', 'Tags'], ['split', 'Split'], ['xml', 'XML']];
const DOC_VIEW_KEY = 'agastya-editor-docview';

/*
  Data module editor (checkpoint 2c): a structured, schema-aware document
  view with an element inspector, and the Monaco XML panel, alone or side by
  side. Both edit the same XML text, which is what is saved (revision-based
  conflict detection), validated (XSD + BREX), previewed as PDF, kept in the
  revision history and autosaved as a draft. A notice appears when someone
  else saves the module, and a locked module is read-only.
*/

function Findings({ result, onJump }) {
  if (!result) return <p className="px-5 pb-5 text-[13px] text-ink-3">Run Validate to check the module against its S1000D schema and the project BREX.</p>;
  const errors = result.findings.filter((f) => f.sev === 'error');
  const infos = result.findings.filter((f) => f.sev !== 'error');
  return (
    <div className="px-5 pb-5 space-y-3">
      <div className="flex flex-wrap gap-2 text-[13px]">
        {result.valid ? <Badge tone="ok" icon="checkCircle">Valid</Badge> : <Badge tone="danger" icon="alert">{errors.length} problem{errors.length === 1 ? '' : 's'}</Badge>}
        <span className="text-ink-3">Schema: {result.schema || 'not checked'}</span>
        <span className="text-ink-3">BREX: {result.brex.source ? `${result.brex.evaluated} rules evaluated` : 'not checked'}</span>
      </div>
      {errors.length ? (
        <ul className="divide-y divide-line rounded-md border border-line max-h-72 overflow-y-auto">
          {errors.map((f, i) => (
            <li key={i}>
              <button type="button" onClick={() => onJump(f.line)} className="w-full text-left flex gap-2 px-3 py-2 hover:bg-surface-2 text-[13px]">
                <Badge tone={f.kind === 'brex' ? 'warn' : 'danger'}>{f.kind === 'brex' ? 'BREX' : 'XSD'}</Badge>
                <span className="font-mono text-[12px] text-ink-3 shrink-0">L{f.line}</span>
                <span className="text-ink-2 min-w-0">{f.message}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {infos.map((f, i) => <p key={i} className="text-[12px] text-ink-3 flex gap-1.5"><Icon name="info" size={14} className="mt-0.5" />{f.message}</p>)}
    </div>
  );
}

export default function DmEditor() {
  const { id, dmId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [view, setViewState] = useState(() => {
    let v = null;
    try { v = localStorage.getItem(VIEW_KEY); } catch { v = null; }
    if (v === 'document') v = 'tags'; // the 2c name of the tag view
    return VIEWS.some(([x]) => x === v) ? v : 'design';
  });
  const [docView, setDocView] = useState(() => { try { return localStorage.getItem(DOC_VIEW_KEY) === 'tags' ? 'tags' : 'design'; } catch { return 'design'; } });
  const setView = (v) => {
    setViewState(v);
    if (v === 'design' || v === 'tags') { setDocView(v); try { localStorage.setItem(DOC_VIEW_KEY, v); } catch { /* storage blocked */ } }
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage blocked */ }
  };
  const shownDoc = view === 'split' ? docView : view;
  const [selected, setSelected] = useState(null);
  const [showTags, setShowTags] = useState(true);
  // Tags view display preferences, kept per browser (decisions.md PV22).
  const [showAttrs, setShowAttrsState] = useState(() => { try { return localStorage.getItem('agastya.tags.attrs') === '1'; } catch { return false; } });
  const [hiddenTags, setHiddenTagsState] = useState(() => { try { const v = JSON.parse(localStorage.getItem('agastya.tags.hidden') || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[A-Za-z][\w.-]*$/.test(x)).slice(0, 100) : []; } catch { return []; } });
  const setShowAttrs = (v) => { setShowAttrsState(v); try { localStorage.setItem('agastya.tags.attrs', v ? '1' : '0'); } catch { /* storage blocked */ } };
  const setHiddenTags = (v) => { setHiddenTagsState(v); try { localStorage.setItem('agastya.tags.hidden', JSON.stringify(v)); } catch { /* storage blocked */ } };
  const [history, setHistory] = useState({ undo: [], redo: [] });
  const [revealLine, setRevealLine] = useState(null);
  const problemsRef = useRef([]);
  const [editing, setEditing] = useState(false); // the caret is in a text run of the Design or Tags view
  const [state, setState] = useState({ loading: true });
  const [xml, setXml] = useState('');
  const [base, setBase] = useState(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [validation, setValidation] = useState(null);
  const [revisions, setRevisions] = useState(null);
  const [viewRev, setViewRev] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftSavedAt, setDraftSavedAt] = useState(null);
  const [newer, setNewer] = useState(null);
  const [preview, setPreview] = useState(null);
  // Where the PDF is (decisions.md SW1): below the editor, beside it, or alone; kept per viewer.
  const [layout, setLayoutState] = useState(() => { try { const v = localStorage.getItem('agastya.editor.layout'); return ['editor', 'beside', 'pdf'].includes(v) ? v : 'editor'; } catch { return 'editor'; } });
  const setLayout = (v) => { setLayoutState(v); try { localStorage.setItem('agastya.editor.layout', v); } catch { /* not kept */ } };
  const [autoRefresh, setAutoRefreshState] = useState(() => { try { return localStorage.getItem('agastya.editor.autoRefresh') !== '0'; } catch { return true; } });
  const setAutoRefresh = (v) => { setAutoRefreshState(v); try { localStorage.setItem('agastya.editor.autoRefresh', v ? '1' : '0'); } catch { /* not kept */ } };
  const [refreshTick, setRefreshTick] = useState(0);
  const [pages, setPages] = useState(null);
  const [validatedXml, setValidatedXml] = useState(null);
  const [modules, setModules] = useState([]);
  const draftTimer = useRef(null);
  const { me } = useAuth();
  const draftUrl = `/api/projects/${id}/drafts/dm-${dmId}`;
  // The administrator edits a module only inside an override session with a reason (decisions.md V3).
  const ov = useOverrideSession({
    projectId: id, docKey: `dm-${dmId}`, label: 'this data module',
    enabled: !!(state.perms && state.perms.override) && !(state.module && state.module.deletedAt),
  });
  const readOnly = state.loading || !state.perms || state.serverReadOnly || !(state.perms.write || ov.active) || (!!state.lock && !ov.active);
  const keepsDrafts = !!(state.perms && state.perms.drafts);

  const load = useCallback(async () => {
    setState({ loading: true });
    try {
      const [p, d] = await Promise.all([get(`/api/projects/${id}`), get(`/api/projects/${id}/dms/${dmId}`)]);
      setState({ loading: false, project: p.project, perms: p.permissions, module: d.module, serverReadOnly: !!d.readOnly, lock: d.lock || null, revBy: d.revisionBy, revAt: d.revisionAt });
      setXml(d.xml); setSaved(d.xml); setBase(d.revision); setValidation(null); setRevisions(null); setNewer(null); setDraftSavedAt(null);
      setSelected(null); setHistory({ undo: [], redo: [] });
      // The project's other modules, for references to them (decisions.md PV6).
      get(`/api/projects/${id}/dms`).then((r) => setModules(r.modules.filter((x) => x.id !== dmId && !x.deletedAt)
        .map((x) => ({ id: x.id, dmc: x.dmc, techName: x.techName, infoName: x.infoName, title: `${x.techName}${x.infoName ? ` – ${x.infoName}` : ''}` })))).catch(() => setModules([]));
      if (p.permissions.drafts && !d.readOnly) {
        try { const dr = (await get(`/api/projects/${id}/drafts/dm-${dmId}`)).draft; setDraft(dr && dr.content !== d.xml ? dr : null); } catch { setDraft(null); }
      } else setDraft(null);
    } catch (e) { setState({ loading: false, error: e }); }
  }, [id, dmId]);

  /*
    A save made elsewhere (another person, or this user in another tab): say
    so now, before a save from here would be refused. A revision newer than
    the one this editor is based on is the test; this tab's own save in
    flight is ignored.
  */
  const baseRef = useRef(null);
  baseRef.current = base;
  const savingRef = useRef(false);
  useLive(id, {
    onContent: (e) => {
      if (e.docId !== dmId || savingRef.current) return;
      if (e.action === 'dm.saved') { if (!e.revision || (baseRef.current && e.revision <= baseRef.current)) return; }
      else if (!['dm.deleted', 'dm.restored'].includes(e.action)) return;
      setNewer({ by: e.byId === me.user.id ? 'You (in another tab or window)' : e.by, revision: e.revision, action: e.action });
    },
  });
  const { log: previewLog, setLog: setPreviewLog } = useBuildLog(id, (e) => e.kind === 'preview' && state.module && e.target === state.module.dmc);
  useEffect(() => { load(); }, [load]);
  // "Recently opened" (the dashboard's redesigned list): once per project, not per module switched within it.
  useEffect(() => { post(`/api/projects/${id}/opened`, {}).catch(() => {}); }, [id]);

  const dirty = xml !== saved;
  // Autosave unsaved work as this user's draft, two seconds after the last keystroke.
  useEffect(() => {
    if (readOnly || !keepsDrafts || !dirty || !base) return undefined;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      put(draftUrl, { content: xml, baseRevision: base }).then((r) => setDraftSavedAt(r.savedAt)).catch(() => { /* retried on the next change */ });
    }, 2000);
    return () => clearTimeout(draftTimer.current);
  }, [xml, dirty, base, readOnly, keepsDrafts, draftUrl]);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useCallback(async () => {
    if (readOnly || !dirty || busy) return;
    setBusy('save'); setSaveError(null);
    savingRef.current = true;
    try {
      const r = await put(`/api/projects/${id}/dms/${dmId}`, { xml, baseRevision: base });
      baseRef.current = r.revision;
      clearTimeout(draftTimer.current);
      setBase(r.revision); setSaved(xml); setDraft(null); setDraftSavedAt(null); setNewer(null);
      setState((s) => ({ ...s, module: r.module, revBy: 'you', revAt: new Date().toISOString() }));
      setRevisions(null);
      toast.success('Saved', 'A new revision was recorded.');
      // The PDF beside the editor follows saves, never keystrokes (decisions.md SW2).
      if (layoutRef.current !== 'editor' && autoRefreshRef.current) setRefreshTick((n) => n + 1);
    } catch (e) {
      if (e.code === 'CONFLICT') {
        // The refused text is kept as the user's draft now, not when the autosave timer would have fired (decisions.md B11).
        clearTimeout(draftTimer.current);
        if (keepsDrafts) await put(draftUrl, { content: xml, baseRevision: base }).catch(() => { /* the conflict dialog still offers to copy it */ });
        setConflict(e.body.conflict);
      } else setSaveError(e);
    }
    savingRef.current = false;
    setBusy(null);
  }, [readOnly, dirty, busy, id, dmId, xml, base, toast, keepsDrafts, draftUrl]);

  /*
    Ctrl+S and the Save button: text still being typed in the Design or Tags
    view is committed first (its run is left, which records it; in the
    Design view the caret then goes back, so typing goes on). Changes still
    on their way, such as a reference's issue being read (`track`), are
    waited for, at most 5 seconds. The save then runs after the next render,
    on the text that includes all of them.
  */
  const saveRef = useRef(save);
  saveRef.current = save;
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const autoRefreshRef = useRef(autoRefresh); autoRefreshRef.current = autoRefresh;
  const previewRef = useRef(null);
  const keysRef = useRef({});
  const pendingRef = useRef(new Set());
  const track = useCallback((promise) => {
    const done = Promise.resolve(promise).then(() => {}, () => {});
    pendingRef.current.add(done);
    done.then(() => pendingRef.current.delete(done));
  }, []);
  const [saveAsked, setSaveAsked] = useState(0);
  const saveQueued = useRef(false);
  const saveNow = useCallback(() => {
    if (saveQueued.current) return;
    saveQueued.current = true;
    if (!commitRunKeepingCaret()) {
      const a = document.activeElement;
      if (a && a.isContentEditable) a.blur();
    }
    const pending = [...pendingRef.current];
    const wait = pending.length ? Promise.race([Promise.all(pending), new Promise((res) => setTimeout(res, 5000))]) : Promise.resolve();
    wait.then(() => setTimeout(() => setSaveAsked((n) => n + 1), 0));
  }, []);
  useEffect(() => {
    if (!saveAsked) return;
    saveQueued.current = false;
    saveRef.current();
  }, [saveAsked]);
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); saveNow(); return; }
      // Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) undo the editor's edits; typing in a text box, a field or the XML panel keeps the browser's own undo.
      const t = e.target;
      if (k !== 'z' && k !== 'y') return;
      // A text run of the page with nothing typed in it yet: the editor's history applies there too.
      const idleRun = t && t.isContentEditable && t.dataset && t.dataset.run !== undefined && t.dataset.typed !== '1';
      const own = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || (t.closest && (t.closest('.monaco-editor') || t.closest('dialog'))) || (t.isContentEditable && !idleRun));
      if (own) return;
      const redo = k === 'y' || e.shiftKey;
      const fn = keysRef.current[redo ? 'redo' : 'undo'];
      if (!fn) return;
      e.preventDefault();
      if (idleRun) t.blur(); // released first, so the run shows the restored text
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveNow]);

  async function validate() {
    setBusy('validate');
    const checked = xml;
    try { setValidation(await post(`/api/projects/${id}/dms/${dmId}/validate`, { xml: checked })); setValidatedXml(checked); } catch (e) { toast.error('Validation failed', e.message); }
    setBusy(null);
  }

  async function buildPreview() {
    if (dirty) { toast.info('Save first', 'The preview is built from the saved module.'); return; }
    setBusy('preview'); setPreviewLog(null); setPreview((p) => (p ? { ...p, error: null } : null));
    try {
      const res = await fetch(`/api/projects/${id}/dms/${dmId}/preview`, { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        let b = null;
        try { b = await res.json(); } catch { b = null; }
        throw Object.assign(new Error((b && b.error) || `Preview failed (${res.status}).`), { body: b });
      }
      setPreview({ version: Date.now(), ms: Number(res.headers.get('X-Build-Ms')) || null, revision: baseRef.current || base });
    } catch (e) {
      setPreview({ error: e });
    }
    setBusy(null);
  }

  previewRef.current = buildPreview;
  // After a save: once the saved text is the editor's text again, build it.
  useEffect(() => { if (refreshTick) previewRef.current(); }, [refreshTick]);
  // The pages' text of the preview, for going to the page of what is selected (SW3).
  useEffect(() => {
    if (!preview || !preview.version || layout === 'editor') { setPages(null); return; }
    let live = true;
    get(`/api/projects/${id}/dms/${dmId}/preview/pages`).then((r) => { if (live) setPages(r.pages); }).catch(() => { if (live) setPages(null); });
    return () => { live = false; };
  }, [preview && preview.version, layout, id, dmId]); // eslint-disable-line react-hooks/exhaustive-deps
  const pdfPage = useMemo(() => {
    if (!pages || !selected || !Array.isArray(selected.path)) return null;
    const p = parseXml(xml);
    if (p.error) return null;
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const hay = pages.map(norm);
    // The selected element's own title, else its text; then its ancestors', nearest first.
    for (let path = selected.path, n = 0; path && n < 6; path = path.length ? path.slice(0, -1) : null, n++) {
      const el = elementAt(p.doc, path);
      if (!el) continue;
      const title = Array.from(el.childNodes).find((c) => c.nodeType === 1 && c.nodeName === 'title');
      for (const cand of [title && title.textContent, el.textContent]) {
        const t = norm(cand);
        if (t.length < 4) continue;
        for (const len of [60, 30]) {
          const needle = t.slice(0, len);
          const at = hay.findIndex((h) => h.includes(needle));
          if (at >= 0) return { page: at + 1, of: pages.length, text: needle };
        }
      }
    }
    return null;
  }, [pages, selected, xml]);

  async function openRevisions() {
    try { setRevisions((await get(`/api/projects/${id}/dms/${dmId}/revisions`)).revisions); } catch (e) { toast.error('Could not load history', e.message); }
  }

  /*
    A finding's line: the element it is about is selected on the page (while
    the text is what was validated), and the line is shown in the XML panel
    when it is open; otherwise the XML is opened beside the page.
  */
  function jump(line) {
    const path = validatedXml === xml ? pathAtLine(parseXml(xml), line) : null;
    // The element is selected on the page (Design or Tags), and the line is shown beside it in the XML (as in 2c).
    if (path && view !== 'xml') setSelected({ path, caret: null, scroll: true });
    if (view === 'design' || view === 'tags') setView('split');
    setRevealLine({ line, at: Date.now() });
  }
  // The last validation's findings on the elements they are about, while the text is unchanged since.
  const pageFindings = useMemo(() => {
    if (!validation || validatedXml !== xml) return [];
    const p = parseXml(xml);
    if (p.error) return [];
    return validation.findings.filter((f) => f.sev === 'error' && f.line).map((f) => ({ ...f, path: pathAtLine(p, f.line) })).filter((f) => f.path);
  }, [validation, validatedXml, xml]);

  // A structured edit: the new text, with one undo step.
  const structuredChange = useCallback((next) => {
    setHistory((h) => ({ undo: [...h.undo.slice(-99), xml], redo: [] }));
    setXml(next);
  }, [xml]);
  const undo = () => setHistory((h) => {
    if (!h.undo.length) return h;
    const prev = h.undo[h.undo.length - 1];
    setXml(prev);
    return { undo: h.undo.slice(0, -1), redo: [...h.redo, xml] };
  });
  const redo = () => setHistory((h) => {
    if (!h.redo.length) return h;
    const next = h.redo[h.redo.length - 1];
    setXml(next);
    return { undo: [...h.undo, xml], redo: h.redo.slice(0, -1) };
  });
  keysRef.current = readOnly || view === 'xml' ? {} : { undo: history.undo.length ? undo : null, redo: history.redo.length ? redo : null };

  const model = useMemo(() => (state.module ? contentModelFor(state.module.issue, state.module.schemaType) : null), [state.module]);
  // The element selected in the Tags view, for "Hide <x> tags".
  const selectedName = useMemo(() => {
    if (!selected || !selected.path || !selected.path.length) return null;
    const p = parseXml(xml);
    const el = p.error ? null : elementAt(p.doc, selected.path);
    return el ? el.nodeName : null;
  }, [selected, xml]);
  // Content-model problems, for the inspector's list, whichever view is shown.
  const problems = useMemo(() => { const p = parseXml(xml); return p.error || !model ? [] : contentProblems(p.doc, model); }, [xml, model]);
  // Markers for the XML panel: a parse error, else the last validation's findings.
  const markers = useMemo(() => {
    const p = parseXml(xml);
    if (p.error) return [{ line: p.error.line, message: p.error.message, severity: 'error' }];
    return validation ? validation.findings.filter((f) => f.sev === 'error' && f.line).map((f) => ({ line: f.line, message: `${f.kind === 'brex' ? 'BREX' : 'XSD'}: ${f.message}`, severity: f.kind === 'brex' ? 'warning' : 'error' })) : [];
  }, [xml, validation]);

  if (state.loading) return <Card className="p-6"><LoadingBlock rows={8} /></Card>;
  if (state.error) return <Card>{state.error.status === 404 ? <EmptyState icon="file" title="Data module not found">It does not exist, or it is not in a project you can see.</EmptyState> : <ErrorState error={state.error} onRetry={load} />}</Card>;
  const m = state.module;

  return (
    <ProjectShell project={state.project} active="dms" caps={{ dataModules: true, builder: true }} canDelete={!!(state.perms && state.perms.delete)}>
      <header className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <p className="font-mono text-[12.5px] text-ink-2">DMC-{m.dmc}</p>
          <h1 className="text-[20px] font-semibold text-ink">{m.techName}{m.infoName ? <span className="text-ink-3 font-normal"> – {m.infoName}</span> : null}</h1>
          <p className="text-[13px] text-ink-3 mt-1 flex flex-wrap items-center gap-2">
            <Badge>{m.schemaType}</Badge>{m.issue ? <Badge>S1000D {m.issue}</Badge> : null}
            <span>{state.revAt ? `saved ${fmtRelative(state.revAt)}${state.revBy ? ` by ${state.revBy}` : ''}` : 'not saved yet'}</span>
            {m.deletedAt ? <Badge tone="danger" icon="trash">Deleted</Badge> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {modules.length ? (
            <select aria-label="Switch to another data module" value="" onChange={(e) => { if (e.target.value) nav(`/projects/${id}/dms/${e.target.value}`); }}
              className="h-8 rounded-md border border-line-strong bg-surface px-2 text-[12.5px] text-ink-2 max-w-[11rem]">
              <option value="">Switch module…</option>
              {modules.slice().sort((a, b) => a.dmc.localeCompare(b.dmc)).map((mm) => <option key={mm.id} value={mm.id}>{mm.dmc}</option>)}
            </select>
          ) : null}
          <Button icon="list" onClick={openRevisions}>History</Button>
          <Button icon="checkCircle" onClick={validate} loading={busy === 'validate'}>Validate</Button>
          <div role="radiogroup" aria-label="Layout" className="flex items-center rounded-md border border-line p-0.5 bg-surface">
            {[['editor', 'Editor'], ['beside', 'Beside'], ['pdf', 'PDF']].map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={layout === v} onClick={() => setLayout(v)}
                className={`px-2.5 py-1 rounded text-[12.5px] font-medium ${layout === v ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:text-ink'}`}>{label}</button>
            ))}
          </div>
          <Button icon="book" onClick={buildPreview} loading={busy === 'preview'} disabled={!!m.deletedAt}>Preview PDF</Button>
          {!readOnly ? <Button variant="primary" icon="check" onMouseDown={(e) => e.preventDefault()} onClick={saveNow} loading={busy === 'save'} disabled={!dirty && !editing}>{dirty || editing ? 'Save' : 'Saved'}</Button> : null}
        </div>
      </header>

      {draft && !readOnly ? (
        <Alert tone="info" className="mb-4" title="You have an unsaved draft of this module">
          Autosaved {fmtRelative(draft.updatedAt)}{draft.baseRevision && draft.baseRevision !== base ? `, from revision ${draft.baseRevision} (the module has been saved since; check before you save)` : ''}.
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" onClick={() => { setXml(draft.content); setDraft(null); toast.info('Draft restored', 'Save to make it the current version.'); }}>Restore draft</Button>
            <Button size="sm" variant="ghost" onClick={async () => { try { await api(draftUrl, { method: 'DELETE' }); } catch { /* gone */ } setDraft(null); }}>Discard draft</Button>
          </div>
        </Alert>
      ) : null}
      {newer ? (
        <Alert tone="warn" className="mb-4" title={newer.action === 'dm.deleted' ? `${newer.by || 'Someone'} deleted this module` : `${newer.by || 'Someone'} saved a newer version`}>
          {newer.revision ? `Revision ${newer.revision}. ` : ''}{dirty ? 'Saving now will be refused; your text is kept in your draft.' : 'Load it to see their changes.'}
          <div className="mt-2"><Button size="sm" icon="refresh" onClick={load}>Load the latest version</Button></div>
        </Alert>
      ) : null}
      {ov.bar ? <div className="mb-4">{ov.bar}</div> : null}
      {state.lock ? <LockBanner lock={state.lock} override={ov.active} what="This data module" className="mb-4" /> : null}
      {readOnly && !state.lock && !(state.perms && state.perms.override && !m.deletedAt) ? <Alert tone="info" className="mb-4">{m.deletedAt ? 'This data module is deleted. Restore it from the list to edit it.' : 'You can read this data module but not edit it.'}</Alert> : null}
      {saveError ? <Alert className="mb-4" title="Not saved">{saveError.message}{saveError.body && saveError.body.line ? ' ' : ''}{saveError.body && saveError.body.line ? <button type="button" className="underline" onClick={() => jump(saveError.body.line)}>Go to line {saveError.body.line}</button> : null}</Alert> : null}

      <SplitPane mode={layout === 'editor' ? 'fixed' : layout === 'pdf' ? 'right' : 'split'} storageKey="agastya.editor.split" label="Resize the editor and the PDF" left={(
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-line bg-surface-2 text-[12px] text-ink-3">
            <div role="radiogroup" aria-label="Editor view" className="flex items-center rounded-md border border-line p-0.5 bg-surface">
              {VIEWS.map(([v, label]) => (
                <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}
                  className={`px-2.5 py-1 rounded text-[12.5px] font-medium ${view === v ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:text-ink'}`}>{label}</button>
              ))}
            </div>
            <span className="flex items-center gap-2">
              {view !== 'xml' ? (
                <>
                  {shownDoc === 'tags' ? (
                    <>
                      <label className="flex items-center gap-1.5 text-ink-2"><input type="checkbox" checked={showTags} onChange={(e) => setShowTags(e.target.checked)} />Tags</label>
                      <label className="flex items-center gap-1.5 text-ink-2"><input type="checkbox" checked={showAttrs} onChange={(e) => setShowAttrs(e.target.checked)} />Attributes</label>
                      {selectedName && !hiddenTags.includes(selectedName) ? <Button size="sm" variant="ghost" data-testid="hide-tags" onClick={() => setHiddenTags([...hiddenTags, selectedName])}>Hide &lt;{selectedName}&gt; tags</Button> : null}
                      {hiddenTags.map((n) => <Button key={n} size="sm" variant="ghost" title={`Show <${n}> tags again`} data-testid="show-tags" onClick={() => setHiddenTags(hiddenTags.filter((x) => x !== n))}>Show &lt;{n}&gt;</Button>)}
                    </>
                  ) : null}
                  {!readOnly ? (
                    <>
                      <Button size="sm" variant="ghost" icon="undo" onClick={undo} disabled={!history.undo.length} aria-label="Undo the last edit">Undo</Button>
                      <Button size="sm" variant="ghost" onClick={redo} disabled={!history.redo.length} aria-label="Redo">Redo</Button>
                    </>
                  ) : null}
                </>
              ) : null}
              <span className="font-mono tabular" data-testid="editor-status">{model ? model.key : ''}{dirty ? ' · unsaved' : ''}{dirty && draftSavedAt ? ' · draft autosaved' : ''}</span>
            </span>
          </div>
          <div className={view === 'split' ? 'grid lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-line' : ''}
            onFocus={(e) => setEditing(!!e.target.isContentEditable)} onBlur={() => setEditing(false)}>
            {view !== 'xml' && shownDoc === 'design' ? (
              <div className="h-[62vh] min-h-80 overflow-auto bg-surface" data-testid="design-view">
                <PageView xml={xml} onChange={structuredChange} readOnly={readOnly} model={model} selected={selected} onSelect={setSelected}
                  projectId={id} findings={pageFindings} modules={modules}
                  app={{ track, undo, redo, canUndo: !readOnly && history.undo.length > 0, canRedo: !readOnly && history.redo.length > 0, validate, preview: buildPreview, view, setView, title: state.module ? `DMC-${state.module.dmc}` : '' }} />
              </div>
            ) : null}
            {view !== 'xml' && shownDoc === 'tags' ? (
              <div className="h-[62vh] min-h-80 overflow-auto bg-surface">
                <StructuredEditor xml={xml} onChange={structuredChange} readOnly={readOnly} model={model}
                  selected={selected} onSelect={setSelected} showTags={showTags} problemsRef={problemsRef} showAttrs={showAttrs} hiddenTags={hiddenTags} />
              </div>
            ) : null}
            {view === 'split' || view === 'xml' ? (
              <Suspense fallback={<div className="h-[62vh] grid place-items-center text-ink-3"><Spinner label="Loading the XML panel" /></div>}>
                <div className="min-w-0" data-readonly={readOnly ? 'true' : 'false'}>
                  <XmlPanel value={xml} onChange={setXml} readOnly={readOnly} contentModel={model} markers={markers} revealLine={revealLine} />
                </div>
              </Suspense>
            ) : null}
          </div>
        </Card>
      )} right={(
        <div className="space-y-6">
          {layout !== 'editor' ? (
            <PdfPane src={`/api/projects/${id}/dms/${dmId}/preview.pdf`} title={`Preview of DMC-${m.dmc}`} preview={preview} building={busy === 'preview'}
              dirty={dirty} savedRevision={base} autoRefresh={autoRefresh} setAutoRefresh={setAutoRefresh} onRefresh={buildPreview} page={pdfPage}
              onEditorOnly={() => setLayout('editor')} layout={layout} />
          ) : null}
          {view !== 'xml' ? (
            <Card>
              <CardHeader title="Outline" subtitle="Paragraphs, steps, figures and tables" />
              <Outline xml={xml} onSelect={setSelected} />
            </Card>
          ) : null}
          {view !== 'xml' ? (
            <Card>
              <CardHeader title="Element" subtitle={readOnly ? 'Read-only' : 'Attributes and what the schema allows here'} />
              <Inspector xml={xml} onChange={structuredChange} readOnly={readOnly} model={model} selected={selected} onSelect={setSelected} problems={problems} />
            </Card>
          ) : null}
          {previewLog || preview ? (
            <Card>
              <CardHeader title="Preview" subtitle="This module alone, without front matter" />
              <div className="px-5 pb-5 space-y-3">
                <BuildLog log={previewLog} title="Building the preview" />
                {preview && preview.version ? <p className="text-[13px] text-ok">Built{preview.ms ? ` in ${(preview.ms / 1000).toFixed(1)} s` : ''}; {layout === 'editor' ? 'shown below the editor' : 'shown in the PDF pane'}.</p> : null}
                {preview && preview.error ? <Alert title="The preview failed">{preview.error.message}{preview.error.body && preview.error.body.hint ? <p className="mt-1">{preview.error.body.hint}</p> : null}</Alert> : null}
              </div>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Validation" subtitle="XSD for the declared S1000D issue, then the project BREX" />
            <Findings result={validation} onJump={jump} />
          </Card>
          <Card>
            <CardHeader title="Details" />
            <dl className="px-5 pb-5 text-[13px] space-y-2">
              <div className="flex justify-between gap-3"><dt className="text-ink-3">File</dt><dd><Mono>csdb/{m.file}</Mono></dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink-3">Status</dt><dd>{m.status.replace('_', ' ')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink-3">Created</dt><dd>{fmtDateTime(m.createdAt)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink-3">Updated</dt><dd>{fmtDateTime(m.updatedAt)}{m.updatedBy ? ` by ${m.updatedBy}` : ''}</dd></div>
            </dl>
          </Card>
        </div>
      )} />

      {layout === 'editor' && preview && preview.version ? (
        <div className="mt-6"><PdfFrame src={`/api/projects/${id}/dms/${dmId}/preview.pdf`} version={preview.version} title={`Preview of DMC-${m.dmc}`} height="80vh" onClose={() => setPreview(null)} /></div>
      ) : null}

      <Dialog open={!!conflict} onClose={() => setConflict(null)} title="Someone else saved this module" size="md"
        description={conflict ? `Revision ${conflict.current} was saved ${conflict.updatedAt ? fmtRelative(conflict.updatedAt) : ''}${conflict.updatedBy ? ` by ${conflict.updatedBy}` : ''} after you opened it. Your changes were not saved.` : ''}
        footer={<>
          <Button onClick={async () => { try { await navigator.clipboard.writeText(xml); toast.success('Your XML is on the clipboard'); } catch { toast.error('Could not copy'); } }} icon="copy">Copy my XML</Button>
          <Button variant="primary" icon="refresh" onClick={() => { setConflict(null); load(); }}>Load the latest version</Button>
        </>}>
        <p className="text-ink-2">Your text is kept as your draft (and you can copy it now). Load the latest version, then restore your draft or apply your changes again. Nothing is merged automatically.</p>
      </Dialog>

      <Dialog open={!!revisions} onClose={() => setRevisions(null)} title="Revision history" size="lg" description="Every save is kept and cannot be changed.">
        {revisions ? (
          <ul className="divide-y divide-line rounded-md border border-line max-h-[60vh] overflow-y-auto">
            {revisions.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
                <span className="font-mono tabular text-ink">#{r.id}</span>
                <span className="text-ink-2 flex-1 min-w-0">{r.reason}{r.by ? ` · ${r.by}` : ''}</span>
                <span className="text-ink-3">{fmtDateTime(r.createdAt)}</span>
                <Button size="sm" variant="ghost" onClick={async () => {
                  try { const v = await get(`/api/projects/${id}/dms/${dmId}/revisions/${r.id}`); setViewRev(v); } catch (e) { toast.error('Could not open revision', e.message); }
                }}>View</Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Dialog>

      <Dialog open={!!viewRev} onClose={() => setViewRev(null)} size="lg" title={viewRev ? `Revision #${viewRev.revision.id}` : ''}
        description={viewRev ? `${viewRev.revision.reason}, ${fmtDateTime(viewRev.revision.createdAt)}${viewRev.revision.by ? ` by ${viewRev.revision.by}` : ''}` : ''}
        footer={!readOnly ? <Button variant="primary" onClick={() => { setXml(viewRev.xml); setViewRev(null); setRevisions(null); toast.info('Revision loaded into the editor', 'Save to make it the current version.'); }}>Load into editor</Button> : null}>
        {viewRev ? <pre className="max-h-[55vh] overflow-auto rounded-md border border-line bg-surface-2 p-3 font-mono text-[12px] text-ink whitespace-pre">{viewRev.xml}</pre> : null}
      </Dialog>
    </ProjectShell>
  );
}

/*
  The PDF beside the editor (decisions.md SW1-SW4). It shows the preview of
  the saved module and says so: which revision it was built from, whether
  the module has been saved since, and whether there are edits that are not
  in it yet. It is rebuilt after a save (when "Refresh after each save" is
  on) or with Refresh, never while typing. The page of what is selected in
  the editor is opened when its text is found in the PDF.
*/
function PdfPane({ src, title, preview, building, dirty, savedRevision, autoRefresh, setAutoRefresh, onRefresh, page, onEditorOnly, layout }) {
  const version = preview && preview.version;
  const built = preview && preview.revision;
  const state = !version ? 'none' : building ? 'building' : built !== savedRevision ? 'older' : dirty ? 'unsaved' : 'current';
  const message = {
    none: 'No preview yet. Refresh builds it from the saved module.',
    building: 'Building the preview of the saved module…',
    older: `Built from revision ${built}; the module has been saved since (revision ${savedRevision}). Refresh to update it.`,
    unsaved: `Showing the saved version (revision ${built}). Your unsaved edits are not in it: save to see them.`,
    current: `Showing the saved version (revision ${built}).`,
  }[state];
  const url = version ? `${src}?v=${version}${page ? `#page=${page.page}` : ''}` : null;
  return (
    <Card className="overflow-hidden" data-testid="pdf-pane">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-line bg-surface-2 text-[12.5px]">
        <span className="font-medium truncate">{title}</span>
        <span className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-ink-2"><input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />Refresh after each save</label>
          <Button size="sm" icon="refresh" onClick={onRefresh} loading={building}>Refresh</Button>
          {url ? <a href={url} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-accent hover:underline"><Icon name="eye" size={14} />Open alone</a> : null}
          {layout === 'pdf' ? <Button size="sm" variant="ghost" onClick={onEditorOnly}>Back to the editor</Button> : null}
        </span>
      </div>
      <p data-testid="pdf-status" data-state={state} className={`px-3 py-1.5 text-[12.5px] border-b border-line ${state === 'current' ? 'text-ok' : state === 'none' || state === 'building' ? 'text-ink-3' : 'text-warn'}`}>
        {message}{page ? <span data-testid="pdf-page" className="ml-2 text-ink-2">Selection on page {page.page} of {page.of}.</span> : null}
      </p>
      {preview && preview.error ? <Alert className="m-3" title="The preview failed">{preview.error.message}</Alert> : null}
      {url ? <iframe key={url} title={title} src={url} className="block w-full bg-white" style={{ height: layout === 'pdf' ? '80vh' : '72vh' }} /> : <div className="h-40 grid place-items-center text-ink-3 text-[13px]">The PDF appears here.</div>}
    </Card>
  );
}
