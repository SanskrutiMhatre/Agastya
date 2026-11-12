import { useEffect, useState } from 'react';
import { Dialog } from './ui/Dialog.jsx';
import Button from './ui/Button.jsx';
import { Field, Input } from './ui/Field.jsx';
import { Alert } from './ui/States.jsx';

// One text field in a dialog: a name, or the name typed again to confirm. Shared by ProjectsPage and WorkspacesPage.
export default function NameDialog({ open, title, description, label, initial = '', action, danger = false, onClose, onSubmit }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setValue(initial); setError(null); } }, [open, initial]);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await onSubmit(value.trim()); onClose(); } catch (err) { setError(err.message); }
    setBusy(false);
  }
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} size="sm"
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} type="submit" form="name-dialog" loading={busy}>{action}</Button></>}>
      <form id="name-dialog" onSubmit={submit} className="space-y-3" noValidate>
        {error ? <Alert>{error}</Alert> : null}
        <Field label={label} required>{(p) => <Input {...p} value={value} onChange={(e) => setValue(e.target.value)} maxLength={80} autoFocus />}</Field>
      </form>
    </Dialog>
  );
}
