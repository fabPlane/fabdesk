import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCore } from "@fabdesk/client-core";
import { Button, Dialog, Input } from "../components/ui";
import { Icon } from "../components/Icon";

/** Mounted only while open so canceled names never leak into the next project. */
export function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { client } = useCore();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!pending) onClose(); };
  const create = async () => {
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const project = await client.createProject(name.trim());
      await qc.invalidateQueries({ queryKey: ["projects"] });
      onCreated(project.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };
  return (
    <Dialog open onClose={close} title="Create project" className="!w-[520px]">
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label className="flex flex-col gap-2 text-[13px] font-medium">
          Project name
          <div className="relative">
            <Icon name="folder" className="pointer-events-none absolute left-3 top-3 text-muted" />
            <Input autoFocus required maxLength={80} value={name} disabled={pending} onChange={(e) => setName(e.target.value)} placeholder="My project" className="h-11 pl-10" data-testid="create-project-name" />
          </div>
        </label>
        <p className="text-xs leading-5 text-muted">A new folder will be created in the connected computer’s default projects folder.</p>
        {error && <p role="alert" className="break-words text-[13px] text-danger">{error}</p>}
        <div className="flex flex-wrap justify-end gap-3 pt-2">
          <Button type="button" disabled={pending} onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || pending}>{pending ? "Creating…" : "Create project"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
