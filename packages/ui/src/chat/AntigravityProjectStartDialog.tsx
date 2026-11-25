import { useState } from "react";
import { ErrorNotice } from "../components/ErrorNotice";
import { Button, Dialog, Input } from "../components/ui";

export function AntigravityProjectStartDialog({ busy, error, initialName, onCancel, onConfirm }: {
  busy: boolean;
  error: unknown;
  initialName: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  return <Dialog open closeDisabled={busy} onClose={onCancel} title="Create a project for Antigravity" className="!w-[480px]">
    <form className="space-y-4" onSubmit={event => {
      event.preventDefault();
      if (name.trim() && !busy) onConfirm(name.trim());
    }}>
      <p className="text-sm leading-6 text-muted">Antigravity needs a project before it can work on your idea. Your message and any references will be sent to the conversation after setup.</p>
      <label className="flex flex-col gap-2 text-sm font-medium">Project name
        <Input autoFocus required maxLength={80} placeholder="e.g. Blinking LED board" value={name} onChange={event => setName(event.target.value)} disabled={busy} />
      </label>
      <p className="text-xs text-muted">The project will be saved in your default projects folder.</p>
      {error != null && <ErrorNotice error={error} />}
      <div className="flex justify-end gap-3">
        <Button type="button" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>Create project & send</Button>
      </div>
    </form>
  </Dialog>;
}
