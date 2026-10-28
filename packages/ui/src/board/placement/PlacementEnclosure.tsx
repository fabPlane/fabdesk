import { useEffect, useRef, useState } from "react";
import { useCoreClient } from "@fabdesk/client-core";
import type { PlacementSession } from "@fabdesk/client-core/placement";
import { Dialog } from "../../components/ui";
import {
  EnclosureScreen,
  enclosureFromTool,
  enclosureWithSavedPreview,
  enclosureFailure,
  DEFAULT_ENCLOSURE_DRAFT,
  type EnclosureView,
} from "../EnclosurePanel";
import { placementJob } from "./placement-jobs";
import { useUiStore } from "../../stores/ui";

export function PlacementEnclosure({
  projectId,
  session,
  onClose,
}: {
  projectId: string;
  session: PlacementSession;
  onClose: () => void;
}) {
  const client = useCoreClient(),
    [view, setView] = useState<EnclosureView | null>(null),
    [draft, setDraft] = useState(DEFAULT_ENCLOSURE_DRAFT),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    live = useRef(true);
  const boardPath = "placement/enclosure-source.kicad_pcb";
  const snapshot = useRef<string | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function run(action: "generate" | "status" | "check") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!snapshot.current) {
        const r = await placementJob({ kind: "export", session }, new AbortController().signal);
        snapshot.current = r.text!;
      }
      await client.writeFile(projectId, boardPath, snapshot.current);
      const res = await client.callTool("cad_enclosure", {
        projectId,
        action,
        boardPath,
        name: "placement-case",
        applyToCad: false,
        outlineOffsetMm: Number(draft.outlineOffsetMm),
        clearanceMm: Number(draft.clearanceMm),
        ventPattern: draft.ventPattern,
        ventFaces: draft.ventFaces,
        snapFit: draft.snapFit,
      });
      const next = await enclosureWithSavedPreview(enclosureFromTool(res), (path) =>
        client.readFile(projectId, path),
      );
      if (live.current) setView(next);
    } catch (e) {
      if (live.current) setError(enclosureFailure(e).message || String(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      className="w-[1080px]"
      title="Enclosure from this placement"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="fd-placement-enclosure" data-testid="placement-enclosure">
        <p>
          The case uses this draft's{" "}
          <strong>
            {session.board.w.toFixed(2)} × {session.board.h.toFixed(2)} mm
          </strong>{" "}
          outline and component positions. Base STL, lid STL, STEP and a preview are saved under{" "}
          <strong>placement/enclosure</strong>. The source board, existing enclosure and FreeCAD
          model are unchanged.
        </p>
        <EnclosureScreen
          view={view}
          draft={draft}
          busy={busy}
          error={error}
          onDraftChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          onGenerate={() => void run("generate")}
          onCheck={() => void run("check")}
          onDownload={(path) =>
            void (async () => {
              try {
                const blob = await client.readFileBlob(projectId, path),
                  url = URL.createObjectURL(blob),
                  a = document.createElement("a");
                a.href = url;
                a.download = path.split("/").at(-1)!;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 10000);
              } catch (e) {
                setError(String(e));
              }
            })()
          }
          onOpenFiles={(path) => {
            onClose();
            useUiStore.getState().openProjectFile(path);
          }}
        />
        <p>
          Height and connector dimensions are estimated from board data. Inspect the generated case
          and clearances before printing.
        </p>
      </div>
    </Dialog>
  );
}
