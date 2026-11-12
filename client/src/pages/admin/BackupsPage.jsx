import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardHeader, DetailList, PageHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import DataTable from '../../components/ui/DataTable.jsx';
import { Badge, Mono } from '../../components/ui/Badge.jsx';
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog.jsx';
import { Field, Input, PasswordInput, Textarea } from '../../components/ui/Field.jsx';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import useResource from '../../lib/useResource.js';
import { api, post } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import { fmtBytes } from './HealthPage.jsx';

const KIND = { manual: 'Manual', scheduled: 'Scheduled', 'pre-restore': 'Recovery point' };

function StatusBadge({ b }) {
  if (b.status !== 'ok') return <Badge tone="danger" icon="alert">Damaged</Badge>;
  if (b.lastVerified && !b.lastVerified.ok) return <Badge tone="danger" icon="alert">Failed verification</Badge>;
  if (b.lastVerified) return <Badge tone="ok" icon="checkCircle">Verified {fmtRelative(b.lastVerified.at)}</Badge>;
  return <Badge tone="ok" icon="check">Complete</Badge>;
}

/*
  The restore dialog (decisions.md K7): what will happen, the backup id typed
  again, the administrator's own password and a written reason. The server
  verifies the backup, takes a recovery point, swaps the data, checks it and
  ends every session, so the administrator is signed out afterwards.
*/
function RestoreDialog({ backup, onClose, onDone }) {
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ready = confirm === backup.id && password && reason.trim().length >= 10;

  async function submit(e) {
    e.preventDefault();
    if (!ready) { setError({ message: 'Type the backup id exactly, enter your password and write a reason of at least 10 characters.' }); return; }
    setBusy(true); setError(null);
    try { onDone(await post(`/api/admin/backups/${backup.id}/restore`, { confirm, password, reason: reason.trim() })); } catch (err) { setError(err); setBusy(false); }
  }

  return (
    <Dialog open onClose={() => !busy && onClose()} title="Restore this backup" size="md"
      description="Every project, document, revision, request, account and setting goes back to how it was when this backup was taken."
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="restore-form" variant="danger" icon="refresh" loading={busy}>Restore and sign everyone out</Button></>}>
      <form id="restore-form" onSubmit={submit} className="space-y-4" noValidate data-testid="restore-form">
        {error ? <Alert title="Not restored">{error.message}{error.body && error.body.problems ? <ul className="mt-1 list-disc pl-5 text-[12.5px]">{error.body.problems.slice(0, 5).map((p) => <li key={p}>{p}</li>)}</ul> : null}</Alert> : null}
        <Alert tone="warn" title={`Back to ${fmtDateTime(backup.createdAt)}`}>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>Work saved after that time is replaced. A <strong>recovery point</strong> of the current data is taken and verified first, so this can be undone by restoring it.</li>
            <li>Saving is paused while the data is swapped; PDF builds in progress are allowed to finish first.</li>
            <li><strong>Everyone is signed out</strong>, you included. Audit records written since the backup are kept.</li>
          </ul>
        </Alert>
        <Field label={`Type the backup id to confirm: ${backup.id}`} required>
          {(p) => <Input {...p} value={confirm} onChange={(e) => setConfirm(e.target.value.trim())} autoComplete="off" spellCheck={false} className="font-mono" />}
        </Field>
        <Field label="Your password" required>{(p) => <PasswordInput {...p} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}</Field>
        <Field label="Reason" required hint="Recorded in the audit log.">{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} />}</Field>
      </form>
    </Dialog>
  );
}

/*
  Backups (Phase 5, decisions.md K1-K12): take one now, see every backup with
  what it holds, verify one (every file and the database), delete one (never
  the only usable one), and restore one. The schedule, retention, encryption
  and folder come from the server's settings and are shown, not edited here.
*/
export default function BackupsPage() {
  const toast = useToast();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const { data, loading, error, reload } = useResource('/api/admin/backups');
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [report, setReport] = useState(null);

  async function create() {
    setBusy('create');
    try {
      const r = await post('/api/admin/backups', note.trim() ? { note: note.trim() } : {});
      toast.success('Backup created and verified', `${r.backup.id} · ${r.backup.files} files · ${fmtBytes(r.backup.size)}`);
      setNote(''); reload();
    } catch (e) { toast.error('Backup failed', e.message); reload(); }
    setBusy(null);
  }
  async function verify(b) {
    setBusy(`verify-${b.id}`);
    try {
      const r = await post(`/api/admin/backups/${b.id}/verify`);
      setReport(r);
      if (r.ok) toast.success('Backup verified', 'Every file matches its checksum and the database passes its integrity check.');
      reload();
    } catch (e) { toast.error('Verification failed', e.message); }
    setBusy(null);
  }

  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  const s = data && data.status;

  return (
    <>
      <PageHeader eyebrow="Administration" title="Backups"
        subtitle="The database, every project workspace and the frozen submissions, as one recovery unit. Each backup is verified before it is listed." />
      {loading && !data ? <Card className="p-6"><LoadingBlock rows={6} /></Card> : (
        <div className="space-y-6">
          {s.warnings.length ? (
            <div data-testid="backup-warnings"><Alert tone="warn" title="Attention">{s.warnings.map((w) => <p key={w}>{w}</p>)}</Alert></div>
          ) : null}
          <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr] items-start">
            <Card>
              <CardHeader title="Take a backup now" subtitle="Saving is paused for the few seconds the copy takes; reading carries on." />
              <div className="px-5 pb-5 flex flex-wrap items-end gap-3">
                <div className="min-w-0 flex-1">
                  <Field label="Note (optional)">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="For example: before the release" />}</Field>
                </div>
                <Button variant="primary" icon="download" onClick={create} loading={busy === 'create'} disabled={!!s.operation}>Create backup</Button>
              </div>
              {s.operation ? <p className="px-5 pb-5 text-[13px] text-warn">A {s.operation.kind} is in progress (started {fmtRelative(s.operation.startedAt)}).</p> : null}
            </Card>
            <Card>
              <CardHeader title="Settings" subtitle="Set on the server (.env); see the README" />
              <div className="px-5 pb-3">
                <DetailList items={[
                  ['Last backup', s.last ? `${fmtDateTime(s.last.at)} (${KIND[s.last.kind]})` : 'None yet'],
                  ['Schedule', s.schedule ? `Every day at ${s.schedule} (server time)` : 'Off'],
                  ['Retention', `Newest ${s.keep} scheduled, newest ${s.keepPreRestore} recovery points; manual ones until deleted`],
                  ['Encryption', s.encrypted ? <span key="e">AES-256-GCM · key id <Mono>{s.keyId}</Mono></span> : 'Off'],
                  ['Folder', <Mono key="f" className="break-all text-[12px]">{s.directory}</Mono>],
                  ['Free space there', s.freeBytes == null ? '—' : fmtBytes(s.freeBytes)],
                ]} />
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader title="Backups" subtitle={`${s.count} usable${s.damaged ? `, ${s.damaged} damaged` : ''}`} actions={<Button size="sm" variant="ghost" icon="refresh" onClick={reload}>Refresh</Button>} />
            <DataTable
              caption="Backups"
              rows={data.backups}
              initialSort={{ key: 'created', dir: 'desc' }}
              empty={<EmptyState icon="download" title="No backups yet">Create the first one above.</EmptyState>}
              columns={[
                { key: 'created', header: 'Created', sortValue: (b) => b.createdAt || b.id, render: (b) => (
                  <div><span className="text-ink">{b.createdAt ? fmtDateTime(b.createdAt) : '—'}</span><Mono className="block text-[11.5px]">{b.id}</Mono>{b.note ? <span className="block text-[12px] text-ink-3">{b.note}</span> : null}</div>
                ) },
                { key: 'kind', header: 'Kind', sortValue: (b) => b.kind || '', render: (b) => <span className="text-ink-2">{KIND[b.kind] || '—'}{b.createdBy ? <span className="block text-[12px] text-ink-3">by {b.createdBy.username}</span> : null}</span>, hideBelow: 'sm' },
                { key: 'holds', header: 'Holds', render: (b) => (b.stats ? <span className="text-[12.5px] text-ink-2">{b.stats.projects} projects · {b.stats.dataModules} modules · {b.stats.revisions} revisions · {b.stats.requests} requests · {b.stats.users} accounts</span> : '—'), hideBelow: 'lg' },
                { key: 'size', header: 'Size', align: 'right', sortValue: (b) => b.size || 0, render: (b) => <span className="text-ink-2">{b.size == null ? '—' : fmtBytes(b.size)}{b.encrypted ? <span className="block text-[11.5px] text-ink-3">encrypted</span> : null}</span>, hideBelow: 'md' },
                { key: 'status', header: 'Status', sortValue: (b) => b.status, render: (b) => <StatusBadge b={b} /> },
                { key: 'act', header: <span className="sr-only">Actions</span>, align: 'right', render: (b) => (
                  <span className="inline-flex flex-wrap justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => verify(b)} loading={busy === `verify-${b.id}`} aria-label={`Verify ${b.id}`}>Verify</Button>
                    {b.status === 'ok' ? <Button size="sm" variant="secondary" onClick={() => setRestoring(b)} aria-label={`Restore ${b.id}`}>Restore</Button> : null}
                    <Button size="sm" variant="danger-ghost" onClick={() => setDeleting(b)} aria-label={`Delete ${b.id}`}>Delete</Button>
                  </span>
                ) },
              ]}
            />
          </Card>
        </div>
      )}

      {report && !report.ok ? (
        <Dialog open onClose={() => setReport(null)} title="This backup failed verification" size="md" footer={<Button onClick={() => setReport(null)}>Close</Button>}>
          <p className="text-ink-2 mb-2"><Mono>{report.id}</Mono> cannot be restored. What was found:</p>
          <ul className="list-disc pl-5 text-[13px] text-ink space-y-0.5" data-testid="verify-problems">{report.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Dialog>
      ) : null}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete this backup?" confirmLabel="Delete backup" tone="danger"
        onConfirm={async () => { await api(`/api/admin/backups/${deleting.id}`, { method: 'DELETE', body: {} }); toast.success('Backup deleted', deleting.id); setDeleting(null); reload(); }}>
        {deleting ? <p><Mono>{deleting.id}</Mono> is removed from the backup folder for good. The only usable backup cannot be deleted.</p> : null}
      </ConfirmDialog>
      {restoring ? (
        <RestoreDialog backup={restoring} onClose={() => setRestoring(null)}
          onDone={async () => { setRestoring(null); toast.success('Backup restored', 'Everyone has been signed out. Sign in again.'); await refresh(); nav('/signin', { replace: true }); }} />
      ) : null}
    </>
  );
}
