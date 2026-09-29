import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCore } from "@fabdesk/client-core";
import { Button, Dialog, Input } from "../components/ui";
import { Icon } from "../components/Icon";

/** Mounted only while open so canceled names and locations never leak into the next project. */
export function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { client, host } = useCore();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A native folder picker describes this computer, never a connected remote computer.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname);
  const canPick = local && !!host.pickDirectory;
  const close = () => { if (!pending && !picking) onClose(); };
  const pick = async () => {
    if (!canPick || !host.pickDirectory) return;
    setPicking(true);
    setError(null);
    try { const path = await host.pickDirectory(); if (path) setDirectory(path); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPicking(false); }
  };
  const create = async () => {
    if (!name.trim() || pending || picking) return;
    setPending(true);
    setError(null);
    try {
      const project = await client.createProject(name.trim(), directory ?? undefined);
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
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium">Project location</span>
          <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-bg/40 p-4">
            <div className="flex w-full min-w-0 items-start gap-3">
              <Icon name="folder" className="mt-0.5 shrink-0 text-muted" />
              <div className="min-w-0 text-[13px]">
                <div className="break-all font-medium">{directory ?? "Default projects folder"}</div>
                <p className="mt-1 text-xs leading-5 text-muted">A new folder will be created here for your project.</p>
              </div>
            </div>
            {canPick ? <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={pending || picking} onClick={() => void pick()}>{picking ? "Choosing…" : directory ? "Change folder" : "Choose folder…"}</Button>
              {directory && <Button type="button" disabled={pending || picking} onClick={() => setDirectory(null)}>Use default</Button>}
            </div> : <p className="text-xs leading-5 text-muted">{local ? "Folder selection is available in the desktop app." : "The project will be created on the connected computer."}</p>}
          </div>
        </div>
        {error && <p role="alert" className="break-words text-[13px] text-danger">{error}</p>}
        <div className="flex flex-wrap justify-end gap-3 pt-2">
          <Button type="button" disabled={pending || picking} onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || pending || picking}>{pending ? "Creating…" : "Create project"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
