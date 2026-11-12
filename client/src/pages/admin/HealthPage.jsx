import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader, DetailList, PageHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import { Badge, Mono } from '../../components/ui/Badge.jsx';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import useResource from '../../lib/useResource.js';
import { post } from '../../api.js';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';

export function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}
const KIND = { full: 'Publication', preview: 'Preview', snapshot: 'Submission' };

/*
  System health (decisions.md V11, V12): the toolchain checks (the same as
  npm run doctor) with the real path and version of each tool that ran,
  builds in progress and recent, database and storage sizes, and the backup
  status (decisions.md K10).
*/
export default function HealthPage() {
  const toast = useToast();
  const { data, loading, error, reload, setData } = useResource('/api/admin/health');
  const [busy, setBusy] = useState(false);

  async function recheck() {
    setBusy(true);
    try { setData(await post('/api/admin/health/toolchain')); toast.success('Toolchain checked'); } catch (e) { toast.error('Check failed', e.message); }
    setBusy(false);
  }

  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  const d = data;
  const problems = d ? d.toolchain.checks.filter((c) => !c.ok) : [];
  const outside = d ? d.toolchain.tools.filter((t) => t.linked && !t.insideProject) : [];

  return (
    <>
      <PageHeader eyebrow="Administration" title="System health" subtitle="The PDF toolchain, builds, storage and backups."
        actions={<Button icon="refresh" onClick={recheck} loading={busy}>Run checks again</Button>} />
      {loading && !d ? <Card className="p-6"><LoadingBlock rows={8} label="Running the toolchain checks" /></Card> : (
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr] items-start">
            <Card>
              <CardHeader title="Toolchain" subtitle={`Checked ${fmtRelative(d.toolchain.checkedAt)} · ${d.toolchain.checks.length} checks`}
                actions={problems.length ? <Badge tone="danger" icon="alert">{problems.length} problem{problems.length === 1 ? '' : 's'}</Badge> : <Badge tone="ok" icon="checkCircle">All checks passed</Badge>} />
              <div className="px-5 pb-5 space-y-4">
                {outside.length ? (
                  <div data-testid="tools-outside"><Alert tone="warn" title="Not the bundled tools">
                    {outside.map((t) => t.name).join(' and ')} {outside.length === 1 ? 'is a link' : 'are links'} to tools outside the project folder, so the bundled versions are not the ones
                    in use on this machine. Re-run the golden build on the production machine with the bundled tools before relying on its PDFs.
                  </Alert></div>
                ) : null}
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]" data-testid="tool-table">
                    <caption className="sr-only">Tools that ran</caption>
                    <thead><tr className="text-left text-[12px] uppercase tracking-wide text-ink-3"><th className="font-medium py-1.5 pr-3">Tool</th><th className="font-medium py-1.5 pr-3">Version</th><th className="font-medium py-1.5">Path that ran</th></tr></thead>
                    <tbody>
                      {d.toolchain.tools.map((t) => (
                        <tr key={t.name} className="border-t border-line align-top">
                          <td className="py-2 pr-3 whitespace-nowrap">{t.ok ? <Badge tone="ok" icon="checkCircle">{t.name}</Badge> : <Badge tone="danger" icon="alert">{t.name}</Badge>}</td>
                          <td className="py-2 pr-3 text-ink-2 min-w-[180px]">{t.version || '—'}</td>
                          <td className="py-2 min-w-[220px]">
                            <Mono className="block break-all text-[12px]">{t.realPath || t.path}</Mono>
                            {t.linked ? <span className="block text-[12px] text-ink-3">through <Mono className="text-[11.5px]">{t.path}</Mono>{t.insideProject ? '' : ' (outside the project)'}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details className="text-[13px]">
                  <summary className="cursor-pointer text-ink-3">Every check ({d.toolchain.checks.length})</summary>
                  <ul className="mt-2 divide-y divide-line rounded-md border border-line">
                    {d.toolchain.checks.map((c) => (
                      <li key={c.name} className="flex gap-2 px-3 py-1.5">
                        <span className="w-14 shrink-0">{!c.ok ? <Badge tone="danger">Missing</Badge> : c.note ? <Badge>Note</Badge> : <Badge tone="ok">OK</Badge>}</span>
                        <span className="min-w-0"><span className="text-ink">{c.name}</span><span className="block text-[12px] text-ink-3 break-words">{c.detail}</span></span>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            </Card>

            <div className="space-y-6">
              <Card>
                <CardHeader title="Backups" actions={<Link to="/backups" className="text-[13px] text-accent hover:underline">Manage backups</Link>} />
                <div className="px-5 pb-5 space-y-3" data-testid="health-backup">
                  {d.backup.last
                    ? <p className="text-[13px] text-ink-2"><Badge tone={d.backup.lastAgeHours > 26 ? 'warn' : 'ok'} icon="checkCircle">Last backup {fmtRelative(d.backup.last.at)}</Badge> <span className="text-ink-3">{d.backup.count} usable · {d.backup.schedule ? `daily at ${d.backup.schedule}` : 'no schedule'} · {d.backup.encrypted ? 'encrypted' : 'not encrypted'}</span></p>
                    : <Alert tone="info" title={d.backup.message}>{d.backup.schedule ? `The first scheduled backup runs at ${d.backup.schedule}.` : 'Take one from the Backups page, and set a daily schedule on the server.'}</Alert>}
                  {d.backup.warnings.length ? <ul className="list-disc pl-5 text-[12.5px] text-warn space-y-0.5">{d.backup.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
                </div>
              </Card>
              <Card>
                <CardHeader title="Database and storage" />
                <div className="px-5 pb-3">
                  <DetailList items={[
                    ['Database', `${fmtBytes(d.storage.database.file)} (${d.storage.database.pages} pages, ${d.storage.database.freePages} free)`],
                    ['Write-ahead log', fmtBytes(d.storage.database.wal)],
                    ['Project workspaces', fmtBytes(d.storage.projects)],
                    ['Submission snapshots', fmtBytes(d.storage.snapshots)],
                    ['Free disk space', d.storage.disk ? `${fmtBytes(d.storage.disk.free)} of ${fmtBytes(d.storage.disk.total)}` : '—'],
                    ['Server', `Node ${d.runtime.node} on ${d.runtime.platform}, up ${Math.round(d.runtime.uptimeSeconds / 60)} min`],
                  ]} />
                </div>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader title="Build queue" subtitle="Builds in progress, then the latest ones" actions={<Button size="sm" variant="ghost" icon="refresh" onClick={reload}>Refresh</Button>} />
            <div className="px-5 pb-5 space-y-4">
              {d.builds.active.length ? (
                <ul className="divide-y divide-line rounded-md border border-line text-[13px]" data-testid="build-active">
                  {d.builds.active.map((b, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <Badge tone={b.state === 'running' ? 'accent' : 'warn'} icon="clock">{b.state === 'running' ? 'Running' : 'Waiting'}</Badge>
                      <span className="text-ink">{KIND[b.kind] || b.kind}{b.target ? ` ${b.target}` : ''}</span>
                      <Link to={`/projects/${b.projectId}`} className="text-accent hover:underline">{b.projectName}</Link>
                      <span className="text-ink-3">by {b.by}, started {fmtRelative(b.startedAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-[13px] text-ink-3" data-testid="build-idle">No build is running.</p>}
              {d.builds.recent.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <caption className="sr-only">Recent builds</caption>
                    <thead><tr className="text-left text-[12px] uppercase tracking-wide text-ink-3"><th className="font-medium py-1.5 pr-3">When</th><th className="font-medium py-1.5 pr-3">Build</th><th className="font-medium py-1.5 pr-3">Project</th><th className="font-medium py-1.5 pr-3">By</th><th className="font-medium py-1.5 text-right">Result</th></tr></thead>
                    <tbody>
                      {d.builds.recent.map((b) => (
                        <tr key={b.id} className="border-t border-line">
                          <td className="py-2 pr-3 text-ink-2 whitespace-nowrap">{fmtDateTime(b.at)}</td>
                          <td className="py-2 pr-3">{KIND[b.kind] || b.kind}{b.target ? <Mono className="block text-[11.5px]">{b.target}</Mono> : null}</td>
                          <td className="py-2 pr-3"><Link to={`/projects/${b.projectId}`} className="text-accent hover:underline">{b.projectName}</Link></td>
                          <td className="py-2 pr-3 text-ink-2">{b.by || '—'}</td>
                          <td className="py-2 text-right whitespace-nowrap">{b.ok ? <Badge tone="ok" icon="checkCircle">{b.ms ? `${(b.ms / 1000).toFixed(1)} s` : 'OK'}</Badge> : <Badge tone="danger" icon="alert">{b.errorCode || 'Failed'}</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState icon="book" title="No builds yet" />}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
