import { useCallback, useEffect, useRef, useState } from 'react';

/*
  Two panes side by side with a divider that can be dragged or moved with
  the arrow keys (decisions.md SW1). The share of the left pane is kept per
  viewer. Below `stackBelow` pixels the panes stack and the divider goes,
  so both stay usable on a narrow window. Children are never unmounted when
  the layout changes, so an editor keeps its state.
*/
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function useWide(min) {
  const query = `(min-width: ${min}px)`;
  const [wide, setWide] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : true));
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return wide;
}

export default function SplitPane({ left, right, mode = 'split', fixedRight = 380, storageKey = 'agastya-split', initial = 55, min = 25, max = 75, stackBelow = 1024, label = 'Resize the panes' }) {
  const box = useRef(null);
  const wide = useWide(stackBelow);
  const [share, setShare] = useState(() => {
    try { const v = Number(localStorage.getItem(storageKey)); return v >= min && v <= max ? v : initial; } catch { return initial; }
  });
  const [dragging, setDragging] = useState(false);
  useEffect(() => { try { localStorage.setItem(storageKey, String(Math.round(share))); } catch { /* not kept */ } }, [share, storageKey]);

  const fromPointer = useCallback((clientX) => {
    const r = box.current && box.current.getBoundingClientRect();
    if (!r || !r.width) return;
    setShare(clamp(((clientX - r.left) / r.width) * 100, min, max));
  }, [min, max]);

  useEffect(() => {
    if (!dragging) return undefined;
    const move = (e) => fromPointer(e.clientX);
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [dragging, fromPointer]);

  const onKey = (e) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setShare((s) => clamp(s - step, min, max)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setShare((s) => clamp(s + step, min, max)); }
    if (e.key === 'Home') { e.preventDefault(); setShare(min); }
    if (e.key === 'End') { e.preventDefault(); setShare(max); }
  };

  /*
    mode: 'split' (the divider), 'fixed' (the right pane a fixed column, as
    the editor's side panels are), 'right' (the left pane hidden but still
    mounted). The tree is the same in every mode, so nothing remounts.
  */
  const split = wide && mode === 'split';
  const leftStyle = mode === 'right' ? { display: 'none' } : split ? { flex: `0 0 ${share}%` } : wide && mode === 'fixed' ? { flex: '1 1 0%' } : undefined;
  const rightStyle = wide && mode === 'fixed' ? { flex: `0 0 ${fixedRight}px` } : undefined;
  return (
    <div ref={box} data-testid="split-pane" data-mode={mode} data-share={Math.round(share)} className={wide ? `flex items-stretch min-w-0 ${mode === 'fixed' ? 'gap-6' : 'gap-0'}` : 'grid gap-4'}
      style={dragging ? { userSelect: 'none', cursor: 'col-resize' } : undefined}>
      <div key="left" className="min-w-0" style={leftStyle}>{left}</div>
      {split ? (
        <div key="divider" role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
          aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(share)}
          onPointerDown={(e) => { e.preventDefault(); setDragging(true); }} onKeyDown={onKey}
          className="group w-3 shrink-0 cursor-col-resize flex items-stretch justify-center focus:outline-none">
          <span className={`w-0.5 rounded-full ${dragging ? 'bg-accent' : 'bg-line group-hover:bg-accent group-focus-visible:bg-accent'}`} />
        </div>
      ) : null}
      <div key="right" className="min-w-0 flex-1" style={rightStyle}>{right}</div>
      {/* While dragging, the PDF frame would swallow the pointer: a cover keeps the drag going. */}
      {dragging ? <div className="fixed inset-0 z-50 cursor-col-resize" /> : null}
    </div>
  );
}
