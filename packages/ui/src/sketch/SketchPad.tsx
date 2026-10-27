import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Spinner } from "../components/ui";
import { editableSketchPaths, createSketchDraftSession, useCoreClient, useProject } from "@fabdesk/client-core";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { basename } from "../util";

const Excalidraw = lazy(() => import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw })));
type Scenes = Map<string, ExcalidrawInitialDataState>;

/** Capture ownership when opened, never from whichever chat is active when upload finishes. */
export function SketchPad() {
  const open = useUiStore((s) => s.sketchOpen);
  const scenes = useRef<Scenes>(new Map());
  return open ? <SketchSession scenes={scenes.current} /> : null;
}

function SketchSession({ scenes }: { scenes: Scenes }) {
  const client = useCoreClient();
  const qc = useQueryClient();
  const [target] = useState(() => {
    const ui = useUiStore.getState();
    return { projectId: ui.activeProjectId, threadId: ui.activeThreadId };
  });
  const [session] = useState(() => createSketchDraftSession({
    client,
    projectId: target.projectId,
    onProjectCreated: (id) => {
      useUiStore.getState().adoptSketchProject(id);
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  }));
  const project = useProject(target.projectId);
  const savedDrawings = editableSketchPaths(project.data?.files ?? []);
  const [savedPath, setSavedPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasDrawing, setHasDrawing] = useState(false);
  const needsProjectChat = !!target.threadId && !target.projectId;
  const [mode, setMode] = useState(() => useUiStore.getState().sketchMode);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const [error, setError] = useState<string | null>(null);
  const initialScene = useRef(scenes.get(newChatDraftKey(target.projectId)) ?? null);
  const rememberScene = useCallback(() => {
    const scene = initialScene.current;
    if (scene) scenes.set(newChatDraftKey(session.projectId), scene);
  }, [scenes, session]);
  const close = useCallback(() => {
    if (busyRef.current) return;
    rememberScene();
    useUiStore.getState().setSketchOpen(false);
  }, [rememberScene]);

  const attach = async () => {
    if (busyRef.current) return;
    // Moving an existing projectless chat needs an explicit history migration, not a UI-only reassignment.
    if (needsProjectChat) {
      setError("Start a new chat to save a sketch in a project. This conversation will stay here.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      let blob: Blob;
      let name: string;
      if (mode === "upload") {
        if (!file) throw new Error("Choose a PNG or JPEG image first.");
        blob = file;
        name = file.name;
      } else {
        const api = apiRef.current;
        if (!api) throw new Error("The drawing canvas is still loading. Try again in a moment.");
        const { exportToBlob } = await import("@excalidraw/excalidraw");
        const elements = api.getSceneElements().filter((element) => !element.isDeleted);
        if (elements.length === 0) throw new Error("Draw something first.");
        blob = await exportToBlob({
          elements,
          appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false, exportEmbedScene: true },
          files: api.getFiles(), mimeType: "image/png", exportPadding: 16,
        });
        name = `sketch-${Date.now()}.excalidraw.png`;
      }
      const saved = await session.save(blob, name);
      const key = target.threadId ?? newChatDraftKey(saved.projectId);
      useUiStore.getState().addAttachment(key, { path: saved.path, mime: mode === "draw" ? "image/png" : file?.type || (/\.jpe?g$/i.test(name) ? "image/jpeg" : "image/png"), label: basename(saved.path) });
      void qc.invalidateQueries({ queryKey: ["project", saved.projectId] });
      scenes.delete(newChatDraftKey(target.projectId));
      scenes.delete(newChatDraftKey(saved.projectId));
      useUiStore.getState().setSketchOpen(false);
      useUiStore.getState().focusComposer();
    } catch (e) {
      rememberScene();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const openSavedDrawing = async () => {
    if (busyRef.current || !target.projectId || !savedDrawings.includes(savedPath)) return;
    const api = apiRef.current;
    if (!api) { setError("The drawing canvas is still loading. Try again in a moment."); return; }
    busyRef.current = true; setBusy(true); setLoading(true); setError(null);
    try {
      const blob = await client.readFileBlob(target.projectId, savedPath);
      const { loadFromBlob } = await import("@excalidraw/excalidraw");
      const scene = await loadFromBlob(new File([blob], basename(savedPath), { type: "image/png" }), null, null);
      if (!scene.elements?.some(element => !element.isDeleted)) throw new Error("This saved file has no editable drawing. Upload it as a reference image instead.");
      // Fetch/decode completely before replacing the draft; a failed load leaves it intact.
      api.resetScene();
      api.addFiles(Object.values(scene.files ?? {}));
      api.updateScene({ elements: scene.elements, appState: scene.appState });
      api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: .65, maxZoom: 1 });
      initialScene.current = scene;
      rememberScene();
    } catch {
      setError("Could not open this drawing. Choose another saved copy, or use Upload image to attach a reference.");
    } finally {
      busyRef.current = false; setBusy(false); setLoading(false);
    }
  };

  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return (
    <Dialog open onClose={close} bare ariaLabel="Sketch or image" className="h-[85vh] w-[90vw] max-w-6xl">
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="text-sm font-semibold">Sketch or image</div>
          <div role="group" aria-label="Sketch source" className="flex gap-1">
            <Button size="sm" variant={mode === "draw" ? "secondary" : "ghost"} aria-pressed={mode === "draw"} disabled={busy} onClick={() => { setMode("draw"); setError(null); }}>Draw</Button>
            <Button size="sm" variant={mode === "upload" ? "secondary" : "ghost"} aria-pressed={mode === "upload"} disabled={busy} onClick={() => { rememberScene(); setMode("upload"); setError(null); }}>Upload image</Button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={close}>Close</Button>
            <Button variant="primary" size="sm" disabled={busy || needsProjectChat || (mode === "upload" && !file)} onClick={() => void attach()}>
              {loading ? "Opening…" : busy ? "Saving…" : "Save and attach"}
            </Button>
          </div>
        </div>
        <p className="border-b border-border px-3 py-2 text-xs text-muted">
          {target.projectId ? mode === "draw" ? "Save an editable PNG in this project and attach it to your next message. Each save keeps a new copy." : "Save the original image in this project and attach it to your next message." : "Saving creates a project automatically. Your sketch stays with it; nothing is sent to the agent yet."}
        </p>
        {mode === "draw" && savedDrawings.length > 0 && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
          <label className="flex min-w-0 items-center gap-2">Saved drawings
            <select aria-label="Saved drawings" className="max-w-[45vw] rounded border border-border bg-panel px-2 py-1" value={savedPath} disabled={busy} onChange={event => setSavedPath(event.target.value)}>
              <option value="">Choose a drawing…</option>
              {savedDrawings.map(path => <option key={path} value={path}>{basename(path)}</option>)}
            </select>
          </label>
          <Button size="sm" disabled={busy || !savedPath} onClick={() => void openSavedDrawing()}>{hasDrawing ? "Replace draft with saved copy" : "Open a copy"}</Button>
          <span className="text-muted">The saved original stays unchanged.</span>
        </div>}
        {needsProjectChat && <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
          <span>This conversation has no project. Start a new project chat to save a sketch; this conversation stays here.</span>
          <Button size="sm" onClick={() => { close(); useUiStore.getState().startNewChatInProject(null); }}>Start a project chat</Button>
        </div>}
        {error && <p role="alert" className="px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="fd-sketch-canvas min-h-0 flex-1">
          {mode === "upload" ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
              <label className="flex max-w-full flex-col gap-3 text-sm font-medium">Choose a sketch or reference image
                <input type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" disabled={busy} onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setError(null);
                  if (next && !["image/png", "image/jpeg"].includes(next.type) && !/\.(png|jpe?g)$/i.test(next.name)) {
                    setError("Choose a PNG or JPEG image."); setFile(null); return;
                  }
                  setFile(next);
                }} />
              </label>
              {previewUrl && <img src={previewUrl} alt="Selected sketch" className="max-h-[45vh] max-w-full rounded-lg object-contain" />}
              {file && <p className="max-w-full break-all text-xs text-muted">{file.name} · Saved unchanged when you attach</p>}
              <p className="max-w-md text-center text-xs leading-5 text-muted">PNG or JPEG. A sketch helps explain your idea; describe any dimensions or electrical requirements in your message.</p>
            </div>
          ) : (
            <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
              <Excalidraw initialData={initialScene.current}
                excalidrawAPI={(api) => { apiRef.current = api; }}
                onChange={(elements, appState, files) => { initialScene.current = { elements, appState, files }; setHasDrawing(elements.some(element => !element.isDeleted)); }}
                theme={dark ? "dark" : "light"}
                UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }} />
            </Suspense>
          )}
        </div>
      </div>
    </Dialog>
  );
}
