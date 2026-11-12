import { NavLink } from 'react-router-dom';
import Icon from '../Icon.jsx';
import { navFor } from '../../nav.js';
import { useAuth } from '../../auth.jsx';

export function Wordmark({ compact = false }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#1b3a5c" />
        <path d="M9 24 16 7l7 17" fill="none" stroke="#e8edf3" strokeWidth="2.6" strokeLinejoin="round" />
        <path d="M11.6 18h8.8" stroke="#c9a24a" strokeWidth="2.6" />
      </svg>
      {!compact ? (
        <div className="leading-tight">
          <p className="text-[15px] font-semibold tracking-wide text-nav-ink-strong">Agastya</p>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-nav-ink">S1000D authoring</p>
        </div>
      ) : null}
    </div>
  );
}

/*
  Collapsed while a project is open (decisions.md UI8): the project's own
  ProjectShell sidebar is the real navigation there, so this becomes just the
  mark and a way back, instead of competing for the same column.
*/
function CompactSidebar({ onNavigate }) {
  return (
    <nav aria-label="Main" className="flex h-full flex-col items-center bg-nav text-nav-ink">
      <div className="h-14 flex items-center justify-center w-full border-b border-white/5">
        <Wordmark compact />
      </div>
      <div className="py-4">
        <NavLink to="/" end onClick={onNavigate} title="Back to the dashboard" aria-label="Back to the dashboard"
          className="flex items-center justify-center rounded-md p-2.5 text-nav-ink hover:bg-white/5 hover:text-nav-ink-strong">
          <Icon name="arrowLeft" size={18} />
        </NavLink>
      </div>
    </nav>
  );
}

export default function Sidebar({ onNavigate, compact = false }) {
  const { me } = useAuth();
  const sections = navFor(me.user.role);
  const resets = (me.queues && me.queues.resets) || 0;
  const approvals = (me.queues && me.queues.approvals) || 0;

  if (compact) return <CompactSidebar onNavigate={onNavigate} />;

  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-nav text-nav-ink">
      <div className="h-14 flex items-center px-5 border-b border-white/5">
        <Wordmark />
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {sections.map((s) => (
          <div key={s.heading}>
            <p className="px-2 mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-nav-ink/70">{s.heading}</p>
            <ul className="space-y-0.5">
              {s.items.map((item) => (
                <li key={item.key}>
                  <NavLink
                    to={item.to} end={item.end} onClick={onNavigate}
                    className={({ isActive }) => `group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] transition-colors
                      ${isActive ? 'bg-nav-2 text-nav-ink-strong' : 'hover:bg-white/5 hover:text-nav-ink-strong'}`}
                  >
                    {({ isActive }) => (
                      <>
                        {isActive ? <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-brass" aria-hidden="true" /> : null}
                        <Icon name={item.icon} size={17} />
                        <span className="flex-1">{item.label}</span>
                        {item.phase ? <span className="rounded border border-white/15 px-1 font-mono text-[9.5px] uppercase tracking-wide text-nav-ink/80" title={`Arrives in phase ${item.phase}`}>P{item.phase}</span> : null}
                        {item.badge === 'resets' && resets > 0 ? (
                          <span className="rounded-full bg-brass text-[#1a1406] px-1.5 text-[11px] font-semibold tabular" aria-label={`${resets} pending reset requests`}>{resets}</span>
                        ) : null}
                        {item.badge === 'approvals' && approvals > 0 ? (
                          <span className="rounded-full bg-brass text-[#1a1406] px-1.5 text-[11px] font-semibold tabular" aria-label={`${approvals} requests waiting for your decision`} data-testid="approvals-badge">{approvals}</span>
                        ) : null}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="px-5 py-4 border-t border-white/5">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-nav-ink/60">Phase 5 · Backup and restore</p>
      </div>
    </nav>
  );
}
