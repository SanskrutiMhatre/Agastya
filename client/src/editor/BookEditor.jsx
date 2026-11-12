import { useState } from 'react';
import { Card } from '../components/ui/Card.jsx';
import BookDesignView from './BookDesignView.jsx';
import { XmlView } from '../pages/projects/PublicationTab.jsx';

/*
  A JSS book, Design or XML (decisions.md ST9) — the same split S1000D's
  data-module editor already has. Each view is fully self-contained (its own
  load and its own save, both through the same GET/PUT .../publication
  XmlView already used): switching views always reloads from the server, so
  whichever was saved last is what the other one then shows. An edit not yet
  saved is lost on switching, same as leaving the page without saving.
*/
export default function BookEditor({ project, canWrite, overriding = false, drafts = true, onSaved }) {
  const [view, setView] = useState('design');
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Book view" className="inline-flex rounded-md border border-line p-0.5 bg-surface-2">
        {[['design', 'Design'], ['xml', 'XML']].map(([v, label]) => (
          <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}
            className={`rounded px-3 py-1.5 text-[13px] font-medium transition-colors ${view === v ? 'bg-surface shadow-card text-ink' : 'text-ink-2 hover:text-ink'}`}>
            {label}
          </button>
        ))}
      </div>
      {view === 'design' ? (
        <Card className="p-4"><BookDesignView key="design" project={project} canWrite={canWrite} overriding={overriding} onSaved={onSaved} /></Card>
      ) : (
        <XmlView key="xml" project={project} canWrite={canWrite} overriding={overriding} drafts={drafts} onSaved={onSaved} />
      )}
    </div>
  );
}
