import {
  ART_LAYERS,
  IMAGE_CROPS,
  type ImageCrop,
  ART_STYLES,
  BOARD_FINISH,
  type ColorMode,
  OUTLINE_KINDS,
  buildBoardArt,
  fitArtPlacement,
  type ArtPlacement,
  type ArtOptions,
  decodeGray,
  type ArtLayer,
  type ArtStyle,
  type BoardColor,
  type GrayImage,
  type OutlineKind,
} from "@fabdesk/board-art";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { artworkSessions, loadBoardArtwork, saveBoardArtwork, useBoardSources, useCoreClient } from "@fabdesk/client-core";
import { BOARD_ARTWORK_PATH, type BoardArtworkSettings, type BoardArtworkView } from "@fabdesk/protocol";
import { useProject, useRunTool } from "@fabdesk/client-core";
import { Button, Select } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { BoardDimensions } from "./BoardDimensions";
import { Icon } from "../components/Icon";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import "./art-tab.css";
import { placementAfterBoardResize } from "./art-placement";
import { latestPreviewQueue } from "./art-preview-queue";
import type { PreviewResult } from "./art-preview.worker";
import { ArtSavedBoardPreview } from "./ArtSavedBoardPreview";
import { ArtPlacementControls, ArtPlacementOverlay } from "./ArtPlacementEditor";
import { buildSketchPngFile } from "./art-sketch-upload";
import { ArtColorControls } from "./ArtColorControls";
import { artImageName, buildArtPng } from "./art-image-export";
import { artDraftStore, bytesToBase64, base64ToBytes, type ArtDraft } from "./art-draft";

const STYLE_LABELS: Record<ArtStyle, string> = {
  realistic: "Halftone",
  retro: "Line hatch",
  poster: "Solid silhouette",
};

const STYLE_HELP: Record<ArtStyle, string> = {
  realistic: "Halftone dots — the photograph look.",
  retro: "Horizontal line hatch.",
  poster: "One clean cut (threshold).",
};

export function ArtTab() {
  const projectId = useUiStore(s => s.activeProjectId), client = useCoreClient();
  return <OwnedArtworkWorkspace key={JSON.stringify([client.baseUrl, projectId])} />;
}

function OwnedArtworkWorkspace() {
  const projectId = useUiStore((s) => s.activeProjectId);
  return <ProjectArtTab key={projectId ?? "unassigned"} projectId={projectId} />;
}

function ProjectArtTab({ projectId }: { projectId: string | null }) {
  const project = useProject(projectId);
  const client = useCoreClient();
  const qc = useQueryClient();
  const sources = useBoardSources(projectId);
  const initial = useRef(artworkSessions.get(client.baseUrl, projectId));
  const baseText = useRef<string | null>(initial.current?.baseText ?? null);
  const draftDestination = useRef(initial.current?.pendingProjectId);
  const [sourceImage, setSourceImage] = useState<Blob | null>(null);
  const [sourceImageName, setSourceImageName] = useState<string | null>(null);
  const [savedImage, setSavedImage] = useState<Blob | null>(null);
  const [savedSettings, setSavedSettings] = useState<string | null>(initial.current?.savedSettings ?? null);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [restoreNonce, setRestoreNonce] = useState(0);
  const tool = useRunTool();
  const drafts = useMemo(() => artDraftStore(client, projectId), [client, projectId]);
  const [hydrated, setHydrated] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Loading saved artwork…");
  const [sourceData, setSourceData] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const busyRef = useRef(false);
  const [loading, setLoading] = useState(!!projectId && !initial.current);
  const [converting, setConverting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportingImage, setExportingImage] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(initial.current?.view.zoom ?? 1);
  const [previewAspect, setPreviewAspect] = useState(1);
  const [placement, setPlacement] = useState<ArtPlacement | null>(initial.current?.settings.placement ?? null);
  const [lockProportions, setLockProportions] = useState(initial.current?.settings.lockProportions ?? true);
  const [placing, setPlacing] = useState(initial.current?.view.placing ?? true);
  const [svg, setSvg] = useState<string | null>(null);
  const [overlaySvg, setOverlaySvg] = useState<string | null>(null);
  const [marks, setMarks] = useState(0);
  const [savedBoardPreview, setSavedBoardPreview] = useState(initial.current?.boardPreview ?? false);
  const [gray, setGray] = useState<GrayImage | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>(initial.current?.settings.colorMode ?? "monotone");
  const [printedBackground, setPrintedBackground] = useState<string | null>(initial.current?.settings.printedBackground ?? null);
  const [inkColor, setInkColor] = useState(initial.current?.settings.inkColor ?? BOARD_FINISH[initial.current?.settings.color ?? "green"].silk);
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [style, setStyle] = useState<ArtStyle>(initial.current?.settings.style ?? "realistic");
  const [color, setColor] = useState<BoardColor>(initial.current?.settings.color ?? "green");
  const [crop, setCrop] = useState<ImageCrop>(initial.current?.settings.crop ?? "none");
  const [outline, setOutline] = useState<OutlineKind>(initial.current?.settings.outline ?? "rectangle");
  const [widthMm, setWidthMm] = useState(initial.current?.settings.widthMm ?? 80);
  const [heightMm, setHeightMm] = useState(initial.current?.settings.heightMm ?? 50);
  const [invert, setInvert] = useState(initial.current?.settings.invert ?? false);
  const [threshold, setThreshold] = useState(initial.current?.settings.threshold ?? 0.5);
  const [layers, setLayers] = useState<ArtLayer[]>(initial.current?.settings.layers ?? ["silk"]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const resolvedPlacement = gray
    ? (placement ?? fitArtPlacement(gray, widthMm, heightMm, 0, 2, crop))
    : null;

  const sketches = (project.data?.files ?? []).filter((f) =>
    /^sketches\/.+\.(png|jpe?g|webp|gif)$/i.test(f.path),
  );

  useEffect(
    () => () => {
      loadId.current++;
    },
    [],
  );
  useEffect(() => {
    return () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    };
  }, [sourceUrl]);

  const loadBytes = useCallback(
    async (bytes: Uint8Array, name: string, file: File | null, id: number, reset = true) => {
      const img = await decodeGray(bytes);
      if (id !== loadId.current) return;
      const original = new Blob([new Uint8Array(bytes)]);
      const url = URL.createObjectURL(original);
      setSourceImage(original); setSourceImageName(name);
      setSourceData(bytesToBase64(bytes));
      setGray(img);
      if (reset) setPlacement(null);
      setSourceName(name);
      setSourceUrl(url);
      setLocalFile(file);
      if (reset) setZoom(1);
      return original;
    },
    [],
  );

  const options = useMemo<ArtOptions>(
    () => ({
      ...(placement ? { placement } : {}),
      crop,
      style,
      widthMm,
      heightMm,
      color,
      outline,
      invert,
      threshold,
      layers,
      colorMode,
      printedBackground,
      inkColor,
    }),
    [
      placement,
      crop,
      style,
      widthMm,
      heightMm,
      color,
      outline,
      invert,
      threshold,
      layers,
      colorMode,
      printedBackground,
      inkColor,
    ],
  );
  const draft = useMemo<ArtDraft>(
    () => ({ version: 1, source: sourceData, sourceName, options, view: { zoom, placing }, lockProportions }),
    [sourceData, sourceName, options, zoom, placing, lockProportions],
  );
  useEffect(() => {
    if (!hydrated) return;
    drafts.stage(draft);
    setSaveStatus("Saving draft…");
    let active = true;
    const save = () =>
      void drafts
        .save()
        .then(() => {
          if (active)
            setSaveStatus(
              projectId ? "Draft saved in project" : "Unassigned draft saved on this device",
            );
        })
        .catch((e: unknown) => {
          if (active) {
            setSaveStatus("Draft not saved — use Save draft to retry");
            setError(String(e));
          }
        });
    const timer = setTimeout(save, 400);
    return () => {
      active = false;
      clearTimeout(timer);
      save();
    };
  }, [draft, drafts, hydrated, projectId]);

  useEffect(() => {
    const id = ++loadId.current;
    let cancelled = false;
    const apply = (settings: BoardArtworkSettings, view: BoardArtworkView) => {
      setStyle(settings.style); setColor(settings.color); setCrop(settings.crop); setOutline(settings.outline);
      setWidthMm(settings.widthMm); setHeightMm(settings.heightMm); setInvert(settings.invert);
      setThreshold(settings.threshold); setLayers(settings.layers); setPlacement(settings.placement);
      setLockProportions(settings.lockProportions); setZoom(view.zoom); setPlacing(view.placing);
      setColorMode(settings.colorMode ?? "monotone"); setPrintedBackground(settings.printedBackground ?? null); setInkColor(settings.inkColor ?? BOARD_FINISH[settings.color].silk);
    };
    void (async () => {
      setLoading(true); setHydrated(false); setRestoreFailed(false);
      try {
        const working = await drafts.load();
        const saved = projectId ? await loadBoardArtwork(client, projectId) : null;
        if (cancelled || loadId.current !== id) return;
        baseText.current = saved?.text ?? null;
        const session = initial.current;
        if (session) {
          baseText.current = session.baseText;
          const image = await loadBytes(new Uint8Array(await session.image.arrayBuffer()), session.name, null, id, false);
          if (cancelled || !image) return;
          if (session.savedImage === session.image) setSavedImage(image);
        } else if (working) {
          const o = working.options;
          apply({ style:o.style, color:o.color, crop:o.crop ?? "none", outline:o.outline, widthMm:o.widthMm, heightMm:o.heightMm, invert:o.invert ?? false, threshold:o.threshold ?? .5, layers:[...(o.layers ?? ["silk"])], placement:o.placement ?? null, lockProportions:working.lockProportions ?? true, colorMode:o.colorMode ?? "monotone", printedBackground:o.printedBackground ?? null, inkColor:o.inkColor ?? BOARD_FINISH[o.color].silk }, working.view ?? saved?.record.view ?? {zoom:1, placing:true});
          if (working.source) await loadBytes(base64ToBytes(working.source), working.sourceName ?? "art.png", null, id, false);
        } else if (saved) {
            apply(saved.record.settings, saved.record.view); baseText.current = saved.text;
            const image = await loadBytes(new Uint8Array(await saved.image.arrayBuffer()), saved.record.source.name, null, id, false);
            if (cancelled || !image) return;
            setSavedImage(image); setSavedSettings(JSON.stringify({ settings: saved.record.settings, view: saved.record.view }));
        }
        if (!cancelled) { setHydrated(true); setSaveStatus(working || saved || session ? "Saved artwork restored" : "Ready"); }
      } catch (failure) { if (!cancelled) { setRestoreFailed(true); setError(failure instanceof Error ? failure.message : String(failure)); } }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; loadId.current++; };
  }, [client, projectId, loadBytes, restoreNonce, drafts]);

  const draftSettings: BoardArtworkSettings = { style, color, crop, outline, widthMm, heightMm, invert, threshold, layers, placement, lockProportions, colorMode, printedBackground, inkColor };
  const draftView: BoardArtworkView = { zoom, placing };
  const draftSignature = JSON.stringify({ settings: draftSettings, view: draftView });
  const draftSaved = !!sourceImage && sourceImage === savedImage && draftSignature === savedSettings;
  useEffect(() => {
    if (!sourceImage || !sourceImageName || !gray || loading) return;
    artworkSessions.set(client.baseUrl, projectId, { image: sourceImage, name: sourceImageName, settings: draftSettings, view: draftView, baseText: baseText.current, savedImage, savedSettings, boardPreview: savedBoardPreview, ...(draftDestination.current ? { pendingProjectId: draftDestination.current } : {}) });
  }, [client.baseUrl, projectId, sourceImage, sourceImageName, gray, loading, draftSignature, savedImage, savedSettings, savedBoardPreview]);

  const saveDraft = async () => {
    if (!sourceImage || !sourceImageName || busyRef.current || loading || converting || restoreFailed) return;
    if (projectId && (sources.data?.mode !== "single" || sources.isFetching || sources.isError)) return;
    const originProject = projectId, originThread = useUiStore.getState().activeThreadId;
    const settings = structuredClone(draftSettings), view = { ...draftView }, signature = draftSignature;
    busyRef.current = true; setBusy(true); setError(null); setNote(null);
    try {
      const owner = projectId ?? draftDestination.current ?? (await client.createProject("Artwork draft")).id;
      if (!projectId) {
        draftDestination.current = owner;
        artworkSessions.set(client.baseUrl, null, { image: sourceImage, name: sourceImageName, settings, view, baseText: null, savedImage: null, savedSettings: null, pendingProjectId: owner });
      }
      const result = await saveBoardArtwork({ client, projectId: owner, image: sourceImage, name: sourceImageName, settings, view, expectedText: projectId ? baseText.current : null });
      artworkSessions.set(client.baseUrl, owner, { image: sourceImage, name: sourceImageName, settings, view, baseText: result.text, savedImage: sourceImage, savedSettings: signature, boardPreview: savedBoardPreview });
      await qc.invalidateQueries({ queryKey: ["projects"] }); await qc.invalidateQueries({ queryKey: ["project", owner] }); await qc.invalidateQueries({ queryKey: ["file", owner] });
      if (!originProject) {
        const ui = useUiStore.getState();
        if (ui.activeProjectId === originProject && ui.activeThreadId === originThread) { artworkSessions.remove(client.baseUrl, null); ui.adoptSketchProject(owner); ui.setBoardTab("art"); }
      } else {
        baseText.current = result.text; setSavedImage(sourceImage); setSavedSettings(signature);
        setNote("Artwork source and settings saved. No circuit files were changed.");
      }
    } catch (failure) { setSavedImage(null); setSavedSettings(null); setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const onFile = async (file: File | undefined) => {
    if (!file || busyRef.current || loading) return;
    const id = ++loadId.current;
    setError(null);
    setLoading(true);
    try {
      if (!/\.(png|jpe?g|webp|gif)$/i.test(file.name))
        throw new Error("Choose a PNG, JPG, WebP, or GIF image.");
      if (file.size > 12 * 1024 * 1024) throw new Error("Choose an image smaller than 12 MB.");
      await loadBytes(new Uint8Array(await file.arrayBuffer()), file.name, file, id);
    } catch (e) {
      if (id === loadId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  };

  const onSketch = async (path: string) => {
    if (!projectId || busyRef.current || loading) return;
    const id = ++loadId.current;
    setError(null);
    setLoading(true);
    try {
      const blob = await client.readFileBlob(projectId, path);
      await loadBytes(new Uint8Array(await blob.arrayBuffer()), path, null, id);
    } catch (e) {
      if (id === loadId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  };

  const previewWorker = useRef<Worker | null>(null);
  const previewQueue = useRef<ReturnType<
    typeof latestPreviewQueue<ArtOptions, PreviewResult>
  > | null>(null);
  const workerImage = useRef<GrayImage | null>(null);
  const removeImage = () => {
    if (busyRef.current || !hydrated) return;
    loadId.current++;
    previewQueue.current?.cancel();
    setLoading(false);
    setConverting(false);
    setGray(null);
    setSourceData(null);
    setSourceImage(null); setSourceImageName(null); setSavedImage(null); setSavedSettings(null);
    artworkSessions.remove(client.baseUrl, projectId);
    setSourceName(null);
    setSourceUrl(null);
    setSvg(null);
    setPlacement(null);
    setZoom(1);
    setDragging(false);
    setError(null);
    setNote(null);
    if (input.current) input.current.value = "";
  };
  useEffect(() => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./art-preview.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not start artwork preview.");
      return;
    }
    previewWorker.current = worker;
    const queue = latestPreviewQueue<ArtOptions, PreviewResult>(
      (id, options) => worker.postMessage({ kind: "render", id, options }),
      (result) => {
        if (result.svg) {
          setSvg(URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" })));
          setOverlaySvg(result.overlaySvg ? URL.createObjectURL(new Blob([result.overlaySvg], { type: "image/svg+xml" })) : null);
          setMarks(result.marks ?? 0);
        } else {
          setSvg(null);
          setError(result.error ?? "Could not update artwork preview.");
        }
        setConverting(false);
      },
    );
    previewQueue.current = queue;
    worker.onmessage = (event: MessageEvent<PreviewResult>) =>
      queue.complete(event.data.id, event.data);
    worker.onerror = () => {
      setConverting(false);
      setError("Artwork preview stopped. Reload the app to try again.");
    };
    return () => {
      worker.terminate();
      previewWorker.current = null;
      previewQueue.current = null;
      workerImage.current = null;
    };
  }, []);
  useEffect(
    () => () => {
      if (svg) URL.revokeObjectURL(svg);
    },
    [svg],
  );
  useEffect(() => () => { if (overlaySvg) URL.revokeObjectURL(overlaySvg); }, [overlaySvg]);
  useEffect(() => {
    if (!gray) {
      setSvg(null);
      return;
    }
    if (!previewWorker.current || !previewQueue.current) return;
    if (workerImage.current !== gray) {
      // Clone the source once per upload, never for each pointer movement.
      previewWorker.current.postMessage({ kind: "image", image: gray });
      workerImage.current = gray;
    }
    setConverting(true);
    previewQueue.current.request(options);
  }, [gray, options]);

  useEffect(() => {
    setNote(null);
  }, [options, gray]);

  const toggleLayer = (layer: ArtLayer) => {
    setLayers((cur) => {
      const next = cur.includes(layer) ? cur.filter((l) => l !== layer) : [...cur, layer];
      return next.length ? next : ["silk"];
    });
  };

  const downloadLocal = () => {
    if (!gray) return;
    const job = buildBoardArt(gray, options);
    const blob = new Blob([new Uint8Array(job.zip)], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      colorMode === "multicolor" ? "fabplane-color-art-reference.zip" : "fabplane-board-art.zip";
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadImage = async () => {
    if (!gray || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setExportingImage(true);
    setError(null);
    try {
      const blob = await buildArtPng(gray, options);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = artImageName(sourceName);
      document.body.append(a);
      try {
        a.click();
      } finally {
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setExportingImage(false);
    }
  };

  const exportToProject = async (target: string) => {
    if (!gray) return;
    const job = buildBoardArt(gray, options);
    // Keep the standalone board/export under Board Art; never replace the circuit's files.
    await client.writeFile(
      target,
      "board-art/artwork.zip",
      new Blob([new Uint8Array(job.zip)], { type: "application/zip" }),
    );
    await client.writeFile(target, "board-art/preview.svg", job.previewSvg);
  };
  const saveExport = async () => {
    if (!projectId || !gray || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      drafts.stage(draft);
      await drafts.save();
      await exportToProject(projectId);
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
      setNote("Saved board-art/artwork.zip and preview.svg. The circuit board is preserved.");
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const newProject = async () => {
    if (!gray || busyRef.current || !hydrated) return;
    const ownerEpoch = loadId.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const created = await client.createProject(
        sourceName ? `Art ${sourceName.split("/").pop()}` : "Board art",
      );
      const target = artDraftStore(client, created.id);
      target.stage(draft);
      await target.save();
      await exportToProject(created.id);
      if (colorMode === "monotone") {
        const png = await buildSketchPngFile(gray, sourceName);
        const { path } = await client.uploadSketch(created.id, png, png.name);
        const result = await tool.run("silk_art", {
          ...options,
          projectId: created.id,
          image: path.replace(/^\//, ""),
        });
        if (result.status === "failed")
          throw new Error(result.error ?? "Could not create artwork board.");
      }
      await qc.invalidateQueries({ queryKey: ["projects"] });
      if (ownerEpoch === loadId.current) {
        const ui = useUiStore.getState();
        if (ui.setActiveProject(created.id)) ui.setBoardTab("art");
        else setNote(`Created ${created.name}. Open it from Home; the current project is unchanged.`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const resizeBoard = (w: number, h: number, shape: OutlineKind = outline) => {
    setPlacement((p) => placementAfterBoardResize(p, widthMm, heightMm, w, h, shape, crop));
    setWidthMm(w);
    setHeightMm(h);
    setOutline(shape);
  };
  const unavailable = !hydrated || !gray || !svg || busy || loading || converting;
  const existingBoard = project.data?.files.some((f) => f.path === "board.kicad_pcb");
  const existingCircuit = existingBoard || project.data?.files.some(file => file.path === "board.kicad_sch");
  const showPcbPreview = savedBoardPreview && !!projectId && !!existingBoard && sources.data?.mode === "single";
  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void onFile(event.dataTransfer.files[0]);
  };
  const choose = () => input.current?.click();

  return (
    <div
      className="fd-art"
      data-testid="board-art"
      data-has-art={!!gray}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) {
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={drop}
    >
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          aria-label="Choose artwork image"
          data-testid="board-art-file"
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      {gray && <aside className="fd-art-controls" aria-label="Artwork tools">
        <h2 className="text-sm font-semibold">Artwork tools</h2>
        <p className="fd-art-owner mt-1 text-xs text-muted" title="Artwork belongs to this project’s root board. Chat selection does not change its owner.">
          {projectId ? `Project artwork · ${project.data?.name ?? "this project"}` : "Unassigned artwork draft"}
        </p>
        <p className="mt-1 text-[11px] text-muted" role="status">{draftSaved ? "Artwork saved to project" : saveStatus}</p>
        <div className={`fd-art-upload ${dragging ? "is-dragging" : ""}`}>
          <Icon name="image" width={26} height={26} aria-hidden="true" />
          <Button variant="primary" disabled={busy || loading || !hydrated} onClick={choose}>
            {gray ? "Replace image" : "Upload image"}
          </Button>
          <span className="text-xs text-muted">or drag a picture here</span>
          <span className="text-[11px] text-muted">PNG, JPG, WebP, GIF · up to 12 MB</span>
          {sourceName && (
            <span className="fd-art-filename" title={sourceName}>
              {sourceName.split("/").pop()}
            </span>
          )}
          {gray && (
            <>
              <Button disabled={busy || !hydrated} onClick={removeImage}>
                <Icon name="trash" width={14} height={14} aria-hidden="true" />
                Remove image
              </Button>
              <span className="text-[11px] text-muted text-center">
                Clears the saved artwork image. Board and color settings are kept.
              </span>
            </>
          )}
        </div>
        <fieldset disabled={busy || loading} className="min-w-0 space-y-4 border-0 p-0">
          {sketches.length > 0 && <details className="fd-art-advanced"><summary>Use another project sketch</summary>
            <Select
              className="w-full"
              value=""
              onChange={(e) => void onSketch(e.target.value)}
              aria-label="Existing sketch"
            >
              <option value="" disabled>
                Use a project sketch…
              </option>
              {sketches.map((s) => (
                <option key={s.path} value={s.path}>
                  {s.path}
                </option>
              ))}
            </Select>
          </details>}
          <details className="fd-art-advanced"><summary>Position and size</summary>
          <label className="fd-art-field">
            Image crop
            <Select
              value={crop}
              onChange={(e) => {
                const next = e.target.value as ImageCrop;
                setCrop(next);
                setLockProportions(true);
                if (gray) setPlacement(fitArtPlacement(gray, widthMm, heightMm, 0, 2, next));
              }}
            >
              {IMAGE_CROPS.map((c) => (
                <option key={c} value={c}>
                  {c === "none"
                    ? "None — full image"
                    : c === "circle"
                      ? "Circle"
                      : "Rounded rectangle"}
                </option>
              ))}
            </Select>
          </label>
          {gray && resolvedPlacement && (
            <ArtPlacementControls
              crop={crop}
              value={resolvedPlacement}
              onChange={setPlacement}
              lock={lockProportions}
              onLock={setLockProportions}
              widthMm={widthMm}
              heightMm={heightMm}
              onFit={() =>
                setPlacement(
                  fitArtPlacement(gray, widthMm, heightMm, resolvedPlacement.rotationDeg, 2, crop),
                )
              }
              onReset={() => setPlacement(null)}
            />
          )}
          </details>
          <ArtColorControls
            mode={colorMode}
            onMode={(mode) => {
              setColorMode(mode);
              if (mode === "multicolor") {
                setLayers(["silk"]);
                setStyle("realistic");
              }
            }}
            mask={color}
            onMask={(next) => {
              if (inkColor === BOARD_FINISH[color].silk) setInkColor(BOARD_FINISH[next].silk);
              setColor(next);
            }}
            background={printedBackground}
            onBackground={setPrintedBackground}
            ink={inkColor}
            onInk={setInkColor}
          />
          <div hidden={colorMode === "multicolor"}>
            <div className="fd-art-label">Art style</div>
            <div className="fd-art-styles" role="group" aria-label="Art style">
              {ART_STYLES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={style === s}
                  className="fd-art-style"
                  onClick={() => setStyle(s)}
                  data-testid={`board-art-style-${s}`}
                >
                  <span className={`fd-art-swatch ${s}`} aria-hidden="true" />
                  <span>{STYLE_LABELS[s]}</span>
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted">{STYLE_HELP[style]}</p>
          </div>
          <details className="fd-art-advanced">
            <summary>Board settings</summary>
            <div className="mt-3 space-y-4">
              {" "}
              <label className="fd-art-field">
                Board shape
                <Select
                  value={outline}
                  onChange={(e) => {
                    const shape = e.target.value as OutlineKind;
                    const diameter = Math.min(widthMm, heightMm);
                    resizeBoard(
                      shape === "circle" ? diameter : widthMm,
                      shape === "circle" ? diameter : heightMm,
                      shape,
                    );
                  }}
                >
                  {OUTLINE_KINDS.map((o) => (
                    <option key={o} value={o}>
                      {o === "rounded" ? "Rounded rectangle" : o[0]!.toUpperCase() + o.slice(1)}
                    </option>
                  ))}
                </Select>
              </label>
              <BoardDimensions
                widthMm={widthMm}
                heightMm={heightMm}
                circular={outline === "circle"}
                onChange={(w, h) => resizeBoard(w, h)}
              />
              <p className="text-[11px] text-muted">
                Changing board size scales and repositions the artwork to keep it visible.
              </p>
              <p className="text-[11px] text-muted">
                Board shape changes the physical PCB edge, independently of the image crop.
              </p>
            </div>
          </details>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
            Invert light and dark
          </label>
          <details className="fd-art-advanced">
            <summary>Advanced</summary>
            <div className="mt-3 space-y-3">
              <div className="fd-art-label">Artwork layer</div>
              {ART_LAYERS.filter((layer) => colorMode !== "multicolor" || layer === "silk").map(
                (layer) => (
                  <label key={layer} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={layers.includes(layer)}
                      onChange={() => toggleLayer(layer)}
                    />
                    {{ silk: "Silkscreen", mask: "Solder mask openings", copper: "Copper" }[layer]}
                  </label>
                ),
              )}
              <p className="text-[11px] text-muted">
                Silkscreen is the default. Other layers change how the artwork is fabricated.
              </p>
              {style === "poster" && (
                <label className="fd-art-field">
                  Threshold {threshold.toFixed(2)}
                  <input
                    type="range"
                    min={0.1}
                    max={0.9}
                    step={0.05}
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                  />
                </label>
              )}
            </div>
          </details>
        </fieldset>
        <div className="fd-art-actions">
          <Button variant="primary" disabled={!hydrated || unavailable || restoreFailed || !!projectId && (sources.data?.mode !== "single" || sources.isFetching || sources.isError)} onClick={() => void saveDraft()}>
            {busy ? "Saving…" : "Save artwork"}
          </Button>
          <WorkspaceMenu label={<>Export and save<Icon name="chevronDown" width={14} height={14} /></>}>
          <Button disabled={unavailable} onClick={downloadLocal} data-testid="board-art-download">
            {colorMode === "multicolor" ? "Download color reference ZIP" : "Download standalone art Gerbers"}
          </Button>
          <Button disabled={unavailable} onClick={() => void newProject()}>Generate standalone art project</Button>
          <Button disabled={unavailable || !projectId} onClick={() => void saveExport()}>Save export in project</Button>
          {projectId && <button onClick={() => useUiStore.getState().openProjectFile(BOARD_ARTWORK_PATH)}>Show saved artwork settings</button>}
          <div className="fd-menu-caption">Applying artwork to an existing circuit is not available yet. Standalone generation creates PCB and fabrication files.</div>
          </WorkspaceMenu>
          <p className="text-[11px] leading-relaxed text-muted">Save image and settings to this project.</p>
        </div>
      </aside>}
      <section
        className={`fd-art-preview ${dragging ? "is-dragging" : ""}`}
        aria-label="Board art preview"
        aria-busy={loading || converting}
      >
        {gray && <div className="fd-art-toolbar">
          <span>
            {outline === "circle" ? `Ø ${widthMm} mm` : `${widthMm} × ${heightMm} mm`} ·{" "}
            {STYLE_LABELS[style]}
          </span>
          {svg && (
            <div className="flex flex-wrap items-center gap-1">
              {projectId && existingBoard && sources.data?.mode === "single" && <><button type="button" aria-pressed={!savedBoardPreview} onClick={() => setSavedBoardPreview(false)}>Artwork canvas</button><button type="button" aria-pressed={savedBoardPreview} onClick={() => setSavedBoardPreview(true)}>Preview on PCB</button></>}
              <button type="button" aria-pressed={placing} onClick={() => setPlacing((p) => !p)}>
                {placing ? "Finish placing" : "Place artwork"}
              </button>
              {!showPcbPreview && <><button
                type="button"
                aria-label="Zoom out"
                disabled={zoom <= 0.5}
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
              >
                −
              </button>
              <span className="fd-art-zoom">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                aria-label="Zoom in"
                disabled={zoom >= 3}
                onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
              >
                +
              </button>
              <button type="button" onClick={() => setZoom(1)}>
                Fit
              </button></>}
            </div>
          )}
            <button
              type="button"
              disabled={unavailable}
              onClick={() => void downloadImage()}
              className="inline-flex items-center gap-1.5"
              aria-label="Download finished board as PNG"
            >
              <Icon name="export" width={14} height={14} aria-hidden="true" />
              {exportingImage ? "Exporting…" : "Download PNG"}
            </button>
        </div>}
        {(loading || converting) && (
          <div role="status" className="fd-art-progress">
            {loading ? "Reading image…" : "Updating preview…"}
          </div>
        )}
        {!svg && !loading && !converting && (
          <div className="fd-art-empty">
            <Icon name="image" width={38} height={38} aria-hidden="true" />
            <h3>Start with artwork</h3>
            <p>Add a logo, drawing or photo. Save its image and settings now, then return as your project develops.</p>
            <div className="fd-art-example" aria-hidden="true">
              <span>★</span>
              <span>→</span>
              <span className="fd-art-example-board">★</span>
            </div>
            <Button variant="primary" disabled={loading} onClick={choose}>
              Upload image
            </Button>
            <p>PNG, JPG, WebP, GIF · up to 12 MB<br />Or drop an image on this canvas.</p>
            {restoreFailed && <Button onClick={() => { setError(null); setRestoreNonce(value => value + 1); }}>Retry saved artwork</Button>}
            {sketches.length > 0 && <Select aria-label="Existing sketch" value="" disabled={busy || loading} onChange={event => void onSketch(event.target.value)}><option value="" disabled>Use a project sketch…</option>{sketches.map(file => <option key={file.path} value={file.path}>{file.path.split("/").pop()}</option>)}</Select>}
          </div>
        )}
        {svg && showPcbPreview && projectId ? <ArtSavedBoardPreview projectId={projectId} enabled={sources.data?.mode === "single" && !sources.isFetching && !sources.isError} {...(sources.isError ? { onRetrySource: () => void sources.refetch() } : {})} overlayUrl={overlaySvg} widthMm={widthMm} heightMm={heightMm} crop={crop} placement={resolvedPlacement} lock={lockProportions} placing={placing} busy={busy || loading || converting} silkOnly={layers.length === 1 && layers[0] === "silk"} marks={marks} onPlace={setPlacement} onFit={(width, height) => { setWidthMm(width); setHeightMm(height); setOutline("rectangle"); if (gray) setPlacement(fitArtPlacement(gray, width, height, resolvedPlacement?.rotationDeg ?? 0, 2, crop)); }} /> : svg && (
          <div className="fd-art-comparison">
            {sourceUrl && (
              <details className="fd-art-source"><summary>Source image</summary>
              <figure>
                <figcaption>Source image</figcaption>
                <img src={sourceUrl} alt={`Source: ${sourceName ?? "uploaded image"}`} />
              </figure></details>
            )}
            <figure className="fd-art-result">
              <figcaption>
                Artwork preview ·{" "}
                {layers
                  .map((l) => ({ silk: "silkscreen", mask: "mask", copper: "copper" })[l])
                  .join(" + ")}
              </figcaption>
              <div className="fd-art-canvas">
                <div
                  className="fd-art-board-surface"
                  style={{ "--fd-art-preview-scale": zoom, "--fd-art-preview-aspect": previewAspect } as CSSProperties}
                >
                  <img
                    data-testid="board-art-preview"
                    src={svg}
                    alt="PCB artwork preview"
                    onLoad={event => { const image = event.currentTarget; if (image.naturalWidth > 0 && image.naturalHeight > 0) setPreviewAspect(image.naturalWidth / image.naturalHeight); }}
                    draggable={false}
                  />
                  {placing && resolvedPlacement && (
                    <ArtPlacementOverlay
                      crop={crop}
                      value={resolvedPlacement}
                      onChange={setPlacement}
                      widthMm={widthMm}
                      heightMm={heightMm}
                      lock={lockProportions}
                      disabled={busy || loading || !hydrated}
                    />
                  )}
                </div>
              </div>
            </figure>
          </div>
        )}
        {dragging && <div className="fd-art-drop-hint">Drop image to preview</div>}
      </section>
      {(error || note) && <div className="fd-art-feedback">
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
        {note && (
          <p role="status" className="mt-2 text-xs text-success">
            {note}
          </p>
        )}
      </div>}
    </div>
  );
}
