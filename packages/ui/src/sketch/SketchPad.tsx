import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { Button, Dialog, Spinner } from "../components/ui";
import { useCoreClient } from "@fabdesk/client-core";
import { useUiStore, type PendingAttachment } from "../stores/ui";
import { basename } from "../util";

const Excalidraw = lazy(() => import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw })));

export interface SketchPadProps {
  onAttach: (attachment: PendingAttachment) => void;
}

/** Excalidraw in a modal; "Attach" exports a PNG, uploads it as a project sketch and hands back the path. */
export function SketchPad({ onAttach }: SketchPadProps) {
  const client = useCoreClient();
  const open = useUiStore((s) => s.sketchOpen);
  const setOpen = useUiStore((s) => s.setSketchOpen);
  const projectId = useUiStore((s) => s.activeProjectId);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);

  const attach = async () => {
    const api = apiRef.current;
    if (!api || !projectId) return;
    setBusy(true);
    setError(null);
    try {
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const elements = api.getSceneElements();
      if (elements.length === 0) throw new Error("Draw something first.");
      const blob = await exportToBlob({
        elements,
        appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false },
        files: api.getFiles(),
        mimeType: "image/png",
        exportPadding: 16,
      });
      const { path } = await client.uploadSketch(projectId, blob, `sketch-${Date.now()}.png`);
      onAttach({ path, mime: "image/png", label: basename(path) });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return (
    <Dialog open={open} onClose={close} bare className="h-[85vh] w-[90vw] max-w-6xl">
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <div className="text-sm font-semibold">Sketch</div>
          <div className="text-xs text-muted">Rough out the board or a schematic; the PNG is attached to your next message.</div>
          <div className="ml-auto flex items-center gap-2">
            {error && <span className="text-xs text-danger">{error}</span>}
            <Button size="sm" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={busy || !projectId} onClick={() => void attach()}>
              {busy ? "Uploading..." : "Attach to message"}
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {open && (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner />
                </div>
              }
            >
              <Excalidraw
                excalidrawAPI={(api) => {
                  apiRef.current = api;
                }}
                theme={dark ? "dark" : "light"}
                UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
              />
            </Suspense>
          )}
        </div>
      </div>
    </Dialog>
  );
}
