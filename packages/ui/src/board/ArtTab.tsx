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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCoreClient } from "@fabdesk/client-core";
import { useProject, useRunTool } from "@fabdesk/client-core";
import { Button, Select } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { BoardDimensions } from "./BoardDimensions";
import { Icon } from "../components/Icon";
import "./art-tab.css";
import { placementAfterBoardResize } from "./art-placement";
import { latestPreviewQueue } from "./art-preview-queue";
import type { PreviewResult } from "./art-preview.worker";
import { ArtPlacementControls, ArtPlacementOverlay } from "./ArtPlacementEditor";
import { buildSketchPngFile } from "./art-sketch-upload";
import { ArtColorControls } from "./ArtColorControls";
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
  const projectId = useUiStore((s) => s.activeProjectId);
  return <ProjectArtTab key={projectId ?? "unassigned"} projectId={projectId} />;
}

function ProjectArtTab({ projectId }: { projectId: string | null }) {
  const project = useProject(projectId);
  const client = useCoreClient();
  const qc = useQueryClient();
  const tool = useRunTool();
  const drafts = useMemo(() => artDraftStore(client, projectId), [client, projectId]);
  const [hydrated, setHydrated] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Loading saved artwork…");
  const [sourceData, setSourceData] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const busyRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [placement, setPlacement] = useState<ArtPlacement | null>(null);
  const [lockProportions, setLockProportions] = useState(true);
  const [placing, setPlacing] = useState(true);
  const [svg, setSvg] = useState<string | null>(null);
  const [gray, setGray] = useState<GrayImage | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("monotone");
  const [printedBackground, setPrintedBackground] = useState<string | null>(null);
  const [inkColor, setInkColor] = useState(BOARD_FINISH.green.silk);
  const [style, setStyle] = useState<ArtStyle>("realistic");
  const [color, setColor] = useState<BoardColor>("green");
  const [crop, setCrop] = useState<ImageCrop>("none");
  const [outline, setOutline] = useState<OutlineKind>("rectangle");
  const [widthMm, setWidthMm] = useState(80);
  const [heightMm, setHeightMm] = useState(50);
  const [invert, setInvert] = useState(false);
  const [threshold, setThreshold] = useState(0.5);
  const [layers, setLayers] = useState<ArtLayer[]>(["silk"]);
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

  const loadBytes = useCallback(async (bytes: Uint8Array, name: string, id: number) => {
    const img = await decodeGray(bytes);
    if (id !== loadId.current) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
    setGray(img);
    setPlacement(null);
    setSourceName(name);
    setSourceUrl(url);
    setSourceData(bytesToBase64(bytes));
    setZoom(1);
  }, []);

  useEffect(() => {
    let active = true;
    const id = ++loadId.current;
    void drafts
      .load()
      .then(async (draft) => {
        if (!active) return;
        if (draft) {
          if (draft.source)
            await loadBytes(base64ToBytes(draft.source), draft.sourceName ?? "art.png", id);
          if (!active) return;
          const o = draft.options;
          setStyle(o.style);
          setColor(o.color);
          setCrop(o.crop ?? "none");
          setOutline(o.outline);
          setWidthMm(o.widthMm);
          setHeightMm(o.heightMm);
          setInvert(o.invert ?? false);
          setThreshold(o.threshold ?? 0.5);
          setLayers([...(o.layers ?? ["silk"])]);
          setPlacement(o.placement ?? null);
          setColorMode(o.colorMode ?? "monotone");
          setPrintedBackground(o.printedBackground ?? null);
          setInkColor(o.inkColor ?? BOARD_FINISH[o.color].silk);
        }
        setHydrated(true);
        setSaveStatus(draft ? "Saved artwork restored" : "Ready");
      })
      .catch((e: unknown) => {
        if (active) {
          setError(String(e));
          setSaveStatus("Could not restore draft. Reopen Board Art to retry.");
        }
      });
    return () => {
      active = false;
    };
  }, [drafts, loadBytes]);

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
    () => ({ version: 1, source: sourceData, sourceName, options }),
    [sourceData, sourceName, options],
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

  const onFile = async (file: File | undefined) => {
    if (!file || busyRef.current || !hydrated) return;
    const id = ++loadId.current;
    setError(null);
    setLoading(true);
    try {
      if (!/\.(png|jpe?g|webp|gif)$/i.test(file.name))
        throw new Error("Choose a PNG, JPG, WebP, or GIF image.");
      if (file.size > 12 * 1024 * 1024) throw new Error("Choose an image smaller than 12 MB.");
      await loadBytes(new Uint8Array(await file.arrayBuffer()), file.name, id);
    } catch (e) {
      if (id === loadId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  };

  const onSketch = async (path: string) => {
    if (!projectId || busyRef.current || !hydrated) return;
    const id = ++loadId.current;
    setError(null);
    setLoading(true);
    try {
      const blob = await client.readFileBlob(projectId, path);
      await loadBytes(new Uint8Array(await blob.arrayBuffer()), path, id);
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

  const saveProject = async () => {
    if (!hydrated) return;
    setError(null);
    try {
      drafts.stage(draft);
      await drafts.save();
      setSaveStatus(projectId ? "Draft saved in project" : "Unassigned draft saved on this device");
    } catch (e) {
      setError(String(e));
      setSaveStatus("Draft not saved — retry Save draft");
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
      if (ownerEpoch === loadId.current) useUiStore.getState().setActiveProject(created.id);
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
      <aside className="fd-art-controls">
        <h2 className="text-sm font-semibold">Board art</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Turn a picture into artwork on a PCB. Preview and export locally, with no AI credits.
        </p>
        <p className="mt-2 text-xs" data-testid="board-art-owner">
          {projectId
            ? `Artwork for ${project.data?.name ?? projectId} · board.kicad_pcb`
            : "Unassigned draft · stored on this device"}
        </p>
        <p className="text-[11px] text-muted">
          {projectId
            ? "Shared by chats in this project. Switching chats keeps this artwork; switching projects restores that project's draft."
            : "Create an art project to associate this draft with a project. A circuit is not required."}
        </p>
        <p role="status" className="text-[11px] text-muted">
          {saveStatus}
        </p>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose artwork image"
          data-testid="board-art-file"
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
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
        </div>
        <fieldset
          disabled={busy || loading || !hydrated}
          className="min-w-0 space-y-4 border-0 p-0"
        >
          {sketches.length > 0 && (
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
          )}
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
          {colorMode === "multicolor" && (
            <p className="text-[11px] text-muted">
              Multicolor uses source-colored halftone dots. Background edits do not recolor the
              source.
            </p>
          )}
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
          <Button variant="primary" disabled={unavailable} onClick={() => void newProject()}>
            {busy ? "Saving…" : "Create art project"}
          </Button>
          <Button disabled={unavailable} onClick={downloadLocal} data-testid="board-art-download">
            {colorMode === "multicolor" ? "Download color reference ZIP" : "Download Gerber ZIP"}
          </Button>
          <Button
            disabled={busy || !hydrated}
            onClick={() => void saveProject()}
            data-testid="board-art-save"
          >
            Save draft
          </Button>
          <Button disabled={unavailable || !projectId} onClick={() => void saveExport()}>
            Save export in project
          </Button>
          <p className="text-[11px] leading-relaxed text-muted">
            Drafts and exports are saved under board-art/. Applying artwork to an existing circuit
            is not yet supported here; the standalone preview does not show its components or pad
            clearances. Import and align exported artwork in your PCB editor.
          </p>
        </div>
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
      </aside>
      <section
        className={`fd-art-preview ${dragging ? "is-dragging" : ""}`}
        aria-label="Board art preview"
        aria-busy={loading || converting}
      >
        <div className="fd-art-toolbar">
          <span>
            {outline === "circle" ? `Ø ${widthMm} mm` : `${widthMm} × ${heightMm} mm`} ·{" "}
            {STYLE_LABELS[style]}
          </span>
          {svg && (
            <div className="flex flex-wrap items-center gap-1">
              <button type="button" aria-pressed={placing} onClick={() => setPlacing((p) => !p)}>
                {placing ? "Finish placing" : "Place artwork"}
              </button>
              <button
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
              </button>
            </div>
          )}
        </div>
        {(loading || converting) && (
          <div role="status" className="fd-art-progress">
            {loading ? "Reading image…" : "Updating preview…"}
          </div>
        )}
        {!svg && !loading && !converting && (
          <div className="fd-art-empty">
            <Icon name="image" width={38} height={38} aria-hidden="true" />
            <h3>Make a picture into a PCB</h3>
            <p>Upload a logo, drawing, or photo to see it on a board.</p>
            <div className="fd-art-example" aria-hidden="true">
              <span>★</span>
              <span>→</span>
              <span className="fd-art-example-board">★</span>
            </div>
            <Button variant="primary" disabled={!hydrated} onClick={choose}>
              Upload image
            </Button>
            <p>Or drop it anywhere in this panel.</p>
          </div>
        )}
        {svg && (
          <div className="fd-art-comparison">
            {sourceUrl && (
              <figure className="fd-art-source">
                <figcaption>Source image</figcaption>
                <img src={sourceUrl} alt={`Source: ${sourceName ?? "uploaded image"}`} />
              </figure>
            )}
            <figure className="fd-art-result">
              <figcaption>
                Board preview ·{" "}
                {layers
                  .map((l) => ({ silk: "silkscreen", mask: "mask", copper: "copper" })[l])
                  .join(" + ")}
              </figcaption>
              <div className="fd-art-canvas">
                <div
                  className="fd-art-board-surface"
                  style={{ width: `${zoom * 100}%`, minWidth: `${zoom * 100}%` }}
                >
                  <img
                    data-testid="board-art-preview"
                    src={svg}
                    alt="PCB artwork preview"
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
    </div>
  );
}
