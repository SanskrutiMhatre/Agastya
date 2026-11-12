import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Button from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Select } from '../components/ui/Field.jsx';
import { Alert } from '../components/ui/States.jsx';
import Icon from '../components/Icon.jsx';
import {
  parseXml, serializeXml, elementAt, elementChildren, childNames, displayText,
  insertElement, insertInline, removeElement, moveElement, setAttribute, setText,
  namesAfterRemove, namesAfterMove, contentProblems,
} from './xmlDoc.js';

/*
  The structured, schema-aware view of a data module (checkpoint 2c). The XML
  stays the single source: every edit here parses the current text, changes
  the DOM and writes the text back, so the XML panel, drafts, saving and
  conflict detection all see exactly what the author did.

    blocks   elements that hold other elements (levelledPara, figure, list ...)
    text     elements that hold text (para, title ...) are edited in place;
             their inline elements (emphasis, internalRef ...) show inline
    insert   only what the S1000D content model allows at that position
             (before, after, inside, or at the cursor in text)
    marks    an element whose children break its model is outlined, with why
*/

const pathKey = (p) => p.join('.');
const samePath = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const isWs = (s) => /^\s*$/.test(s);

// Inline elements that are references, shown as chips even though they hold elements.
const INLINE_REFS = new Set(['dmRef', 'pmRef', 'externalPubRef', 'internalRef', 'footnoteRef', 'acronym', 'acronymTerm', 'symbol', 'dmRefIdent']);
// Elements given their own look; everything else renders generically.
const LOOK = {
  title: 'font-semibold text-[15px] text-ink',
  techName: 'font-semibold text-ink', infoName: 'text-ink-2',
  para: 'text-ink leading-6', simplePara: 'text-ink leading-6', notePara: 'text-ink', warningAndCautionPara: 'text-ink', attentionListItemPara: 'text-ink',
  warning: 'border-l-4 border-danger bg-danger-soft/50 pl-3', caution: 'border-l-4 border-warn bg-warn-soft/50 pl-3', note: 'border-l-4 border-accent bg-accent-soft/40 pl-3',
  figure: 'border border-line rounded-md p-2', table: 'border border-line rounded-md p-2',
  row: 'flex gap-1', entry: 'flex-1 min-w-0 border border-line rounded px-1',
};
const INLINE_LOOK = { emphasis: 'font-semibold', verbatimText: 'font-mono text-[12px]', internalRef: 'text-accent underline', dmRef: 'text-accent', subScript: 'align-sub text-[11px]', superScript: 'align-super text-[11px]' };

// What an inline reference points to, or null when the element is not an empty reference.
const DMC_KEYS = ['modelIdentCode', 'systemDiffCode', 'systemCode', 'subSystemCode', 'subSubSystemCode', 'assyCode', 'disassyCode', 'disassyCodeVariant', 'infoCode', 'infoCodeVariant', 'itemLocationCode'];
export function refTarget(el) {
  if (el.nodeName === 'dmRef') {
    const code = el.getElementsByTagName('dmCode')[0];
    if (!code) return '';
    const v = (k) => code.getAttribute(k) || '';
    return `DMC-${[v(DMC_KEYS[0]), v(DMC_KEYS[1]), v(DMC_KEYS[2]), v(DMC_KEYS[3]) + v(DMC_KEYS[4]), v(DMC_KEYS[5]), v(DMC_KEYS[6]) + v(DMC_KEYS[7]), v(DMC_KEYS[8]) + v(DMC_KEYS[9]), v(DMC_KEYS[10])].join('-')}`;
  }
  if (el.childNodes.length) return null;
  for (const a of Array.from(el.attributes || [])) if (/(RefId|Ident|refid)$/i.test(a.name)) return a.value;
  return null;
}

/*
  An editable run of text. Uncontrolled while focused, so React never resets
  the caret; the change is committed on blur (one undo step per text edit).
*/
function EditableText({ value, readOnly, onCommit, onCaret, placeholder, testId }) {
  const ref = useRef(null);
  const atFocus = useRef(null); // the value when editing started
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== value) el.textContent = value;
  }, [value]);
  const blur = (el) => {
    // The document changed under this run while it was focused (an insert, an undo): that change wins.
    if (atFocus.current !== null && atFocus.current !== value) { el.textContent = value; atFocus.current = null; return; }
    atFocus.current = null;
    if (el.textContent !== value) onCommit(el.textContent);
  };
  const caret = () => { const s = window.getSelection(); if (s && s.anchorNode && ref.current && ref.current.contains(s.anchorNode)) onCaret(s.anchorOffset); };
  return (
    <span
      ref={ref} data-testid={testId} role="textbox" aria-multiline="false" aria-label={placeholder || 'Text'} tabIndex={readOnly ? -1 : 0}
      contentEditable={readOnly ? false : 'plaintext-only'} suppressContentEditableWarning spellCheck
      data-placeholder={placeholder || ''}
      className={`outline-none rounded-sm px-px ${readOnly ? '' : 'focus:bg-accent-soft/60 hover:bg-surface-3/60'} empty:before:content-[attr(data-placeholder)] empty:before:text-ink-3 empty:before:italic`}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      onKeyUp={caret} onMouseUp={caret} onFocus={() => { atFocus.current = value; caret(); }}
      onBlur={(e) => blur(e.currentTarget)}
    />
  );
}

export default function StructuredEditor({ xml, onChange, readOnly, model, selected, onSelect, showTags = true, problemsRef, showAttrs = false, hiddenTags = [] }) {
  const parsed = useMemo(() => parseXml(xml), [xml]);
  const problems = useMemo(() => (parsed.error ? [] : contentProblems(parsed.doc, model)), [parsed, model]);
  const problemAt = useMemo(() => new Map(problems.map((p) => [pathKey(p.path), p])), [problems]);
  // Tag names the author chose not to see (shown again when selected).
  const hidden = useMemo(() => new Set(hiddenTags), [hiddenTags]);
  const [collapsed, setCollapsed] = useState(() => new Set(['0'])); // identAndStatusSection starts folded
  useEffect(() => { if (problemsRef) problemsRef.current = problems; }, [problems, problemsRef]);

  if (parsed.error) {
    return (
      <Alert title="The XML cannot be shown as a document" className="m-4">
        Line {parsed.error.line}: {parsed.error.message} Correct it in the XML panel; the document view comes back as soon as the XML is well formed.
      </Alert>
    );
  }

  const commitText = (path, nodeIndex, value) => {
    const p = parseXml(xml);
    setText(p, path, nodeIndex, value);
    onChange(serializeXml(p), { label: 'Edit text' });
  };

  const select = (path, caret = null) => onSelect({ path, caret });

  function renderInline(el, path, key) {
    const name = el.nodeName;
    const isSel = samePath(selected && selected.path, path);
    const chip = (
      <button type="button" onClick={(e) => { e.stopPropagation(); select(path); }}
        className={`mx-0.5 rounded px-1 font-mono text-[10.5px] align-middle ${isSel ? 'bg-accent text-accent-ink' : 'bg-surface-3 text-ink-3 hover:text-ink'}`}
        aria-label={`Select ${name}`} aria-pressed={isSel}>{name}</button>
    );
    // An empty inline reference (internalRef with its target id, dmRef ...) shows what it points to, not a text cursor.
    const target = refTarget(el);
    if (target !== null) {
      return <span key={key} className="inline-flex items-center">{chip}<span className="font-mono text-[11px] text-accent">{target}</span></span>;
    }
    if (model.holdsText(name)) {
      return <span key={key} className={`${INLINE_LOOK[name] || ''} ${isSel ? 'ring-1 ring-accent rounded-sm' : ''}`}>{showTags ? chip : null}{renderMixed(el, path)}</span>;
    }
    return <span key={key}>{chip}{Array.from(el.attributes || []).filter((a) => /refid|infoEntityIdent|internalRefId/i.test(a.name)).slice(0, 1).map((a) => <span key={a.name} className="font-mono text-[11px] text-accent">{a.value}</span>)}</span>;
  }

  function renderMixed(el, path) {
    const nodes = Array.from(el.childNodes);
    const hasText = nodes.some((n) => n.nodeType === 3 && !isWs(n.data));
    const items = [];
    nodes.forEach((n, i) => {
      if (n.nodeType === 3) {
        if (isWs(n.data) && nodes.length > 1) { items.push(<span key={i}> </span>); return; }
        items.push(<EditableText key={i} value={displayText(n.data)} readOnly={readOnly} testId={`text-${pathKey(path)}-${i}`}
          onCommit={(v) => commitText(path, i, v)} onCaret={(offset) => select(path, { nodeIndex: i, offset })} />);
      } else if (n.nodeType === 1) {
        const idx = elementChildren(el).indexOf(n);
        const childPath = [...path, idx];
        const isBlock = !model.holdsText(n.nodeName) && model.isContainer(n.nodeName) && !INLINE_REFS.has(n.nodeName);
        items.push(isBlock ? <div key={i} className="my-1">{renderBlock(n, childPath)}</div> : renderInline(n, childPath, i));
      } else if (n.nodeType === 8) {
        items.push(<span key={i} className="mx-0.5 font-mono text-[10.5px] text-ink-3" title={n.data}>&lt;!-- --&gt;</span>);
      }
    });
    if (!hasText && !nodes.some((n) => n.nodeType === 1)) {
      items.push(<EditableText key="new" value="" readOnly={readOnly} placeholder={`Type ${el.nodeName} text`} testId={`text-${pathKey(path)}-new`}
        onCommit={(v) => commitText(path, nodes.length, v)} onCaret={(offset) => select(path, { nodeIndex: nodes.length, offset })} />);
    }
    return items;
  }

  function renderBlock(el, path) {
    const name = el.nodeName;
    const key = pathKey(path);
    const isSel = samePath(selected && selected.path, path);
    const problem = problemAt.get(key);
    const text = model.holdsText(name);
    const isFolded = collapsed.has(key);
    const kids = elementChildren(el);
    const strayText = !text && Array.from(el.childNodes).some((n) => n.nodeType === 3 && !isWs(n.data));
    return (
      <div key={key || 'root'} data-testid={`node-${key || 'root'}`} data-element={name}
        className={`relative rounded-md ${LOOK[name] || ''} ${isSel ? 'ring-2 ring-accent' : problem ? 'ring-1 ring-danger' : ''} ${text ? 'py-0.5' : 'py-1'}`}
        onClick={(e) => { e.stopPropagation(); if (!text) select(path); }}>
        {isSel || (!hidden.has(name) && (showTags || !text)) ? (
          <div className="flex items-center gap-1.5 select-none">
            {!text && kids.length ? (
              <button type="button" aria-label={isFolded ? `Expand ${name}` : `Collapse ${name}`} className="h-5 w-5 grid place-items-center text-ink-3 hover:text-ink"
                onClick={(e) => { e.stopPropagation(); setCollapsed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; }); }}>
                <Icon name={isFolded ? 'chevronRight' : 'chevronDown'} size={13} />
              </button>
            ) : null}
            <button type="button" onClick={(e) => { e.stopPropagation(); select(path); }} aria-pressed={isSel} aria-label={`Select ${name}`}
              className={`rounded px-1.5 font-mono text-[10.5px] ${isSel ? 'bg-accent text-accent-ink' : 'bg-surface-3 text-ink-3 hover:text-ink'}`}>{name}</button>
            {showAttrs && el.attributes.length ? <span className="font-mono text-[10.5px] text-ink-3 truncate" data-testid="tag-attrs">{Array.from(el.attributes).filter((a) => !/^xmlns|^xsi:/.test(a.name)).map((a) => `${a.name}="${a.value}"`).join(' ')}</span> : null}
            {problem ? <span className="text-[11.5px] text-danger flex items-center gap-1" title={problem.message}><Icon name="alert" size={12} />{problem.message}</span> : null}
            {isFolded && !text ? <span className="text-[11.5px] text-ink-3">{kids.length} item{kids.length === 1 ? '' : 's'}</span> : null}
          </div>
        ) : null}
        {isFolded && !text ? null : text ? (
          <div className={`${LOOK[name] || 'text-ink'} pl-1`} onClick={(e) => e.stopPropagation()}>{renderMixed(el, path)}</div>
        ) : (
          <div className={`${path.length ? 'pl-4' : ''} ${name === 'row' ? 'flex gap-1' : 'space-y-1'}`}>
            {kids.map((c, i) => renderBlock(c, [...path, i]))}
            {strayText ? <p className="text-[12px] text-danger">Text is not allowed directly in &lt;{name}&gt;.</p> : null}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 text-[13.5px]" data-testid="structured-view" onClick={() => onSelect(null)}>
      {renderBlock(parsed.doc.documentElement, [])}
    </div>
  );
}

/*
  The inspector for the selected element: where it is, its attributes (with
  the permitted values from the schema), what may be inserted around it and
  inside it, and moving or deleting it when the result stays valid.
*/
export function Inspector({ xml, onChange, readOnly, model, selected, onSelect, problems }) {
  const parsed = useMemo(() => parseXml(xml), [xml]);
  const [attrDraft, setAttrDraft] = useState({});
  const el = !parsed.error && selected ? elementAt(parsed.doc, selected.path) : null;
  useEffect(() => { setAttrDraft({}); }, [selected && pathKey(selected.path)]);

  const apply = useCallback((label, fn) => {
    const p = parseXml(xml);
    const nextPath = fn(p);
    onChange(serializeXml(p), { label });
    if (nextPath) onSelect({ path: nextPath, caret: null });
  }, [xml, onChange, onSelect]);

  if (parsed.error) return <p className="px-5 pb-5 text-[13px] text-ink-3">Correct the XML to use the structured view.</p>;
  const problemList = (
    problems && problems.length ? (
      <div className="px-5 pb-4">
        <p className="text-[12px] font-medium text-danger mb-1">{problems.length} content model problem{problems.length === 1 ? '' : 's'}</p>
        <ul className="space-y-0.5 max-h-36 overflow-y-auto" data-testid="model-problems">
          {problems.slice(0, 30).map((p) => (
            <li key={pathKey(p.path)}><button type="button" className="text-left text-[12px] text-ink-2 hover:text-accent" onClick={() => onSelect({ path: p.path, caret: null })}>{p.message}</button></li>
          ))}
        </ul>
      </div>
    ) : <p className="px-5 pb-4 text-[12px] text-ok flex items-center gap-1"><Icon name="checkCircle" size={13} />Every element follows its S1000D content model.</p>
  );
  if (!el) return <div data-testid="inspector"><p className="px-5 pb-3 text-[13px] text-ink-3">Select an element (click its tag) to see its attributes and what can be inserted.</p>{problemList}</div>;

  const name = el.nodeName;
  const path = selected.path;
  const parent = path.length ? elementAt(parsed.doc, path.slice(0, -1)) : null;
  const index = path.length ? path[path.length - 1] : 0;
  const siblings = parent ? childNames(parent) : [];
  const allowedAttrs = model.attributesOf(name);
  const attrNames = [...new Set([...Object.keys(allowedAttrs), ...Array.from(el.attributes).map((a) => a.name)])].sort();
  const before = parent ? model.insertableAt(parent.nodeName, siblings, index) : [];
  const after = parent ? model.insertableAt(parent.nodeName, siblings, index + 1) : [];
  const kids = childNames(el);
  const inside = model.insertableAt(name, kids, kids.length);
  const atCaret = selected.caret && model.holdsText(name)
    ? model.insertableAt(name, kids, elementChildren(el).filter((c) => Array.from(el.childNodes).indexOf(c) < selected.caret.nodeIndex).length) : [];
  const canDelete = parent && model.canExtend(parent.nodeName, namesAfterRemove(parent, index));
  const up = parent && namesAfterMove(parent, index, -1);
  const down = parent && namesAfterMove(parent, index, 1);
  const canUp = !!up && model.canExtend(parent.nodeName, up);
  const canDown = !!down && model.canExtend(parent.nodeName, down);

  const crumbs = [];
  for (let i = 0; i <= path.length; i++) {
    const p = path.slice(0, i);
    crumbs.push({ p, n: elementAt(parsed.doc, p).nodeName });
  }

  const InsertSelect = ({ label, options, onPick, testId }) => (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] text-ink-3">{label}</span>
      <Select data-testid={testId} value="" disabled={readOnly || !options.length} onChange={(e) => { if (e.target.value) onPick(e.target.value); }} aria-label={label}>
        <option value="">{options.length ? `Choose (${options.length})` : 'Nothing allowed here'}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </Select>
    </label>
  );

  return (
    <div data-testid="inspector">
      <div className="px-5 pb-3">
        <nav aria-label="Element path" className="flex flex-wrap items-center gap-0.5 text-[11.5px] font-mono text-ink-3 mb-2">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              {i ? <Icon name="chevronRight" size={11} /> : null}
              <button type="button" className={i === crumbs.length - 1 ? 'text-ink font-semibold' : 'hover:text-accent'} onClick={() => onSelect({ path: c.p, caret: null })}>{c.n}</button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">&lt;{name}&gt;</Badge>
          {model.holdsText(name) ? <Badge>holds text</Badge> : null}
          {!model.isKnown(name) ? <Badge tone="warn">not in the {model.key} schema</Badge> : null}
        </div>
      </div>

      <div className="px-5 pb-4 space-y-2">
        <p className="text-[12px] font-medium text-ink-2">Attributes</p>
        {attrNames.length ? (
          <div className="space-y-1.5">
            {attrNames.map((a) => {
              const values = allowedAttrs[a] || [];
              const current = el.getAttribute(a);
              const draft = attrDraft[a] !== undefined ? attrDraft[a] : (current || '');
              return (
                <label key={a} className="grid grid-cols-[120px_1fr] items-center gap-2">
                  <span className={`font-mono text-[11.5px] truncate ${allowedAttrs[a] ? 'text-ink-2' : 'text-danger'}`} title={allowedAttrs[a] ? a : `${a} is not allowed on <${name}>`}>{a}</span>
                  {values.length ? (
                    <Select aria-label={`Attribute ${a}`} value={current || ''} disabled={readOnly} onChange={(e) => apply(`Set ${a}`, (p) => { setAttribute(p, path, a, e.target.value || null); return null; })}>
                      <option value="">(not set)</option>
                      {values.map((v) => <option key={v} value={v}>{v}</option>)}
                      {current && !values.includes(current) ? <option value={current}>{current} (not permitted)</option> : null}
                    </Select>
                  ) : (
                    <input aria-label={`Attribute ${a}`} value={draft} readOnly={readOnly}
                      className="h-8 rounded-md border border-line bg-surface px-2 text-[12.5px] text-ink"
                      onChange={(e) => setAttrDraft({ ...attrDraft, [a]: e.target.value })}
                      onBlur={() => { if (draft !== (current || '')) apply(`Set ${a}`, (p) => { setAttribute(p, path, a, draft || null); return null; }); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                  )}
                </label>
              );
            })}
          </div>
        ) : <p className="text-[12px] text-ink-3">None.</p>}
      </div>

      {!readOnly ? (
        <div className="px-5 pb-4 space-y-2">
          <p className="text-[12px] font-medium text-ink-2">Insert</p>
          <div className="grid grid-cols-2 gap-2">
            {parent ? <InsertSelect label="Before" testId="insert-before" options={before} onPick={(n) => apply(`Insert ${n}`, (p) => insertElement(p, path.slice(0, -1), index, n, model))} /> : null}
            {parent ? <InsertSelect label="After" testId="insert-after" options={after} onPick={(n) => apply(`Insert ${n}`, (p) => insertElement(p, path.slice(0, -1), index + 1, n, model))} /> : null}
            <InsertSelect label="Inside, at the end" testId="insert-inside" options={inside} onPick={(n) => apply(`Insert ${n}`, (p) => insertElement(p, path, kids.length, n, model))} />
            {model.holdsText(name) ? (
              <InsertSelect label={selected.caret ? 'At the cursor' : 'At the cursor (click in the text)'} testId="insert-caret" options={atCaret}
                onPick={(n) => apply(`Insert ${n}`, (p) => insertInline(p, path, selected.caret.nodeIndex, selected.caret.offset, n, model))} />
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Button size="sm" icon="arrowUp" disabled={!canUp} title={canUp ? 'Move up' : 'Not allowed there'} onClick={() => apply(`Move ${name}`, (p) => moveElement(p, path, -1))}>Move up</Button>
            <Button size="sm" icon="arrowDown" disabled={!canDown} title={canDown ? 'Move down' : 'Not allowed there'} onClick={() => apply(`Move ${name}`, (p) => moveElement(p, path, 1))}>Move down</Button>
            <Button size="sm" icon="trash" variant="danger-ghost" disabled={!canDelete} title={canDelete ? 'Delete' : `<${parent ? parent.nodeName : name}> needs it`}
              onClick={() => apply(`Delete ${name}`, (p) => { removeElement(p, path); return path.length ? path.slice(0, -1) : null; })}>Delete</Button>
          </div>
        </div>
      ) : null}
      {problemList}
    </div>
  );
}
