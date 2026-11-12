import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, PageHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import Tabs from '../../components/ui/Tabs.jsx';
import { SearchInput } from '../../components/ui/Field.jsx';
import { Badge, Mono } from '../../components/ui/Badge.jsx';
import { ConfirmDialog } from '../../components/ui/Dialog.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import Icon from '../../components/Icon.jsx';
import UploadGraphicDialog from '../../components/UploadGraphicDialog.jsx';
import useResource from '../../lib/useResource.js';
import { del } from '../../api.js';

const PAGE = 48;
const PROBLEM = { missing: 'Missing', misplaced: 'Wrong place', duplicate: 'Duplicate', conflict: 'Conflict' };

// One graphic: a thumbnail if the file exists, a dashed placeholder (like the PDF's own missing-artwork box) otherwise.
function Thumb({ g, kind }) {
  if (!g.present) {
    return (
      <div className="aspect-[4/3] grid place-items-center rounded-t-lg border-b border-line bg-surface-2 text-ink-3">
        <Icon name="image" size={28} />
      </div>
    );
  }
  return (
    <div className="aspect-[4/3] bg-white rounded-t-lg border-b border-line overflow-hidden grid place-items-center">
      <img src={`/api/projects/${g.projectId}/graphics/${encodeURIComponent(g.icn)}/file`} alt=""
        className={kind === 'symbol' ? 'max-h-10 max-w-10 object-contain' : 'h-full w-full object-contain'} loading="lazy" />
    </div>
  );
}

// Deletable only when nothing refers to it, the same rule the per-project Graphics tab enforces (decisions.md GR4); the server is the real guard either way.
function Card2({ g, kind, onDelete, busy }) {
  const mayDelete = g.canWrite && !(g.usedBy && g.usedBy.length) && (g.present || g.registered);
  return (
    <div className="relative group">
      <Link to={`/projects/${g.projectId}?tab=graphics`} className="block rounded-lg border border-line bg-surface shadow-card overflow-hidden hover:border-accent">
        <Thumb g={g} kind={kind} />
        <div className="p-2.5 min-w-0">
          <p className="font-mono text-[11.5px] text-ink truncate group-hover:text-accent" title={g.icn}>{g.icn}</p>
          <p className="text-[11.5px] text-ink-3 truncate" title={g.projectName}>{g.projectName}</p>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {g.title ? <Badge>{g.title}</Badge> : null}
            {g.problems && g.problems.length ? g.problems.map((p) => <Badge key={p.code} tone={p.code === 'missing' ? 'danger' : 'warn'}>{PROBLEM[p.code] || p.code}</Badge>) : null}
            {g.canWrite ? null : <Badge tone="accent" icon="eye">Read only</Badge>}
          </div>
        </div>
      </Link>
      {mayDelete ? (
        <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(g); }} disabled={busy}
          aria-label={`Delete ${g.icn}`} title="Delete this graphic"
          className="absolute top-1.5 right-1.5 h-7 w-7 grid place-items-center rounded-full bg-surface/90 text-ink-3 border border-line opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger hover:border-danger">
          <Icon name="trash" size={14} />
        </button>
      ) : null}
    </div>
  );
}

/*
  A central graphics library (decisions.md GL1-GL3): ICNs and symbols
  across every project the signed-in person can see, for browsing and
  quick upload — not a second store. Uploading still goes through the
  project it belongs to (POST /api/projects/:id/graphics); only the "which
  project" choice is new, asked here first.
*/
export default function GraphicsLibraryPage() {
  const toast = useToast();
  const { data, loading, error, reload } = useResource('/api/graphics');
  const [view, setView] = useState('icns');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(null); // the graphic row pending confirmation
  const [busy, setBusy] = useState(null); // "<projectId>:<icn>" while a delete is in flight

  async function confirmDelete() {
    const g = deleting;
    setBusy(`${g.projectId}:${g.icn}`);
    try {
      await del(`/api/projects/${g.projectId}/graphics/${encodeURIComponent(g.icn)}`, {});
      toast.success('Graphic deleted', g.icn);
      reload();
    } catch (e) { toast.error('Not deleted', e.message); }
    setBusy(null);
    setDeleting(null);
  }

  const rows = useMemo(() => {
    const list = data ? (view === 'symbols' ? data.symbols : data.icns) : [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((g) => g.icn.toLowerCase().includes(q) || (g.title || '').toLowerCase().includes(q) || g.projectName.toLowerCase().includes(q));
  }, [data, view, search]);

  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;

  return (
    <>
      <PageHeader eyebrow="Authoring" title="Graphics" subtitle="Every ICN and symbol across the projects you can see."
        actions={data && data.uploadTargets.length ? <Button variant="primary" icon="upload" onClick={() => setUploading(true)}>Upload graphic</Button> : null} />
      <Card>
        <div className="px-4 pt-3">
          <Tabs idBase="lib" value={view} onChange={(v) => { setView(v); setShown(PAGE); }}
            tabs={[{ value: 'icns', label: 'ICNs', count: data ? data.icns.length : undefined }, { value: 'symbols', label: 'Symbols', count: data ? data.symbols.length : undefined }]} />
        </div>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setShown(PAGE); }} placeholder="Search ICN, title or project" label="Search graphics" className="w-full sm:w-80" />
          <p className="sm:ml-auto text-[13px] text-ink-3" aria-live="polite">{data ? `${rows.length} ${view}` : ''}</p>
        </div>
        <div className="px-4 pb-4">
          {loading ? <LoadingBlock rows={4} /> : !rows.length ? (
            <EmptyState icon="image" title={search ? 'No graphics match' : `No ${view} yet`}>
              {search ? 'Try a different search.' : 'Graphics appear here once a data module refers to them, or someone uploads one.'}
            </EmptyState>
          ) : (
            <>
              <div data-testid="graphics-grid" className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                {rows.slice(0, shown).map((g) => (
                  <Card2 key={`${g.projectId}:${g.icn}`} g={g} kind={view === 'symbols' ? 'symbol' : 'icn'}
                    onDelete={setDeleting} busy={busy === `${g.projectId}:${g.icn}`} />
                ))}
              </div>
              {rows.length > shown ? (
                <div className="mt-4 text-center">
                  <Button variant="ghost" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Card>
      {data ? (
        <UploadGraphicDialog open={uploading} onClose={() => setUploading(false)} projects={data.uploadTargets}
          onDone={() => { reload(); toast.success('Graphic uploaded'); }} />
      ) : null}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete this graphic?" confirmLabel="Delete" tone="danger" onConfirm={confirmDelete}>
        {deleting ? <p>Removes <Mono>{deleting.icn}</Mono> from <strong className="text-ink">{deleting.projectName}</strong>. It is already unused, so nothing else changes.</p> : null}
      </ConfirmDialog>
    </>
  );
}
