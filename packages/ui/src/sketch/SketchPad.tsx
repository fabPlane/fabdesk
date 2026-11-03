import { DisclosureSummary } from "../components/DisclosureSummary";
import "@excalidraw/excalidraw/index.css";
import { isEditableSketchSource, MAX_EDITABLE_SKETCH_BYTES } from "@fabdesk/protocol";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Spinner } from "../components/ui";
import { sketchRecoverySignature, sketchRecoveryKey, editableSketchPaths, createSketchDraftSession, useCoreClient, useProject } from "@fabdesk/client-core";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { basename } from "../util";
import { sketchRecoveryStore } from "./recovery-storage";

const Excalidraw = lazy(() => import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw })));
type Scenes = Map<string, { scene: ExcalidrawInitialDataState; source?: File }>;

/** Capture ownership when opened, never from whichever chat is active when upload finishes. */
export function SketchPad() {
  const open = useUiStore((s) => s.sketchOpen);
  const scenes = useRef<Scenes>(new Map());
  return open ? <SketchSession scenes={scenes.current} /> : null;
}

function SketchSession({ scenes }: { scenes: Scenes }) {
  const connectedClient = useCoreClient();
  const [client] = useState(() => connectedClient);
  const qc = useQueryClient();
  const [target] = useState(() => {
    const ui = useUiStore.getState();
    return { projectId: ui.activeProjectId, threadId: ui.activeThreadId, sourcePath: ui.sketchSourcePath };
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
  const [savedPath, setSavedPath] = useState(target.sourcePath ?? "");
  const [loading, setLoading] = useState(false);
  const [hasDrawing, setHasDrawing] = useState(false);
  const needsProjectChat = !!target.threadId && !target.projectId;
  const [mode, setMode] = useState(() => useUiStore.getState().sketchMode);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const requestedCopyHandled = useRef(false);
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
  const [initialKey] = useState(() => sketchRecoveryKey(client.baseUrl, target.projectId, target.threadId));
  const currentKey = () => sketchRecoveryKey(client.baseUrl, session.projectId, target.threadId);
  const memory = scenes.get(initialKey);
  const [recovering, setRecovering] = useState(!memory);
  const [recoveryStatus, setRecoveryStatus] = useState("");
  const mounted = useRef(true), completed = useRef(false), revision = useRef(0);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needsRecovery = useRef(!!memory?.source || !!memory?.scene.elements?.some(element => !element.isDeleted));
  const lastSignature = useRef(sketchRecoverySignature(memory?.scene.elements ?? []));
  const initialScene = useRef(memory?.scene ?? null);
  const originalSource = useRef<File | null>(memory?.source ?? null);
  const sourceInput = useRef<HTMLInputElement>(null);
  const canvasRoot = useRef<HTMLDivElement>(null);
  const sourceOptions = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // Present the selected copy without replacing a recovered or unsaved drawing.
    if (target.sourcePath && sourceOptions.current) sourceOptions.current.open = true;
  }, [target.sourcePath]);
  const [sourceName, setSourceName] = useState(memory?.source?.name ?? "");
  const rememberScene = useCallback(() => {
    const scene = initialScene.current;
    if (scene && needsRecovery.current && !completed.current) {
      scenes.set(currentKey(), { scene, ...(originalSource.current ? { source: originalSource.current } : {}) });
      if (currentKey() !== initialKey) scenes.delete(initialKey);
    }
  }, [scenes, session, initialKey]);
  const persistRecovery = useCallback(async () => {
    if (completed.current || !needsRecovery.current || !initialScene.current) return;
    const ticket = ++revision.current, snapshot = initialScene.current, source = originalSource.current;
    if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
    try {
      const { serializeAsJSON } = await import("@excalidraw/excalidraw");
      if (completed.current || ticket !== revision.current) return;
      const scene = serializeAsJSON(snapshot.elements ?? [], snapshot.appState ?? {}, snapshot.files ?? {}, "local");
      const key = sketchRecoveryKey(client.baseUrl, session.projectId, target.threadId);
      await sketchRecoveryStore.write(key, { version: 1, scene, updatedAt: Date.now(), ...(source ? { source: { blob: source, name: source.name, lastModified: source.lastModified } } : {}) });
      if (key !== initialKey) await sketchRecoveryStore.remove(initialKey);
      if (mounted.current && ticket === revision.current) setRecoveryStatus("Draft kept on this device · Save and attach to add it to the project.");
    } catch {
      if (mounted.current && !completed.current) setRecoveryStatus("Could not keep a recovery copy. Save and attach before reloading or quitting.");
    }
  }, [client, session, initialKey, target.threadId]);
  const scheduleRecovery = () => {
    if (completed.current) return;
    needsRecovery.current = true;
    ++revision.current;
    if (mounted.current) setRecoveryStatus("Keeping local draft…");
    if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
    recoveryTimer.current = setTimeout(() => { void persistRecovery(); }, 350);
  };
  useEffect(() => {
    let alive = true;
    if (memory) { setHasDrawing(!!memory.scene.elements?.some(element => !element.isDeleted)); setRecovering(false); void persistRecovery(); return; }
    void (async () => {
      try {
        const record = await sketchRecoveryStore.read(initialKey);
        if (record) {
          const { loadFromBlob } = await import("@excalidraw/excalidraw");
          const scene = await loadFromBlob(new Blob([record.scene], { type: "application/vnd.excalidraw+json" }), null, null);
          if (!alive) return;
          initialScene.current = scene; needsRecovery.current = true;
          lastSignature.current = sketchRecoverySignature(scene.elements ?? []);
          setHasDrawing(!!scene.elements?.some(element => !element.isDeleted));
          originalSource.current = record.source ? new File([record.source.blob], record.source.name, { type: "application/vnd.excalidraw+json", lastModified: record.source.lastModified }) : null;
          setSourceName(originalSource.current?.name ?? "");
          setRecoveryStatus("Recovered local draft · Save and attach to add it to the project.");
        }
      } catch { if (alive) setRecoveryStatus("Could not recover the local draft. Saved project drawings are still available."); }
      finally { if (alive) setRecovering(false); }
    })();
    return () => { alive = false; };
  }, [initialKey]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
      rememberScene(); void persistRecovery();
    };
  }, [persistRecovery, rememberScene]);
  const close = useCallback(() => {
    if (busyRef.current) return;
    rememberScene(); void persistRecovery();
    useUiStore.getState().setSketchOpen(false);
  }, [rememberScene, persistRecovery]);

  const attach = async () => {
    if (busyRef.current || recovering || completed.current) return;
    ++revision.current;
    if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
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
      const saved = await session.save(blob, name, mode === "draw" && originalSource.current ? { file: originalSource.current, name: originalSource.current.name } : undefined);
      const key = target.threadId ?? newChatDraftKey(saved.projectId);
      useUiStore.getState().addAttachment(key, { path: saved.path, mime: mode === "draw" ? "image/png" : file?.type || (/\.jpe?g$/i.test(name) ? "image/jpeg" : "image/png"), label: basename(saved.path) });
      void qc.invalidateQueries({ queryKey: ["project", saved.projectId] });
      if (mode === "draw") {
        completed.current = true; ++revision.current;
        scenes.delete(initialKey); scenes.delete(currentKey());
        try {
          for (const key of new Set([initialKey, currentKey()])) await sketchRecoveryStore.remove(key);
        } catch {
          setRecoveryStatus("Saved and attached. The local recovery copy could not be cleared; you can close this window.");
          return;
        }
      } else rememberScene();
      useUiStore.getState().setSketchOpen(false);
      useUiStore.getState().focusComposer();
    } catch (e) {
      rememberScene(); void persistRecovery();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const loadDrawing = async (file: File, source: File | null) => {
    const api = apiRef.current;
    if (!api) throw new Error("The drawing canvas is still loading. Try again in a moment.");
    const { loadFromBlob } = await import("@excalidraw/excalidraw");
    const scene = await loadFromBlob(file, null, null);
    if (!scene.elements?.some(element => !element.isDeleted)) throw new Error("This file has no editable drawing.");
    // Finish decoding before replacing the current draft.
    api.resetScene(); api.addFiles(Object.values(scene.files ?? {}));
    api.updateScene({ elements: scene.elements, appState: scene.appState });
    api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: .65, maxZoom: 1 });
    initialScene.current = scene; setHasDrawing(!!scene.elements?.some(element => !element.isDeleted));
    originalSource.current = source; setSourceName(source?.name ?? "");
    scheduleRecovery(); rememberScene();
    if (sourceOptions.current) sourceOptions.current.open = false;
    requestAnimationFrame(() => {
      if (mounted.current && useUiStore.getState().activeProjectId === target.projectId) canvasRoot.current?.querySelector<HTMLElement>(".excalidraw-container")?.focus();
    });
  };
  const importDrawing = async (file: File) => {
    if (busyRef.current || recovering || completed.current) return;
    busyRef.current = true; setBusy(true); setLoading(true); setError(null);
    try {
      if (!/\.excalidraw$/i.test(file.name)) throw new Error("Choose an .excalidraw drawing.");
      if (file.size > MAX_EDITABLE_SKETCH_BYTES) throw new Error("Choose a drawing no larger than 10 MiB.");
      if (!isEditableSketchSource(await file.text())) throw new Error("This file is not a supported .excalidraw drawing (version 2).");
      await loadDrawing(file, file);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not import this drawing."); }
    finally { busyRef.current = false; setBusy(false); setLoading(false); }
  };

  const openSavedDrawing = async () => {
    if (busyRef.current || recovering || completed.current || !target.projectId || !savedDrawings.includes(savedPath)) return;
    const api = apiRef.current;
    if (!api) { setError("The drawing canvas is still loading. Try again in a moment."); return; }
    busyRef.current = true; setBusy(true); setLoading(true); setError(null);
    try {
      const blob = await client.readFileBlob(target.projectId, savedPath);
      await loadDrawing(new File([blob], basename(savedPath), { type: /\.excalidraw$/i.test(savedPath) ? "application/vnd.excalidraw+json" : "image/png" }), null);
    } catch {
      setError("Could not open this drawing. Choose another saved copy, or use Upload image to attach a reference.");
    } finally {
      busyRef.current = false; setBusy(false); setLoading(false);
    }
  };

  useEffect(() => {
    if (requestedCopyHandled.current || !target.sourcePath || recovering || !canvasReady || project.isFetching || !project.data) return;
    requestedCopyHandled.current = true;
    // An explicit copy request opens immediately only when there is no recovered work to replace.
    if (needsRecovery.current || apiRef.current?.getSceneElements().some(element => !element.isDeleted)) {
      setRecoveryStatus("Your local draft is kept. Choose Replace draft with saved copy in Drawing options to open the requested drawing.");
      return;
    }
    if (!savedDrawings.includes(target.sourcePath)) {
      setError("The selected saved drawing is no longer available. Choose another drawing in Drawing options.");
      return;
    }
    void openSavedDrawing();
  }, [canvasReady, recovering, project.isFetching, project.data]);

  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return (
    <Dialog open onClose={close} bare ariaLabel="Sketch or image" className="h-[85vh] w-[90vw] max-w-6xl">
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="text-sm font-semibold">Sketch or image</div>
          <div role="group" aria-label="Sketch source" className="flex gap-1">
            <Button size="sm" variant={mode === "draw" ? "secondary" : "ghost"} aria-pressed={mode === "draw"} disabled={busy || recovering || completed.current} onClick={() => { setMode("draw"); setError(null); }}>Draw</Button>
            <Button size="sm" variant={mode === "upload" ? "secondary" : "ghost"} aria-pressed={mode === "upload"} disabled={busy || recovering || completed.current} onClick={() => { rememberScene(); setMode("upload"); setError(null); }}>Upload image</Button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={close}>Close</Button>
            <Button variant="primary" size="sm" disabled={busy || recovering || completed.current || needsProjectChat || (mode === "upload" && !file)} onClick={() => void attach()}>
              {loading ? "Opening…" : busy ? "Saving…" : "Save and attach"}
            </Button>
          </div>
        </div>
        <div className="fd-sketch-source-bar">
          {mode === "draw" && <>
            {!hasDrawing && <Button size="sm" disabled={busy || recovering || completed.current || needsProjectChat} onClick={() => sourceInput.current?.click()}>Import drawing…</Button>}
            <input ref={sourceInput} type="file" accept=".excalidraw,application/vnd.excalidraw+json" aria-label="Import editable drawing" hidden disabled={busy || recovering || completed.current} onChange={event => { const next = event.target.files?.[0]; event.target.value = ""; if (next) void importDrawing(next); }} />
            <span className="fd-sketch-source-name" title={sourceName || (hasDrawing ? "Editable drawing" : "New drawing · .excalidraw supported")}>{sourceName || (hasDrawing ? "Editable drawing" : ".excalidraw supported")}</span>
            {hasDrawing && <Button size="sm" variant="ghost" disabled={busy || recovering || completed.current} onClick={() => apiRef.current?.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: .65, maxZoom: 1 })}>Fit drawing</Button>}
          </>}
          <details ref={sourceOptions} className="fd-sketch-options">
            <DisclosureSummary icon={mode === "draw" ? "settings" : "image"} label={mode === "draw" ? "Drawing options" : "Image details"} variant="compact" />
            <div>
              <p>{target.projectId ? mode === "draw" ? "Save an editable PNG in this project and attach it to your next message. Each save keeps a new copy." : "Save the original image in this project and attach it to your next message." : "Saving keeps an idea draft. Create a project when you’re ready to build; nothing is sent to the agent yet."}</p>
              {mode === "draw" && <>
                <p>{sourceName ? `${sourceName} · Original file will be preserved when you save.` : "Import opens a copy; nothing is written until you save."}</p>
                {hasDrawing && <Button size="sm" disabled={busy || recovering || completed.current || needsProjectChat} onClick={() => sourceInput.current?.click()}>Replace draft from file…</Button>}
                {savedDrawings.length > 0 && <div className="fd-sketch-saved-options">
                  <label>Saved drawings
                    <select aria-label="Saved drawings" value={savedPath} disabled={busy || recovering || completed.current} onChange={event => setSavedPath(event.target.value)}>
                      <option value="">Choose a drawing…</option>
                      {savedDrawings.map(path => <option key={path} value={path}>{basename(path)}</option>)}
                    </select>
                  </label>
                  <Button size="sm" disabled={busy || recovering || completed.current || !savedDrawings.includes(savedPath)} onClick={() => void openSavedDrawing()}>{hasDrawing ? "Replace draft with saved copy" : "Open a copy"}</Button>
                  <p>The saved original stays unchanged.</p>
                </div>}
              </>}
            </div>
          </details>
        </div>
        {needsProjectChat && <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
          <span>This conversation has no project. Start a new project chat to save a sketch; this conversation stays here.</span>
          <Button size="sm" onClick={() => { close(); useUiStore.getState().startNewChatInProject(null); }}>Start a project chat</Button>
        </div>}
        {mode === "draw" && recoveryStatus && <p role="status" className="border-b border-border px-3 py-2 text-xs text-muted">{recoveryStatus}</p>}
        {error && <p role="alert" className="px-3 py-2 text-sm text-danger">{error}</p>}
        <div ref={canvasRoot} className="fd-sketch-canvas min-h-0 flex-1">
          {recovering ? <div className="flex h-full items-center justify-center gap-2 text-sm text-muted"><Spinner />Checking for a local draft…</div> : mode === "upload" ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
              <label className="flex max-w-full flex-col gap-3 text-sm font-medium">Choose a sketch or reference image
                <input type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" disabled={busy || recovering || completed.current} onChange={(event) => {
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
                excalidrawAPI={(api) => { apiRef.current = api; setCanvasReady(true); }}
                onChange={(elements, appState, files) => {
                  initialScene.current = { elements, appState, files }; setHasDrawing(elements.some(element => !element.isDeleted));
                  const signature = sketchRecoverySignature(elements);
                  if (lastSignature.current !== signature) { lastSignature.current = signature; scheduleRecovery(); }
                }}
                theme={dark ? "dark" : "light"}
                UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }} />
            </Suspense>
          )}
        </div>
      </div>
    </Dialog>
  );
}
