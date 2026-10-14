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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useCoreClient } from "@fabdesk/client-core";
import { useProject, useRunTool } from "@fabdesk/client-core";
import { Button, EmptyState, Select } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { buildSketchPngFile } from "./art-sketch-upload";

const SIZES: Array<{ label: string; w: number; h: number }> = [
  { label: "50 × 50 mm", w: 50, h: 50 },
  { label: "80 × 50 mm", w: 80, h: 50 },
  { label: "100 × 100 mm", w: 100, h: 100 },
  { label: "40 × 40 mm", w: 40, h: 40 },
];

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

  const sketches = (project.data?.files ?? []).filter((f) => /^sketches\/.+\.(png|jpe?g|webp|gif)$/i.test(f.path));

  const loadBytes = useCallback(async (bytes: Uint8Array, name: string) => {
    setError(null);
    const img = await decodeGray(bytes);
    setGray(img);
    setSourceName(name);
  }, []);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setLocalFile(file);
    try {
      await loadBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSketch = async (path: string) => {
    if (!projectId) return;
    setLocalFile(null);
    try {
      const blob = await client.readFileBlob(projectId, path);
      await loadBytes(new Uint8Array(await blob.arrayBuffer()), path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const svg = useMemo(() => {
    if (!gray) return null;
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
    return previewSvg(art.options, art.clipped);
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
    const job = buildBoardArt(gray, { style, widthMm, heightMm, color, outline, invert, threshold, layers });
    const blob = new Blob([new Uint8Array(job.zip)], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fabplane-board-art.zip";
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveProject = async () => {
    if (!projectId || !gray) return;
    setError(null);
    setNote(null);
    try {
      let image = sourceName && sourceName.startsWith("sketches/") ? sourceName : undefined;
      if (localFile && gray) {
        const png = await buildSketchPngFile(gray, localFile.name);
        const { path } = await client.uploadSketch(projectId, png, png.name);
        image = path.replace(/^\//, "");
        setSourceName(image);
        setLocalFile(null);
      }
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
    }
  };

  const newProject = async () => {
    if (!gray) return;
    setError(null);
    setNote(null);
    const created = await client.createProject(sourceName ? `Art ${sourceName}` : "Board art");
    useUiStore.getState().setActiveProject(created.id);
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
    setNote(`Created project ${created.name}.`);
  };

  return (
    <div className="flex h-full min-h-0" data-testid="board-art">
      <div className="w-72 shrink-0 overflow-auto border-r border-border p-3">
        <div className="text-sm font-semibold">Board art</div>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          Drop a picture. Preview is free and spends no AI credit. Download a Gerber zip, or save it as this
          fabPlane project.
        </p>
        <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Picture</label>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="mt-1 block w-full text-[12px]"
          data-testid="board-art-file"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        {sketches.length > 0 && (
          <Select className="mt-2 h-8 w-full" value="" onChange={(e) => void onSketch(e.target.value)} aria-label="Existing sketch">
            <option value="" disabled>
              Or use a sketch…
            </option>
            {sketches.map((s) => (
              <option key={s.path} value={s.path}>
                {s.path}
              </option>
            ))}
          </Select>
        )}
        <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Look</label>
        <Select className="mt-1 h-8 w-full" value={style} onChange={(e) => setStyle(e.target.value as ArtStyle)} data-testid="board-art-style">
          {ART_STYLES.map((s) => (
            <option key={s} value={s}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </option>
          ))}
        </Select>
        <div className="mt-1 text-[11px] text-muted">{STYLE_HELP[style]}</div>
        <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Colour</label>
        <Select className="mt-1 h-8 w-full" value={color} onChange={(e) => setColor(e.target.value as BoardColor)}>
          {BOARD_COLORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Size</label>
        <Select
          className="mt-1 h-8 w-full"
          value={`${widthMm}x${heightMm}`}
          onChange={(e) => {
            const hit = SIZES.find((s) => `${s.w}x${s.h}` === e.target.value);
            if (!hit) return;
            setWidthMm(hit.w);
            setHeightMm(hit.h);
          }}
        >
          {SIZES.map((s) => (
            <option key={s.label} value={`${s.w}x${s.h}`}>
              {s.label}
            </option>
          ))}
        </Select>
        <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Outline</label>
        <Select className="mt-1 h-8 w-full" value={outline} onChange={(e) => setOutline(e.target.value as OutlineKind)}>
          {OUTLINE_KINDS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
        <label className="mt-3 flex items-center gap-2 text-[12px]">
          <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
          Invert (print the light parts)
        </label>
        {style === "poster" && (
          <label className="mt-2 block text-[12px]">
            Threshold {threshold.toFixed(2)}
            <input
              type="range"
              min={0.1}
              max={0.9}
              step={0.05}
              value={threshold}
              className="mt-1 w-full"
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </label>
        )}
        <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Print on</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {ART_LAYERS.map((layer) => (
            <label key={layer} className="flex items-center gap-1 text-[12px]">
              <input type="checkbox" checked={layers.includes(layer)} onChange={() => toggleLayer(layer)} />
              {layer}
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <Button size="sm" disabled={!gray} onClick={downloadLocal} data-testid="board-art-download">
            Download Gerber zip
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!gray || !projectId || tool.state.status === "running"}
            aria-disabled={!gray || !projectId || tool.state.status === "running"}
            onClick={() => void saveProject()}
            data-testid="board-art-save"
          >
            {tool.state.status === "running" ? "Saving…" : "Save to this project"}
          </Button>
          <Button size="sm" disabled={!gray} onClick={() => void newProject().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}>
            New project from this art
          </Button>
        </div>
        {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
        {note && <div className="mt-2 text-[12px] text-success">{note}</div>}
        {!projectId && <div className="mt-2 text-[12px] text-muted">Select a project to save the KiCad board into it.</div>}
      </div>
      <div className="min-w-0 flex-1 overflow-auto bg-[#111] p-4">
        {!svg && <EmptyState title="Drop a picture to preview the board" />}
        {svg && (
          <div
            className="mx-auto max-w-[640px] [&_svg]:h-auto [&_svg]:w-full"
            data-testid="board-art-preview"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
      </div>
    </div>
  );
}

