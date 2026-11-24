import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCore, useProject } from "@fabdesk/client-core";
import { BoardMaterialBadge, BoardMaterialPicker, type BoardMaterialValue } from "./BoardMaterialPicker";

export function BoardMaterialSettings({ projectId }: { projectId: string }) {
  const { client } = useCore();
  const qc = useQueryClient();
  const detail = useProject(projectId);
  const board = detail.data?.manifest.board;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value: BoardMaterialValue = {
    material: board?.material ?? "fr4",
    construction: board?.construction ?? "2l",
  };

  const save = async (next: BoardMaterialValue) => {
    if (!detail.data) return;
    setPending(true);
    setError(null);
    try {
      await client.request(`/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        json: {
          manifest: {
            board: {
              ...detail.data.manifest.board,
              material: next.material,
              construction: next.construction,
            },
          },
        },
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["project", projectId] }),
        qc.invalidateQueries({ queryKey: ["projects"] }),
        qc.invalidateQueries({ queryKey: ["project-order", projectId] }),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-1" data-testid="board-material-settings">
      <button
        type="button"
        className="inline-flex items-center gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <BoardMaterialBadge
          {...(board?.material ? { material: board.material } : {})}
          {...(board?.construction ? { construction: board.construction } : {})}
        />
        <span className="text-[11px] text-muted">{open ? "Close" : "Change"}</span>
      </button>
      {open && (
        <div className="mt-2 max-w-md rounded-xl border border-border bg-panel-2/40 p-3">
          <BoardMaterialPicker compact value={value} onChange={(next) => void save(next)} />
          {pending && <p className="mt-2 text-[11px] text-muted">Saving…</p>}
          {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
          <p className="mt-2 text-[11px] text-muted">
            Rebuild or run board_material_set to rewrite the KiCad stackup and rules.
          </p>
        </div>
      )}
    </div>
  );
}
