import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, CardHeader, DetailList, PageHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import { Badge, Mono } from '../../components/ui/Badge.jsx';
import { Field, Select, Textarea } from '../../components/ui/Field.jsx';
import OverrideDialog from '../../components/OverrideDialog.jsx';
import Tabs, { TabPanel } from '../../components/ui/Tabs.jsx';
import { Alert, EmptyState, ErrorState, LoadingBlock, Spinner } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import Icon from '../../components/Icon.jsx';
import PdfFrame from '../../components/PdfFrame.jsx';
import { ModuleStatusBadge } from '../../components/ModuleStatusBadge.jsx';
import useResource from '../../lib/useResource.js';
import { get, post } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import { RequestBadge, REQUEST_STATUS } from '../projects/ApprovalCard.jsx';
import StructuredEditor from '../../editor/StructuredEditor.jsx';
import PageView from '../../editor/PageView.jsx';
import { contentModelFor } from '../../schema/contentModel.js';

const XmlPanel = lazy(() => import('../../editor/XmlPanel.jsx'));
const noop = () => {};

const OUTCOMES = [
  ['approve', 'Approve', 'The data modules become approved.'],
  ['changes', 'Request changes', 'The data modules return to draft; the Author edits and resubmits.'],
  ['reject', 'Reject', 'The data modules return to draft.'],
];

/*
  The review screen (decisions.md M1, M2): the frozen snapshot only, never
  the live workspace. Sources are shown read-only; the decision needs a
  comment, and the server refuses it (and marks the request stale) if the
  live content no longer matches what was submitted.
*/
export default function ReviewPage() {
  const { reqId } = useParams();
  const { me } = useAuth();
  const { data, loading, error, reload } = useResource(`/api/requests/${reqId}`);
  const [tab, setTab] = useState('pdf');
  const [refused, setRefused] = useState(null); // why the last decision was not recorded (stale, decided elsewhere)

  if (error) return <ErrorState error={error} onRetry={reload} title={error.status === 404 ? 'This request was not found' : undefined} />;
  if (loading && !data) return <LoadingBlock rows={6} />;
  const r = data.request;
  const isAdmin = me.user.role === 'software_admin';

  return (
    <>
      <p className="mb-3 text-[13px]"><Link to="/approvals" className="inline-flex items-center gap-1 text-ink-3 hover:text-ink"><Icon name="arrowLeft" size={14} />Approvals</Link></p>
      <PageHeader eyebrow="Review" title={r.title || r.projectName}
        subtitle={`${r.projectName} · submitted ${fmtRelative(r.submittedAt)} by ${r.submittedBy.name}`}
        actions={<RequestBadge status={r.status} />} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <Tabs idBase="review" value={tab} onChange={setTab} tabs={[
            { value: 'pdf', label: 'PDF' },
            { value: 'sources', label: 'Sources' },
            { value: 'validation', label: 'Validation', count: r.validation.warnings || 0 },
            { value: 'history', label: 'History', count: data.history.length > 1 ? data.history.length : 0 },
          ]} />
          <TabPanel idBase="review" value="pdf" active={tab}>
            <PdfFrame src={r.snapshotPdf} title="Submitted publication (frozen)" height="75vh" />
          </TabPanel>
          <TabPanel idBase="review" value="sources" active={tab}><Sources request={r} files={data.files} modules={data.modules} /></TabPanel>
          <TabPanel idBase="review" value="validation" active={tab}><Validation request={r} /></TabPanel>
          <TabPanel idBase="review" value="history" active={tab}><History history={data.history} current={r.id} /></TabPanel>
        </div>
        <div className="space-y-6">
          {data.canOverride ? <AdminOverrides request={r} onDone={reload} onRefused={setRefused} /> : null}
          {data.overrides && data.overrides.length ? <OverrideLog overrides={data.overrides} /> : null}
          {data.canDecide ? <DecisionForm request={r} onDone={reload} onRefused={setRefused} /> : (
            <Card>
              <CardHeader title="Decision" />
              <div className="px-5 pb-5 text-[13px] space-y-2" data-testid="decision-closed">
                {refused ? <Alert title={refused.code === 'STALE' ? 'Not decided: the request is out of date' : 'Not decided'}>{refused.message}</Alert> : null}
                {r.status === 'pending'
                  ? <p className="text-ink-2">{isAdmin ? `Waiting for ${r.manager.name}. As administrator you can decide, reset or reassign it above, with a written reason.` : `Waiting for ${r.manager.name}.`}</p>
                  : <Decided request={r} />}
              </div>
            </Card>
          )}
          <Card>
            <CardHeader title="Request" />
            <div className="px-5 pb-4">
              <DetailList items={[
                ['Submitted by', r.submittedBy.name],
                ['Sent to', r.manager.name],
                ['Submitted', fmtDateTime(r.submittedAt)],
                ['Validation', `${r.validation.errors} errors, ${r.validation.warnings} warnings`],
                ['Data modules', `${data.modules.length}`],
                ['Author note', r.note || '—'],
                ...(r.previousRequestId ? [['Resubmission', 'Yes; earlier decisions are under History']] : []),
              ]} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Data modules" subtitle="Status follows the approval flow" />
            <ul className="px-5 pb-5 space-y-2 text-[13px]" data-testid="review-modules">
              {data.modules.map((m) => (
                <li key={m.id} className="flex items-start justify-between gap-2">
                  <span className="min-w-0"><span className="block truncate text-ink">{m.title}</span><Mono className="text-[11.5px]">DMC-{m.dmc}</Mono></span>
                  <ModuleStatusBadge status={m.status} />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

// An administrator override on a decision or a reset, with its reason, for the people involved (decisions.md V4, V5).
export function OverrideNote({ request: r }) {
  if (!r.override) return null;
  return (
    <div className="space-y-1" data-testid="override-note">
      <Badge tone="accent" icon="shield">Administrator override</Badge>
      {r.override.reason ? <p className="text-ink-2">Reason: <span className="text-ink">“{r.override.reason}”</span></p> : null}
    </div>
  );
}

function Decided({ request: r }) {
  if (r.status === 'stale') return <><p className="text-danger">Out of date: {r.staleReason || 'the publication changed after it was submitted'}. The Author must submit it again.</p><OverrideNote request={r} /></>;
  if (r.status === 'withdrawn') return <p className="text-ink-2">The Author withdrew this request.</p>;
  return (
    <>
      <OverrideNote request={r} />
      <p className="text-ink-2">{(REQUEST_STATUS[r.status] || {}).label} by <span className="font-medium text-ink">{r.decidedBy ? r.decidedBy.name : '—'}</span>, {fmtDateTime(r.decidedAt)}</p>
      {r.decisionComment ? <blockquote className="border-l-2 border-line pl-3 text-ink whitespace-pre-wrap" data-testid="decision-comment">{r.decisionComment}</blockquote> : null}
    </>
  );
}

function DecisionForm({ request, onDone: reload, onRefused }) {
  const toast = useToast();
  const { refresh } = useAuth();
  // The review and the sidebar's approvals count both change with a decision.
  const onDone = () => { reload(); refresh(); };
  const [outcome, setOutcome] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!outcome) { setError({ message: 'Choose a decision.' }); return; }
    if (!comment.trim()) { setError({ message: 'A comment is required for every decision.' }); return; }
    setBusy(true); setError(null);
    try {
      await post(`/api/requests/${request.id}/decision`, { outcome, comment: comment.trim() });
      toast.success('Decision recorded', `${request.submittedBy.name} has been told.`);
      onDone();
    } catch (err) {
      // The request can no longer be decided: the page reloads without this form and keeps the reason.
      if (err.code === 'STALE' || err.code === 'NOT_PENDING') { onRefused(err); onDone(); } else setError(err);
    }
    setBusy(false);
  }

  return (
    <Card>
      <CardHeader title="Decision" subtitle="Every decision needs a comment; the Author and the project's Authors can read it." />
      <form className="px-5 pb-5 space-y-4" onSubmit={submit} noValidate data-testid="decision-form">
        {error ? <Alert title={error.code === 'STALE' ? 'Not decided: the request is out of date' : 'Not decided'}>{error.message}</Alert> : null}
        <fieldset className="space-y-2">
          <legend className="sr-only">Decision</legend>
          {OUTCOMES.map(([value, label, hint]) => (
            <label key={value} className={`flex items-start gap-2.5 rounded-md border p-2.5 cursor-pointer text-[13px] ${outcome === value ? 'border-accent bg-accent-soft/40' : 'border-line hover:bg-surface-2'}`}>
              <input type="radio" name="outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} className="mt-0.5" />
              <span><span className="font-medium text-ink">{label}</span><span className="block text-ink-3">{hint}</span></span>
            </label>
          ))}
        </fieldset>
        <Field label="Comment" required hint="Up to 4000 characters.">
          {(p) => <Textarea {...p} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={4000} rows={5} />}
        </Field>
        <Button type="submit" variant="primary" icon="check" loading={busy} className="w-full">Record decision</Button>
      </form>
    </Card>
  );
}

/*
  The administrator's overrides on a pending request (decisions.md V4-V6):
  decide it (the real decision, with a comment for the Author and a separate
  reason), reset it so the Authors can resubmit, or send it to another
  Project Manager. Each asks for a written reason.
*/
function AdminOverrides({ request, onDone: reload, onRefused }) {
  const toast = useToast();
  const { refresh } = useAuth();
  const [open, setOpen] = useState(null);
  const [outcome, setOutcome] = useState('');
  const [comment, setComment] = useState('');
  const [managers, setManagers] = useState(null);
  const [managerId, setManagerId] = useState('');
  const done = () => { setOpen(null); reload(); refresh(); };
  async function openReassign() {
    setManagerId(''); setOpen('reassign');
    try { setManagers((await get('/api/users?role=project_manager&status=active')).users.filter((u) => u.id !== request.manager.id)); } catch { setManagers([]); }
  }
  const refusedOr = (err) => {
    if (err.code === 'STALE' || err.code === 'NOT_PENDING') { setOpen(null); onRefused(err); reload(); return; }
    throw err;
  };
  return (
    <Card>
      <CardHeader title="Administrator override" subtitle={`Pending with ${request.manager.name}. Each action needs a written reason and is told to the people involved.`} />
      <div className="px-5 pb-5 grid gap-2" data-testid="admin-overrides">
        <Button icon="shield" onClick={() => { setOutcome(''); setComment(''); setOpen('decide'); }}>Decide as administrator</Button>
        <Button icon="users" onClick={openReassign}>Reassign to another manager</Button>
        <Button variant="danger-ghost" icon="undo" onClick={() => setOpen('reset')}>Reset so the Authors can resubmit</Button>
      </div>

      <OverrideDialog open={open === 'decide'} onClose={() => setOpen(null)} title="Decide as administrator" confirmLabel="Record decision"
        description="This is the real decision on the frozen snapshot, labelled as an administrator override." valid={!!outcome && !!comment.trim()}
        people={`${request.submittedBy.name}, the project's Authors and ${request.manager.name}`}
        onSubmit={async (reason) => {
          if (!outcome) throw new Error('Choose a decision.');
          if (!comment.trim()) throw new Error('Write a comment for the Author.');
          try {
            await post(`/api/requests/${request.id}/override-decision`, { outcome, comment: comment.trim(), reason });
            toast.success('Decision recorded as an override', `${request.submittedBy.name} and ${request.manager.name} have been told.`);
            done();
          } catch (err) { refusedOr(err); }
        }}>
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-ink-2 mb-1.5">Decision</legend>
          {OUTCOMES.map(([value, label, hint]) => (
            <label key={value} className={`flex items-start gap-2.5 rounded-md border p-2.5 cursor-pointer text-[13px] ${outcome === value ? 'border-accent bg-accent-soft/40' : 'border-line hover:bg-surface-2'}`}>
              <input type="radio" name="override-outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} className="mt-0.5" />
              <span><span className="font-medium text-ink">{label}</span><span className="block text-ink-3">{hint}</span></span>
            </label>
          ))}
        </fieldset>
        <Field label="Comment for the Author" required hint="What the Author reads, as with a manager's comment. Only its length is recorded in the audit log.">
          {(p) => <Textarea {...p} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={4000} rows={4} />}
        </Field>
      </OverrideDialog>

      <OverrideDialog open={open === 'reassign'} onClose={() => setOpen(null)} title="Reassign the request" confirmLabel="Reassign" valid={!!managerId}
        description={`${request.manager.name} will no longer see this request; the new manager reviews the same frozen snapshot.`}
        people={`${request.submittedBy.name}, ${request.manager.name} and the new manager`}
        onSubmit={async (reason) => {
          if (!managerId) throw new Error('Choose a Project Manager.');
          try {
            await post(`/api/requests/${request.id}/reassign`, { managerId, reason });
            toast.success('Request reassigned');
            done();
          } catch (err) { refusedOr(err); }
        }}>
        <Field label="Send to" required>
          {(p) => (
            <Select {...p} value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={!managers}>
              <option value="">{managers ? (managers.length ? 'Choose a Project Manager…' : 'No other active Project Manager') : 'Loading…'}</option>
              {(managers || []).map((m) => <option key={m.id} value={m.id}>{m.fullName} ({m.username})</option>)}
            </Select>
          )}
        </Field>
      </OverrideDialog>

      <OverrideDialog open={open === 'reset'} onClose={() => setOpen(null)} title="Reset the request" confirmLabel="Reset request" tone="danger"
        description="The request becomes out of date without a decision. The publication unlocks, its modules return to draft, and the Authors can edit and submit again."
        people={`${request.submittedBy.name}, the project's Authors and ${request.manager.name}`}
        onSubmit={async (reason) => {
          try {
            await post(`/api/requests/${request.id}/override-reset`, { reason });
            toast.success('Request reset', 'The Authors can submit again.');
            done();
          } catch (err) { refusedOr(err); }
        }} />
    </Card>
  );
}

function OverrideLog({ overrides }) {
  const LABEL = { decision: 'Decided as an override', reset: 'Reset', reassign: 'Reassigned' };
  return (
    <Card>
      <CardHeader title="Overrides" subtitle="Administrator actions on this request" />
      <ul className="px-5 pb-5 space-y-2 text-[13px]" data-testid="override-log">
        {overrides.map((o) => (
          <li key={o.id} className="rounded-md border border-line p-2.5">
            <p className="text-ink-2"><span className="font-medium text-ink">{LABEL[o.kind] || o.kind}</span> by {o.by}, {fmtDateTime(o.at)}</p>
            <p className="text-ink-2">Reason: <span className="text-ink">“{o.reason}”</span></p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Sources({ request, files, modules }) {
  const byRel = useMemo(() => new Map(modules.map((m) => [m.rel, m])), [modules]);
  const [rel, setRel] = useState(() => (modules[0] ? modules[0].rel : files[0] ? files[0].rel : null));
  const [view, setView] = useState('design');
  const [text, setText] = useState({ rel: null, value: null, error: null });
  const [revisions, setRevisions] = useState(null);
  const [revision, setRevision] = useState(null);
  const [selected, setSelected] = useState(null);
  const isImage = rel && !/\.(xml|json)$/i.test(rel);
  const mod = rel ? byRel.get(rel) : null;
  const model = useMemo(() => (mod ? contentModelFor(mod.issue, mod.schemaType) : null), [mod]);
  const src = (r) => `/api/requests/${request.id}/source?rel=${encodeURIComponent(r)}`;

  /*
    A figure's artwork on the Design view comes from the frozen snapshot, never
    the live project: the file the module's DOCTYPE declares for the ICN, or
    one named after it. An ICN with no frozen file shows as missing.
  */
  const graphicUrl = useMemo(() => {
    const images = files.filter((f) => !/\.(xml|json)$/i.test(f.rel));
    const base = (f) => f.rel.replace(/^.*\//, '').toLowerCase();
    const declared = new Map();
    const dt = text.value ? /<!DOCTYPE[\s\S]*?\]>/.exec(text.value) : null;
    if (dt) for (const m of dt[0].matchAll(/<!ENTITY\s+(\S+)\s+SYSTEM\s+["']([^"']+)["']/gi)) declared.set(m[1].toLowerCase(), m[2].replace(/^.*[\\/]/, '').toLowerCase());
    return (icn) => {
      const key = icn.toLowerCase();
      const hit = images.find((f) => base(f) === declared.get(key)) || images.find((f) => base(f).replace(/\.[^.]+$/, '') === key);
      return hit ? src(hit.rel) : null;
    };
  }, [files, text.value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!rel) return;
    setRevision(null); setRevisions(null); setSelected(null);
    if (!isImage) {
      setText({ rel, value: null, error: null });
      get(src(rel)).then((d) => setText({ rel, value: d.text, error: null }), (e) => setText({ rel, value: null, error: e }));
    }
    get(`/api/requests/${request.id}/revisions?rel=${encodeURIComponent(rel)}`).then((d) => setRevisions(d.revisions), () => setRevisions([]));
  }, [rel]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openRevision(id) {
    try { setRevision(await get(`/api/requests/${request.id}/revisions/${id}`)); } catch (e) { setRevision({ error: e }); }
  }

  if (!files.length) return <EmptyState icon="file" title="No sources in this snapshot" />;
  const label = (f) => (byRel.get(f.rel) ? `${byRel.get(f.rel).title}` : f.rel);
  return (
    <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <Card className="overflow-hidden self-start">
        <ul className="max-h-[70vh] overflow-y-auto divide-y divide-line text-[13px]" data-testid="source-list">
          {files.map((f) => (
            <li key={f.rel}>
              <button type="button" onClick={() => setRel(f.rel)} aria-current={f.rel === rel ? 'true' : undefined}
                className={`w-full text-left px-3 py-2 ${f.rel === rel ? 'bg-accent-soft/50 text-ink' : 'text-ink-2 hover:bg-surface-2'}`}>
                <span className="block truncate">{label(f)}</span>
                <span className="block truncate font-mono text-[11px] text-ink-3">{f.rel}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <div className="min-w-0 space-y-4">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-line text-[12.5px] text-ink-3">
            <span className="flex items-center gap-1.5"><Icon name="lock" size={14} />Frozen at submission · read-only</span>
            {!isImage && model ? (
              <div className="inline-flex rounded-md border border-line p-0.5" role="group" aria-label="View">
                {[['design', 'Design'], ['document', 'Tags'], ['xml', 'XML']].map(([v, l]) => (
                  <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                    className={`px-2.5 py-1 rounded text-[12.5px] font-medium ${view === v ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:text-ink'}`}>{l}</button>
                ))}
              </div>
            ) : null}
          </div>
          {isImage ? (
            <div className="p-4 bg-surface-2 grid place-items-center"><img src={src(rel)} alt={rel} className="max-h-[60vh] bg-white" data-testid="source-image" /></div>
          ) : text.error ? <ErrorState error={text.error} /> : text.rel !== rel || text.value == null ? <div className="p-5"><LoadingBlock rows={5} /></div> : view === 'design' && model ? (
            <div className="h-[62vh] min-h-80 overflow-auto bg-surface" data-testid="source-design">
              <PageView xml={text.value} onChange={noop} readOnly model={model} selected={selected} onSelect={setSelected} projectId={request.projectId} graphicUrl={graphicUrl} />
            </div>
          ) : view === 'document' && model ? (
            <div className="h-[62vh] min-h-80 overflow-auto bg-surface" data-testid="source-document">
              <StructuredEditor xml={text.value} onChange={noop} readOnly model={model} selected={selected} onSelect={setSelected} showTags />
            </div>
          ) : (
            <Suspense fallback={<div className="h-[62vh] grid place-items-center text-ink-3"><Spinner label="Loading the XML panel" /></div>}>
              <div data-readonly="true"><XmlPanel value={text.value} onChange={noop} readOnly contentModel={model} label={`Frozen source ${rel}`} /></div>
            </Suspense>
          )}
        </Card>
        <Card>
          <CardHeader title="Revision history" subtitle="Saved revisions up to the moment of submission" />
          <div className="px-5 pb-5 text-[13px]">
            {!revisions ? <LoadingBlock rows={2} /> : !revisions.length ? <p className="text-ink-3">No saved revisions of this file.</p> : (
              <ul className="divide-y divide-line rounded-md border border-line" data-testid="revision-list">
                {revisions.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span><span className="text-ink">{v.reason || 'Saved'}</span><span className="text-ink-3"> · {v.by || '—'} · {fmtDateTime(v.createdAt)}</span></span>
                    <Button size="sm" variant="ghost" icon="eye" onClick={() => openRevision(v.id)}>View</Button>
                  </li>
                ))}
              </ul>
            )}
            {revision ? (
              revision.error ? <Alert className="mt-3" title="This revision could not be opened">{revision.error.message}</Alert> : (
                <div className="mt-3 rounded-md border border-line" data-testid="revision-view">
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-line text-[12px] text-ink-3">
                    <span>Revision {revision.revision.id} · {fmtDateTime(revision.revision.createdAt)}</span>
                    <button type="button" onClick={() => setRevision(null)} aria-label="Close the revision"><Icon name="x" size={14} /></button>
                  </div>
                  <pre className="max-h-80 overflow-auto p-3 font-mono text-[11.5px] text-ink-2 whitespace-pre">{revision.text}</pre>
                </div>
              )
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Validation({ request }) {
  const { data, loading, error, reload } = useResource(`/api/requests/${request.id}/validation`);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading) return <LoadingBlock rows={4} />;
  const groups = new Map();
  for (const f of data.findings) {
    if (!groups.has(f.rel)) groups.set(f.rel, []);
    groups.get(f.rel).push(f);
  }
  return (
    <Card>
      <CardHeader title="Validation report" subtitle={`Frozen with the submission: ${data.counts.error} errors, ${data.counts.warning} warnings, ${data.counts.info} notes across ${data.counts.modules} data modules`} />
      <div className="px-5 pb-5 text-[13px]" data-testid="validation-report">
        {!data.findings.length ? <p className="text-ok flex items-center gap-1.5"><Icon name="checkCircle" size={15} />No findings: every data module passed XSD and BREX.</p> : (
          <ul className="space-y-3">
            {[...groups].map(([rel, items]) => (
              <li key={rel}>
                <p className="font-mono text-[12px] text-ink-2">{rel}</p>
                <ul className="mt-1 space-y-1">
                  {items.map((f, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <Badge tone={f.sev === 'error' ? 'danger' : f.sev === 'warning' ? 'warn' : 'neutral'}>{f.sev}</Badge>
                      <span className="text-ink">{f.kind === 'brex' ? 'BREX' : f.kind === 'schema' ? 'XSD' : f.kind}{f.line > 1 ? `, line ${f.line}` : ''}: {f.message}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// Every request of this publication, oldest first, with the decisions and their comments (M5, M6).
export function History({ history, current }) {
  if (!history.length) return <EmptyState icon="clock" title="No history" />;
  return (
    <Card>
      <CardHeader title="History" subtitle="Every request for this publication, with the decisions and comments" />
      <ol className="px-5 pb-5 space-y-3 text-[13px]" data-testid="request-history">
        {history.map((h, i) => (
          <li key={h.id} className={`rounded-md border p-3 ${h.id === current ? 'border-accent' : 'border-line'}`} data-testid="history-item">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-ink-3">#{i + 1}</span>
              <RequestBadge status={h.status} />
              <span className="text-ink-3">submitted {fmtDateTime(h.submittedAt)} by {h.submittedBy.name} to {h.manager.name}</span>
              {h.id === current ? <Badge tone="accent">This request</Badge> : null}
            </div>
            {h.note ? <p className="mt-1.5 text-ink-2">Author note: “{h.note}”</p> : null}
            {h.override ? <div className="mt-1.5"><OverrideNote request={h} /></div> : null}
            {h.decidedBy ? <p className="mt-1.5 text-ink-2">{(REQUEST_STATUS[h.status] || {}).label} by <span className="font-medium text-ink">{h.decidedBy.name}</span>, {fmtDateTime(h.decidedAt)}</p> : null}
            {h.decisionComment ? <blockquote className="mt-1.5 border-l-2 border-line pl-3 text-ink whitespace-pre-wrap" data-testid="history-comment">{h.decisionComment}</blockquote> : null}
            {h.commentHidden ? <p className="mt-1.5 text-ink-3 italic">The comment is visible to the project's Authors and the deciding manager only.</p> : null}
            {h.status === 'stale' ? <p className="mt-1.5 text-danger">Out of date: {h.staleReason || 'the publication changed after it was submitted'}.</p> : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}
