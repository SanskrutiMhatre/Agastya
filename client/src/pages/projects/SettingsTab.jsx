import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardHeader } from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import { Field, Input, Select } from '../../components/ui/Field.jsx';
import { Alert, ErrorState, LoadingBlock } from '../../components/ui/States.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import useResource from '../../lib/useResource.js';
import { post, postForm, put } from '../../api.js';
import { useOverrideSession } from '../../components/OverrideSession.jsx';
import { LockBanner } from '../../components/LockBanner.jsx';

/*
  Publication settings (decisions.md ST1-ST7), grouped as the JSS PDF
  Publisher's settings drawer: Identity, Publishers, Page and type (the page
  size and margins: "Resize Pages"), Pipeline, Watermark. Each group is saved
  on its own and read back from the server, so what is shown is what is
  stored. A JSS book carries its identity itself, so for one it is written
  into the book; its publishers are part of the book's XML.
*/
function Group({ title, subtitle, children, onSave, busy, canWrite, error, testid }) {
  return (
    <Card data-testid={testid}>
      <CardHeader title={title} subtitle={subtitle} actions={canWrite ? <Button size="sm" variant="primary" onClick={onSave} loading={busy}>Save</Button> : null} />
      <div className="px-5 pb-5 space-y-3">
        {error ? <Alert>{error}</Alert> : null}
        {children}
      </div>
    </Card>
  );
}

export default function SettingsTab({ project, canWrite: mayWrite, override = false, format = 's1000d', onConverted }) {
  const toast = useToast();
  const nav = useNavigate();
  const ov = useOverrideSession({ projectId: project.id, docKey: 'publication', label: 'the publication settings', enabled: override });
  const canWrite = mayWrite || ov.active;
  const { data, loading, error, reload } = useResource(`/api/projects/${project.id}/settings`);
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(null);
  const [errors, setErrors] = useState({});
  const logo = useRef(null);
  const [convertName, setConvertName] = useState('');
  const [report, setReport] = useState(null);
  useEffect(() => { if (data) setS(JSON.parse(JSON.stringify(data.settings))); }, [data]);
  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  if (loading || !s) return <Card className="p-6"><LoadingBlock rows={6} /></Card>;
  const has = (g) => data.groups.includes(g);
  const ro = !canWrite;

  async function save(group, value) {
    setBusy(group); setErrors((e) => ({ ...e, [group]: null }));
    try {
      const r = await put(`/api/projects/${project.id}/settings/${group}`, { value });
      setS(JSON.parse(JSON.stringify(r.settings)));
      toast.success('Settings saved', group);
      reload();
    } catch (e) { setErrors((x) => ({ ...x, [group]: e.message })); }
    setBusy(null);
  }
  const setIn = (group, key) => (e) => setS({ ...s, [group]: { ...s[group], [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value } });
  const setPub = (i, key, value) => { const list = [...s.publishers]; while (list.length <= i) list.push({ name: '', addressLines: [], logo: '' }); list[i] = { ...list[i], [key]: value }; setS({ ...s, publishers: list }); };

  async function uploadLogo(file) {
    if (!file) return;
    try { const r = await postForm(`/api/projects/${project.id}/branding`, {}, file); toast.success('Image uploaded', r.file); reload(); } catch (e) { toast.error('Not uploaded', e.message); }
  }
  async function convert() {
    setBusy('convert'); setErrors((e) => ({ ...e, convert: null })); setReport(null);
    try {
      const r = await post(`/api/projects/${project.id}/convert`, { to: 'jss', name: convertName.trim() });
      setReport(r);
      toast.success('Converted', r.project.name);
      if (onConverted) onConverted(r.project);
    } catch (e) { setErrors((x) => ({ ...x, convert: e.message })); }
    setBusy(null);
  }

  return (
    <div className="space-y-6">
      {ov.bar}
      {data.lock ? <LockBanner lock={data.lock} override={ov.active} what="The publication settings" /> : null}
      {ro ? <Alert tone="info">You can read these settings; the Authors of this project change them.</Alert> : null}
      <div className="grid gap-6 xl:grid-cols-2 items-start">
        <Group testid="settings-identity" title="Identity" subtitle={format === 'jss' ? 'Written into the book’s <bookmeta>; shown on the title pages' : 'Shown on the title pages and in the running heads'}
          canWrite={canWrite} busy={busy === 'identity'} error={errors.identity} onSave={() => save('identity', s.identity)}>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(data.options.identity).filter(([k]) => k !== 'documentTypeHeader' && (k !== 'documentType' || format === 'jss')).map(([k, label]) => (
              k === 'securityClassification' ? (
                <Field key={k} label={label}>{(p) => (
                  <Select {...p} value={(s.identity[k] || '').toUpperCase()} onChange={setIn('identity', k)} disabled={ro}>
                    <option value="">(none)</option>
                    {data.options.classifications.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                )}</Field>
              ) : k === 'documentType' ? (
                <Field key={k} label={label} hint="Sets the cover title and running head to match the JSS0251 stencil.">{(p) => (
                  <Select {...p} value={s.identity[k] || ''} onChange={setIn('identity', k)} disabled={ro}>
                    <option value="">(none chosen)</option>
                    {Object.entries(data.options.documentTypes).map(([key, t]) => <option key={key} value={key}>{t.label}</option>)}
                  </Select>
                )}</Field>
              ) : <Field key={k} label={label}>{(p) => <Input {...p} value={s.identity[k] || ''} onChange={setIn('identity', k)} maxLength={200} disabled={ro} />}</Field>
            ))}
          </div>
        </Group>

        <Group testid="settings-page" title="Page and type" subtitle="Page size and margins (Resize Pages), the body font and the contents. A chapter can also go landscape in the builder."
          canWrite={canWrite} busy={busy === 'page' || busy === 'type'} error={errors.page || errors.type}
          onSave={async () => { await save('page', s.page); await save('type', s.type); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Page size">{(p) => (
              <Select {...p} value={s.page.size} onChange={setIn('page', 'size')} disabled={ro}>
                {Object.entries(data.options.pageSizes).map(([k, v]) => <option key={k} value={k}>{k} ({v.width} × {v.height})</option>)}
                <option value="Custom">Custom</option>
              </Select>
            )}</Field>
            {s.page.size === 'Custom' ? (
              <>
                <Field label="Width">{(p) => <Input {...p} value={s.page.width} onChange={setIn('page', 'width')} disabled={ro} />}</Field>
                <Field label="Height">{(p) => <Input {...p} value={s.page.height} onChange={setIn('page', 'height')} disabled={ro} />}</Field>
              </>
            ) : null}
            {[['marginTop', 'Top margin'], ['marginBottom', 'Bottom margin'], ['marginInner', 'Inner margin'], ['marginOuter', 'Outer margin']].map(([k, label]) => (
              <Field key={k} label={label} hint="A length, for example 20mm.">{(p) => <Input {...p} value={s.page[k] || ''} onChange={setIn('page', k)} disabled={ro} />}</Field>
            ))}
            <Field label="Body font">{(p) => (
              <Select {...p} value={s.type.fontFamily} onChange={setIn('type', 'fontFamily')} disabled={ro}>{data.options.fonts.map((f) => <option key={f} value={f}>{f}</option>)}</Select>
            )}</Field>
            <Field label="Body text size" hint="6pt to 16pt.">{(p) => <Input {...p} value={s.type.bodySize} onChange={setIn('type', 'bodySize')} disabled={ro} />}</Field>
            <Field label="Contents depth">{(p) => (
              <Select {...p} value={String(s.type.tocDepth)} onChange={(e) => setS({ ...s, type: { ...s.type, tocDepth: Number(e.target.value) } })} disabled={ro}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} level{n > 1 ? 's' : ''}</option>)}</Select>
            )}</Field>
            <label className="flex items-center gap-2 text-[13px] self-end pb-2"><input type="checkbox" checked={!!s.type.blankVersos} onChange={setIn('type', 'blankVersos')} disabled={ro} />Chapters open on a right-hand page</label>
          </div>
        </Group>

        {has('publishers') ? (
          <Group testid="settings-publishers" title="Publishers" subtitle={s.publishersFromTemplate ? 'From the house template until you save your own' : 'One, or two for a joint title page'}
            canWrite={canWrite} busy={busy === 'publishers'} error={errors.publishers}
            onSave={() => save('publishers', { publishers: s.publishers.filter((p) => p.name || p.logo) })}>
            {[0, 1].map((i) => {
              const p = s.publishers[i] || { name: '', addressLines: [], logo: '' };
              return (
                <div key={i} className="grid gap-3 sm:grid-cols-3 rounded-md border border-line p-3">
                  <Field label={`Publisher ${i + 1}`}>{(f) => <Input {...f} value={p.name} onChange={(e) => setPub(i, 'name', e.target.value)} maxLength={120} disabled={ro} />}</Field>
                  <Field label="Address (one line each)">{(f) => <Input {...f} value={(p.addressLines || []).join(' | ')} onChange={(e) => setPub(i, 'addressLines', e.target.value.split('|').map((x) => x.trim()).filter(Boolean))} disabled={ro} />}</Field>
                  <Field label="Logo">{(f) => (
                    <Select {...f} value={p.logo || ''} onChange={(e) => setPub(i, 'logo', e.target.value)} disabled={ro}>
                      <option value="">(none)</option>
                      {data.media.map((m) => <option key={m} value={m}>{m}</option>)}
                    </Select>
                  )}</Field>
                </div>
              );
            })}
            {canWrite ? (
              <div className="flex items-center gap-2">
                <Button size="sm" icon="upload" onClick={() => logo.current && logo.current.click()}>Upload logo or emblem</Button>
                <input ref={logo} type="file" accept=".png,.jpg,.jpeg,.gif" className="sr-only" tabIndex={-1} aria-label="Choose a logo image" onChange={(e) => { uploadLogo(e.target.files[0]); e.target.value = ''; }} />
                <span className="text-[12px] text-ink-3">PNG, JPEG or GIF, into Media/.</span>
              </div>
            ) : null}
          </Group>
        ) : <Card className="p-5 text-[13px] text-ink-3">A JSS book carries its publishers in its own XML (&lt;bookmeta&gt;&lt;publishers&gt;); edit them on the Publication tab.</Card>}

        <Group testid="settings-watermark" title="Watermark" subtitle="For released publications"
          canWrite={canWrite} busy={busy === 'watermark'} error={errors.watermark} onSave={() => save('watermark', s.watermark)}>
          <Alert tone="info">A publication that is not released (no approval, or changed since its approval) is always stamped <strong>NOT RELEASED</strong>, whatever is set here. Released publications carry this watermark if it is on, and “Release N” in the running head.</Alert>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={!!s.watermark.enabled} onChange={setIn('watermark', 'enabled')} disabled={ro} />Watermark released publications</label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Text" hint="At most 40 characters.">{(p) => <Input {...p} value={s.watermark.text} onChange={setIn('watermark', 'text')} maxLength={40} disabled={ro} />}</Field>
            <Field label="Style">{(p) => <Select {...p} value={s.watermark.style} onChange={setIn('watermark', 'style')} disabled={ro}>{data.options.watermarkStyles.map((x) => <option key={x} value={x}>{x}</option>)}</Select>}</Field>
          </div>
        </Group>

        {has('pipeline') ? (
          <Group testid="settings-pipeline" title="Pipeline" subtitle="How the PDF is made from S1000D"
            canWrite={canWrite} busy={busy === 'pipeline'} error={errors.pipeline} onSave={() => save('pipeline', { pipeline: s.pipeline })}>
            {[['s1000dtojss', 'Customisable (through JSS)', 'Branding, headings, front matter and layout follow these settings.'], ['s1000dtofo', 'S1000D default', 'Straight from S1000D with its own fixed styling; most settings here do not apply.']].map(([v, t, d]) => (
              <label key={v} className="flex gap-2 text-[13px]"><input type="radio" name="pipeline" checked={s.pipeline === v} onChange={() => setS({ ...s, pipeline: v })} disabled={ro} /><span><span className="font-medium">{t}</span><span className="block text-ink-3">{d}</span></span></label>
            ))}
          </Group>
        ) : null}

        {format === 's1000d' ? (
          <Card data-testid="settings-convert">
            <CardHeader title="Convert to a JSS book" subtitle="A new JSS project, made by the s1000dtojss stage; this project is not changed" />
            <div className="px-5 pb-5 space-y-3">
              {errors.convert ? <Alert>{errors.convert}</Alert> : null}
              <div className="flex flex-wrap items-end gap-2">
                <Field label="New project name" className="flex-1 min-w-48">{(p) => <Input {...p} value={convertName} onChange={(e) => setConvertName(e.target.value)} maxLength={80} />}</Field>
                <Button onClick={convert} loading={busy === 'convert'} disabled={convertName.trim().length < 3}>Convert</Button>
              </div>
              {report ? (
                <div data-testid="conversion-report" className="rounded-md border border-line p-3 text-[13px] space-y-1.5">
                  <p className="font-medium">{report.project.name} created {report.report.lossy ? <Badge tone="warn">check the report</Badge> : <Badge tone="ok">nothing lost</Badge>}</p>
                  <p className="text-ink-2">{report.report.modules} modules, {report.report.frontMatterPagesInlined} front-matter pages inlined, {report.report.images} images copied. The original files are kept in the new project under source/.</p>
                  {report.report.changed.length ? <p className="text-warn">Changed counts: {report.report.changed.join('; ')}</p> : null}
                  {report.report.unmapped.length ? <p className="text-warn">Dropped by the conversion: {report.report.unmapped.map((u) => `<${u.name}> ×${u.count}`).join(', ')}</p> : null}
                  {report.report.unhandled.length ? <p className="text-ink-3">Not named by the conversion (text kept, markup not): {report.report.unhandled.slice(0, 12).map((u) => `<${u.name}>`).join(', ')}{report.report.unhandled.length > 12 ? ', …' : ''}</p> : null}
                  <Button size="sm" variant="primary" onClick={() => nav(`/projects/${report.project.id}`)}>Open {report.project.name}</Button>
                </div>
              ) : <p className="text-[12px] text-ink-3">JSS books cannot be converted back to S1000D; JSG is not available (it is not defined in the reference material).</p>}
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
