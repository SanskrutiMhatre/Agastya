import { useState } from 'react';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import DataTable from '../../components/ui/DataTable.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import useResource from '../../lib/useResource.js';
import { fetchBlob } from '../../api.js';
import { fmtRelative } from '../../lib/format.js';

const FORMAT_LABEL = { s1000d: 'S1000D', jss: 'JSS' };

// A normal browser download: the file is saved wherever the person chooses, never written for them.
async function download(url, name, onError) {
  try {
    const blob = await fetchBlob(url);
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
    return blob.size;
  } catch (e) { onError(e); return null; }
}

/*
  Project backups the person can save to their own computer (decisions.md
  GL4). This is the existing CSDB package export (content/csdbPackage.js),
  not a second backup system: data modules, the publication (or the book),
  graphics and settings, each project checked and zipped the same way
  Export package already does on the project's own Graphics tab. Revision
  history, project members and audit records are not included here — they
  are not portable content, and a full database backup (with those) is the
  administrator's system backup, under System health.
*/
export default function BackupPage() {
  const toast = useToast();
  const { data, loading, error, reload } = useResource('/api/backup/projects');
  const [busy, setBusy] = useState(null); // null | 'all' | <projectId>

  async function backupOne(p) {
    setBusy(p.id);
    const safe = p.name.replace(/[^A-Za-z0-9._-]+/g, '_');
    const bytes = await download(`/api/projects/${p.id}/package.zip`, `CSDB-${safe}.zip`, (e) => toast.error('Backup failed', e.message));
    if (bytes) toast.success('Backup downloaded', `${p.name} · ${(bytes / 1024).toFixed(0)} KB`);
    setBusy(null);
  }
  async function backupAll() {
    setBusy('all');
    const today = new Date().toISOString().slice(0, 10);
    const bytes = await download('/api/backup/all.zip', `AGASTYA-BACKUP-${today}.zip`, (e) => toast.error('Backup failed', e.message));
    if (bytes) toast.success('Backup downloaded', `${data.projects.length} project${data.projects.length === 1 ? '' : 's'} · ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    setBusy(null);
  }

  return (
    <>
      <PageHeader eyebrow="Other" title="Backup" subtitle="Download your projects as a zip, to keep on your own computer."
        actions={data && data.projects.length > 1 ? <Button variant="primary" icon="download" onClick={backupAll} loading={busy === 'all'}>Download all ({data.projects.length})</Button> : null} />
      <Alert tone="info" className="mb-4">
        Each backup holds that project's data modules (or its book), publication module, graphics and settings — the same as Export package on its Graphics tab. It does not include revision history, members or audit records; a full database backup with those is made by the administrator, under System health.
      </Alert>
      <Card>
        <CardHeader title="Your projects" subtitle="Everything you own or are assigned to" />
        {error ? <ErrorState error={error} onRetry={reload} />
          : loading ? <div className="px-5 pb-5"><LoadingBlock rows={3} /></div>
            : (
              <DataTable
                caption="Projects"
                rows={data.projects}
                rowKey={(p) => p.id}
                initialSort={{ key: 'name', dir: 'asc' }}
                empty={<EmptyState icon="folder" title="No projects to back up" />}
                columns={[
                  { key: 'name', header: 'Project', sortValue: (p) => p.name, render: (p) => <span className="font-medium text-ink">{p.name}</span> },
                  { key: 'format', header: 'Format', sortValue: (p) => p.format, hideBelow: 'sm', render: (p) => <Badge>{FORMAT_LABEL[p.format] || p.format}</Badge> },
                  { key: 'updated', header: 'Last modified', sortValue: (p) => p.updatedAt, hideBelow: 'md', render: (p) => <span className="text-ink-2">{fmtRelative(p.updatedAt)}</span> },
                  { key: 'act', header: <span className="sr-only">Download</span>, align: 'right', render: (p) => (
                    <Button size="sm" icon="download" onClick={() => backupOne(p)} loading={busy === p.id}>Download</Button>
                  ) },
                ]}
              />
            )}
      </Card>
    </>
  );
}
