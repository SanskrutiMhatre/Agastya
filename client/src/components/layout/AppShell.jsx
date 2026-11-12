import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import TopBar from './TopBar.jsx';

export default function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  // A project's own ProjectShell sidebar (Overview...Settings) is the real
  // navigation on these routes, so the global one steps back (decisions.md UI8).
  const inProject = /^\/projects\/[^/]+(\/|$)/.test(loc.pathname);
  // The editor-beside-its-PDF layout (a data module, or a JSS book's
  // workspace) wants the full width for both panes; everywhere else keeps
  // the comfortable reading width a page of tables, forms or cards wants.
  const isEditor = /^\/projects\/[^/]+\/(dms\/|workspace$)/.test(loc.pathname);
  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setDrawer(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">
        Skip to content
      </a>
      {/* Fixed sidebar on desktop; off-canvas drawer below 1024px. Compact (just the mark and a way back) while a project is open — its own sidebar takes over the navigation. */}
      <aside className={`hidden lg:block fixed inset-y-0 left-0 z-20 ${inProject ? 'w-16' : 'w-64'}`}>
        <Sidebar compact={inProject} />
      </aside>
      {drawer ? (
        <div className="lg:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-[rgb(8_16_27/0.55)]" onClick={() => setDrawer(false)} aria-hidden="true" />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-pop">
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      ) : null}
      <div className={inProject ? 'lg:pl-16' : 'lg:pl-64'}>
        <TopBar onMenu={() => setDrawer(true)} />
        <main id="main" tabIndex={-1} className={`${isEditor ? '' : 'mx-auto max-w-7xl'} px-4 sm:px-6 lg:px-8 py-6 sm:py-8 outline-none`}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
