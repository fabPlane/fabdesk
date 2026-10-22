import {
  ART_LAYERS,
  ART_STYLES,
  BOARD_COLORS,
  OUTLINE_KINDS,
  buildBoardArt,
  convertImage,
  decodeGray,
  previewSvg,
  type ArtLayer,
  type ArtStyle,
  type BoardColor,
  type GrayImage,
  type OutlineKind,
} from "@fabdesk/board-art";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCoreClient } from "@fabdesk/client-core";
import { useProject, useRunTool } from "@fabdesk/client-core";
import { Button, Dialog, Select } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { Icon } from "../components/Icon";
import "./art-tab.css";
import { buildSketchPngFile } from "./art-sketch-upload";

const SIZES: Array<{ label: string; w: number; h: number }> = [
  { label: "50 × 50 mm", w: 50, h: 50 },
  { label: "80 × 50 mm", w: 80, h: 50 },
  { label: "100 × 100 mm", w: 100, h: 100 },
  { label: "40 × 40 mm", w: 40, h: 40 },
];

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
  const project = useProject(projectId);
  const client = useCoreClient();
  const qc = useQueryClient();
  const tool = useRunTool();
  const input = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const busyRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [confirmSave, setConfirmSave] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [gray, setGray] = useState<GrayImage | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [style, setStyle] = useState<ArtStyle>("realistic");
  const [color, setColor] = useState<BoardColor>("green");
  const [outline, setOutline] = useState<OutlineKind>("rectangle");
  const [widthMm, setWidthMm] = useState(80);
  const [heightMm, setHeightMm] = useState(50);
  const [invert, setInvert] = useState(false);
  const [threshold, setThreshold] = useState(0.5);
  const [layers, setLayers] = useState<ArtLayer[]>(["silk"]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
  useEffect(() => {
    setConfirmSave(false);
  }, [projectId]);

  const loadBytes = useCallback(
    async (bytes: Uint8Array, name: string, file: File | null, id: number) => {
      const img = await decodeGray(bytes);
      if (id !== loadId.current) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
      setGray(img);
      setSourceName(name);
      setSourceUrl(url);
      setLocalFile(file);
      setZoom(1);
      setConfirmSave(false);
    },
    [],
  );

  const onFile = async (file: File | undefined) => {
    if (!file || busyRef.current) return;
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
    if (!projectId || busyRef.current) return;
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

  useEffect(() => {
    if (!gray) {
      setSvg(null);
      return;
    }
    setConverting(true);
    // Give the loading state a paint before the deterministic conversion.
    let timer: ReturnType<typeof setTimeout>;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        try {
          const art = convertImage(gray, {
            style,
            widthMm,
            heightMm,
            color,
            outline,
            invert,
            threshold,
            layers,
          });
          setSvg(previewSvg(art.options, art.clipped));
        } catch (e) {
          setSvg(null);
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setConverting(false);
        }
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [gray, style, widthMm, heightMm, color, outline, invert, threshold, layers]);

  useEffect(() => {
    setNote(null);
  }, [style, color, outline, widthMm, heightMm, invert, threshold, layers, gray]);

  const toggleLayer = (layer: ArtLayer) => {
    setLayers((cur) => {
      const next = cur.includes(layer) ? cur.filter((l) => l !== layer) : [...cur, layer];
      return next.length ? next : ["silk"];
    });
  };

  const downloadLocal = () => {
    if (!gray) return;
    const job = buildBoardArt(gray, {
      style,
      widthMm,
      heightMm,
      color,
      outline,
      invert,
      threshold,
      layers,
    });
    const blob = new Blob([new Uint8Array(job.zip)], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fabplane-board-art.zip";
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveProject = async () => {
    if (!projectId || !gray || busyRef.current || loading || converting) return;
    busyRef.current = true;
    setBusy(true);
    setConfirmSave(false);
    setError(null);
    setNote(null);
    try {
      // Encode the displayed image into the target project, even after switching projects.
      const png = await buildSketchPngFile(gray, localFile?.name ?? sourceName);
      const { path } = await client.uploadSketch(projectId, png, png.name);
      const image = path.replace(/^\//, "");
      setSourceName(image);
      setLocalFile(null);
      const result = await tool.run("silk_art", {
        projectId,
        ...(image ? { image } : {}),
        style,
        widthMm,
        heightMm,
        color,
        outline,
        invert,
        threshold,
        layers,
      });
      if (result.status === "failed") {
        setError(result.error ?? "silk_art failed");
        return;
      }
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
      await qc.invalidateQueries({ queryKey: ["file", projectId] });
      setNote("Saved board.kicad_pcb and exports/fabrication.zip in this project.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const newProject = async () => {
    if (!gray || busyRef.current || loading || converting) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const created = await client.createProject(
        sourceName ? `Art ${sourceName.split("/").pop()}` : "Board art",
      );
      await qc.invalidateQueries({ queryKey: ["projects"] });
      const png = await buildSketchPngFile(gray, localFile?.name ?? sourceName);
      const { path } = await client.uploadSketch(created.id, png, png.name);
      const result = await tool.run("silk_art", {
        projectId: created.id,
        image: path.replace(/^\//, ""),
        style,
        widthMm,
        heightMm,
        color,
        outline,
        invert,
        threshold,
        layers,
      });
      if (result.status === "failed") {
        setError(result.error ?? "silk_art failed");
        return;
      }
      await qc.invalidateQueries({ queryKey: ["project", created.id] });
      await qc.invalidateQueries({ queryKey: ["file", created.id] });
      setLocalFile(null);
      useUiStore.getState().setActiveProject(created.id);
      setSourceName(path.replace(/^\//, ""));
      setNote(`Created project ${created.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const unavailable = !gray || !svg || busy || loading || converting;
  const existingBoard = project.data?.files.some((f) => f.path === "board.kicad_pcb");
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
          <Button variant="primary" disabled={busy || loading} onClick={choose}>
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
        <fieldset disabled={busy || loading} className="min-w-0 space-y-4 border-0 p-0">
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
          <div>
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
          <label className="fd-art-field">
            Board colour
            <Select value={color} onChange={(e) => setColor(e.target.value as BoardColor)}>
              {BOARD_COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </label>
          <label className="fd-art-field">
            Board size
            <Select
              value={`${widthMm}x${heightMm}`}
              onChange={(e) => {
                const hit = SIZES.find((s) => `${s.w}x${s.h}` === e.target.value);
                if (hit) {
                  setWidthMm(hit.w);
                  setHeightMm(hit.h);
                }
              }}
            >
              {SIZES.map((s) => (
                <option key={s.label} value={`${s.w}x${s.h}`}>
                  {s.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="fd-art-field">
            Outline
            <Select value={outline} onChange={(e) => setOutline(e.target.value as OutlineKind)}>
              {OUTLINE_KINDS.map((o) => (
                <option key={o} value={o}>
                  {o === "rounded" ? "Rounded rectangle" : o[0]!.toUpperCase() + o.slice(1)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
            Invert light and dark
          </label>
          <details className="fd-art-advanced">
            <summary>Advanced</summary>
            <div className="mt-3 space-y-3">
              <div className="fd-art-label">Artwork layer</div>
              {ART_LAYERS.map((layer) => (
                <label key={layer} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={layers.includes(layer)}
                    onChange={() => toggleLayer(layer)}
                  />
                  {{ silk: "Silkscreen", mask: "Solder mask openings", copper: "Copper" }[layer]}
                </label>
              ))}
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
            Download Gerber ZIP
          </Button>
          <Button
            disabled={unavailable || !projectId || !project.data || project.isFetching}
            onClick={() => setConfirmSave(true)}
            data-testid="board-art-save"
          >
            Save to current project…
          </Button>
          <p className="text-[11px] leading-relaxed text-muted">
            Create a separate project to keep your existing board untouched.
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
            {widthMm} × {heightMm} mm · {STYLE_LABELS[style]}
          </span>
          {svg && (
            <div className="flex items-center gap-1">
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
            <Button variant="primary" onClick={choose}>
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
                  style={{ width: `${zoom * 100}%`, minWidth: `${zoom * 100}%` }}
                  data-testid="board-art-preview"
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </div>
            </figure>
          </div>
        )}
        {dragging && <div className="fd-art-drop-hint">Drop image to preview</div>}
      </section>
      <Dialog
        open={confirmSave}
        onClose={() => setConfirmSave(false)}
        title={existingBoard ? "Replace the current board?" : "Save artwork to this project?"}
        className="!w-[460px]"
      >
        <p className="text-sm leading-relaxed">
          Save artwork in <strong>{project.data?.name ?? "this project"}</strong>? This writes
          board.kicad_pcb, board.kicad_pro, Gerbers, and fabrication exports. Any matching files
          will be replaced.
        </p>
        <p className="mt-3 text-sm text-muted">
          Choose Create art project to keep this design intact.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setConfirmSave(false)}>Cancel</Button>
          <Button variant="danger" disabled={unavailable} onClick={() => void saveProject()}>
            {existingBoard ? "Replace board and exports" : "Save artwork"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
