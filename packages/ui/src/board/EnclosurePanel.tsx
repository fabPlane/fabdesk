import { useCallback, useEffect, useRef, useState } from "react";
import { useCoreClient, useProject } from "@fabdesk/client-core";
import { Button, Input, Select, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import "./enclosure-panel.css";

export type EnclosureDraft = {
  outlineOffsetMm: string;
  clearanceMm: string;
  ventPattern: "none" | "grid" | "slots" | "honeycomb";
  ventFaces: "lid" | "walls" | "both";
  snapFit: boolean;
};

export const DEFAULT_ENCLOSURE_DRAFT: EnclosureDraft = {
  outlineOffsetMm: "0",
  clearanceMm: "1",
  ventPattern: "none",
  ventFaces: "lid",
  snapFit: false,
};

export type EnclosureView = {
  exists: boolean;
  stale: boolean;
  ok: boolean;
  summary: string;
  issues: string[];
  cutouts: Array<{ ref: string; edge: string }>;
  holes: number;
  connectors: number;
  files: string[];
  appliedToCad?: boolean;
  previewSvg?: string;
  vents: number;
  clips: number;
  draft: EnclosureDraft;
};

export function enclosureFromTool(result: unknown): EnclosureView {
  const rec = asRecord(result);
  const body = rec && "json" in rec ? asRecord(rec["json"]) : rec;
  const nested = body && "json" in body ? asRecord(body["json"]) : body;
  const data = nested ?? body ?? {};
  const alignment = asRecord(data["alignment"]);
  const board = asRecord(data["board"]);
  const features = asRecord(data["features"]) ?? board;
  const params = asRecord(data["params"]);
  const issues = Array.isArray(alignment?.["issues"])
    ? (alignment["issues"] as unknown[])
        .map((i) => asRecord(i)?.["message"])
        .filter((m): m is string => typeof m === "string")
    : [];
  const cutouts = Array.isArray(data["cutouts"])
    ? (data["cutouts"] as unknown[]).flatMap((c) => {
        const row = asRecord(c);
        return row && typeof row["ref"] === "string"
          ? [{ ref: row["ref"], edge: typeof row["edge"] === "string" ? row["edge"] : "" }]
          : [];
      })
    : [];
  const files = ["spec", "stl", "lidStl", "step", "preview"]
    .map((k) => data[k])
    .filter((v): v is string => typeof v === "string");
  const text = typeof rec?.["text"] === "string" ? rec["text"] : "";
  const previewSvg = typeof data["previewSvg"] === "string" ? data["previewSvg"] : undefined;
  return {
    exists: data["exists"] !== false && (Boolean(alignment) || files.length > 0),
    stale: alignment?.["stale"] === true,
    ok: data["exists"] !== false && alignment?.["ok"] !== false && issues.length === 0,
    summary: firstLine(text) || (data["exists"] === false ? "No enclosure yet." : "Enclosure"),
    issues,
    cutouts,
    holes: typeof features?.["holes"] === "number" ? features["holes"] : 0,
    connectors: Array.isArray(features?.["connectors"])
      ? features["connectors"].length
      : cutouts.length,
    files,
    vents: typeof data["vents"] === "number" ? data["vents"] : 0,
    clips: typeof data["clips"] === "number" ? data["clips"] : 0,
    draft: draftFromParams(params),
    ...(data["appliedToCad"] === true ? { appliedToCad: true } : {}),
    ...(previewSvg ? { previewSvg } : {}),
  };
}

export function draftFromParams(params: Record<string, unknown> | null): EnclosureDraft {
  const vent = params?.["ventPattern"];
  const faces = params?.["ventFaces"];
  return {
    outlineOffsetMm:
      typeof params?.["outlineOffsetMm"] === "number"
        ? String(params["outlineOffsetMm"])
        : DEFAULT_ENCLOSURE_DRAFT.outlineOffsetMm,
    clearanceMm:
      typeof params?.["clearanceMm"] === "number"
        ? String(params["clearanceMm"])
        : DEFAULT_ENCLOSURE_DRAFT.clearanceMm,
    ventPattern:
      vent === "grid" || vent === "slots" || vent === "honeycomb" || vent === "none"
        ? vent
        : DEFAULT_ENCLOSURE_DRAFT.ventPattern,
    ventFaces:
      faces === "walls" || faces === "both" || faces === "lid"
        ? faces
        : DEFAULT_ENCLOSURE_DRAFT.ventFaces,
    snapFit: params?.["snapFit"] === true,
  };
}

/**
 * A tool that reports `isError` comes back as HTTP 422 whose body is the tool envelope; the client
 * throws it as the error message. Recover the envelope (or a plain `{ error }` body) so the panel
 * can show the alignment report instead of raw JSON.
 */
export function enclosureFailure(e: unknown): {
  result: Record<string, unknown> | null;
  message: string;
} {
  const raw = e instanceof Error ? e.message : String(e);
  let body: Record<string, unknown> | null = null;
  try {
    body = asRecord(JSON.parse(raw));
  } catch {
    return { result: null, message: raw };
  }
  if (body && "json" in body && asRecord(body["json"])) return { result: body, message: "" };
  const err = body?.["error"] ?? body?.["text"];
  return { result: null, message: typeof err === "string" ? err : raw };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim()) ?? "";
}

export function parseMm(value: string, fallback: number): number {
  if (value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function enclosureDimensionError(value: string, max: number, label: string): string | null {
  if (!value.trim()) return null; // Empty fields use the documented generation defaults.
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max
    ? null
    : `${label} must be between 0 and ${max} mm.`;
}

export function enclosureDraftChanged(draft: EnclosureDraft, saved: EnclosureDraft): boolean {
  return (
    parseMm(draft.outlineOffsetMm, 0) !== parseMm(saved.outlineOffsetMm, 0) ||
    parseMm(draft.clearanceMm, 1) !== parseMm(saved.clearanceMm, 1) ||
    draft.ventPattern !== saved.ventPattern ||
    draft.ventFaces !== saved.ventFaces ||
    draft.snapFit !== saved.snapFit
  );
}

/** Status/check intentionally omit SVG bytes; restore the generated file on tab re-entry. */
export async function enclosureWithSavedPreview(
  view: EnclosureView,
  readFile: (path: string) => Promise<string>,
): Promise<EnclosureView> {
  if (!view.exists || view.previewSvg) return view;
  const path = view.files.find((file) => /\.svg$/i.test(file));
  if (!path) return view;
  try {
    const previewSvg = await readFile(path);
    return previewSvg.trim() ? { ...view, previewSvg } : view;
  } catch {
    // Missing preview must not block the enclosure controls or exports.
    return view;
  }
}

/** Presentational enclosure strip shared by the CAD tab and static tests. */
export function EnclosureScreen({
  view,
  draft,
  busy,
  error,
  onDraftChange,
  onGenerate,
  onCheck,
  onDownload,
  onOpenFiles,
  downloading,
}: {
  view: EnclosureView | null;
  draft: EnclosureDraft;
  busy: boolean;
  error: string | null;
  onDraftChange: (patch: Partial<EnclosureDraft>) => void;
  onGenerate: () => void;
  onCheck: () => void;
  onDownload?: (path: string) => void;
  onOpenFiles?: (path: string) => void;
  downloading?: string | null;
}) {
  const offsetError = enclosureDimensionError(draft.outlineOffsetMm, 40, "Outline offset");
  const clearanceError = enclosureDimensionError(draft.clearanceMm, 20, "Clearance");
  const invalid = !!offsetError || !!clearanceError;
  const settingsChanged = !!view?.exists && enclosureDraftChanged(draft, view.draft);
  const modelFile =
    view?.files.find((path) => /\.stl$/i.test(path) && !/-lid\.stl$/i.test(path)) ??
    view?.files.find((path) => /\.(stl|step)$/i.test(path));
  return (
    <section
      className="fd-enclosure-panel m-4 shrink-0 rounded-xl border border-border bg-panel p-5"
      data-testid="enclosure-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">
            {view?.exists ? "Your enclosure" : "Create a printable enclosure"}
          </h2>
          <p className="mt-1 text-sm text-muted" data-testid="enclosure-summary">
            {view?.summary ??
              "Generate a printable case from the board outline, holes and connectors."}
          </p>
        </div>
        {busy && <Spinner />}
        {!view?.exists && (
          <Button
            size="sm"
            variant="primary"
            disabled={busy || invalid}
            onClick={onGenerate}
            data-testid="enclosure-generate"
          >
            Generate
          </Button>
        )}
      </div>
      <div className="fd-enclosure-controls mt-4" data-testid="enclosure-v2-controls">
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted">
          Outline offset (mm)
          <Input
            type="number"
            min={0}
            max={40}
            step={0.5}
            value={draft.outlineOffsetMm}
            aria-invalid={!!offsetError}
            aria-describedby={offsetError ? "enclosure-offset-error" : undefined}
            onChange={(e) => onDraftChange({ outlineOffsetMm: e.target.value })}
            data-testid="enclosure-offset"
            className={`h-9 px-2 ${offsetError ? "!border-danger" : ""}`}
          />
          {offsetError && (
            <span id="enclosure-offset-error" className="text-xs text-danger" role="alert">
              {offsetError}
            </span>
          )}
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted">
          Clearance (mm)
          <Input
            type="number"
            min={0}
            max={20}
            step={0.5}
            value={draft.clearanceMm}
            aria-invalid={!!clearanceError}
            aria-describedby={clearanceError ? "enclosure-clearance-error" : undefined}
            onChange={(e) => onDraftChange({ clearanceMm: e.target.value })}
            data-testid="enclosure-clearance"
            className={`h-9 px-2 ${clearanceError ? "!border-danger" : ""}`}
          />
          {clearanceError && (
            <span id="enclosure-clearance-error" className="text-xs text-danger" role="alert">
              {clearanceError}
            </span>
          )}
        </label>
        <details className="fd-enclosure-extra-settings"><summary>Vents and fastening<span>{draft.ventPattern === "none" ? "No vents" : `${draft.ventPattern} vents`}{draft.snapFit ? " · Snap-fit clips" : ""}</span></summary><div className="fd-enclosure-secondary-controls">
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted">
          Vent pattern
          <Select
            value={draft.ventPattern}
            onChange={(e) =>
              onDraftChange({ ventPattern: e.target.value as EnclosureDraft["ventPattern"] })
            }
            data-testid="enclosure-vents"
            className="h-9 w-full"
          >
            <option value="none">None</option>
            <option value="grid">Grid</option>
            <option value="slots">Slots</option>
            <option value="honeycomb">Honeycomb</option>
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted">
          Vent faces
          <Select
            value={draft.ventFaces}
            onChange={(e) =>
              onDraftChange({ ventFaces: e.target.value as EnclosureDraft["ventFaces"] })
            }
            data-testid="enclosure-vent-faces"
            className="h-9 w-full"
            disabled={draft.ventPattern === "none"}
          >
            <option value="lid">Lid</option>
            <option value="walls">Walls</option>
            <option value="both">Lid + walls</option>
          </Select>
        </label>
        <label className="fd-enclosure-snapfit flex min-h-9 items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={draft.snapFit}
            onChange={(e) => onDraftChange({ snapFit: e.target.checked })}
            data-testid="enclosure-snapfit"
            className="accent-primary"
          />
          Snap-fit clips
        </label>
        </div></details>
      </div>
      {settingsChanged && (
        <div
          className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 p-3"
          role="status"
        >
          <p className="text-xs text-muted">
            Settings changed. Regenerate to update the preview and files.
          </p>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || invalid}
            onClick={onGenerate}
            data-testid="enclosure-generate"
          >
            {busy ? "Regenerating…" : "Regenerate"}
          </Button>
        </div>
      )}
      {error && !invalid && (
        <p className="mt-1 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {view?.exists && (
        <p className="mt-1 text-xs text-muted" data-testid="enclosure-meta">
          {settingsChanged
            ? "Preview and downloads show the last generated settings."
            : view.stale
              ? "PCB changed · Review before regenerating."
              : view.ok
                ? `Saved case · ${view.cutouts.length} cutout(s) · ${view.holes} hole(s) · ${view.vents} vent(s) · ${view.clips} clip(s)`
                : (view.issues[0] ?? "Cutouts need attention.")}
        </p>
      )}
      {view?.exists && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          <Button
            size="sm"
            variant="ghost"
            className="text-xs text-muted"
            disabled={busy}
            onClick={onCheck}
            data-testid="enclosure-check"
          >
            Check alignment
          </Button>
          {!settingsChanged && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || invalid}
              onClick={onGenerate}
              data-testid="enclosure-generate"
            >
              Regenerate
            </Button>
          )}
        </div>
      )}
      {view?.exists && view.files.some((path) => /\.(stl|step)$/i.test(path)) && (
        <details className="fd-enclosure-downloads mt-4 border-t border-border pt-3"><summary>Downloads and files</summary><div className="mt-3">
          <h3 className="text-sm font-medium">Files for printing and CAD</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Download the base and lid for 3D printing, or STEP for CAD editing. These files are also
            saved in your project’s exports folder.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {view.files
              .filter((path) => /\.(stl|step)$/i.test(path))
              .map((path) => (
                <Button
                  key={path}
                  size="sm"
                  disabled={busy || !!downloading}
                  title={path}
                  onClick={() => onDownload?.(path)}
                >
                  {downloading === path
                    ? "Downloading…"
                    : /\.step$/i.test(path)
                      ? "Download STEP"
                      : /-lid\.stl$/i.test(path)
                        ? "Download lid STL"
                        : "Download base STL"}
                </Button>
              ))}
          </div>
          <button
            type="button"
            className="mt-3 text-xs text-accent underline underline-offset-2 hover:text-fg"
            onClick={() => modelFile && onOpenFiles?.(modelFile)}
          >
            View generated files →
          </button>
        </div></details>
      )}
      {view && view.issues.length > 1 && (
        <ul className="mt-1 list-disc pl-4 text-xs text-warning" data-testid="enclosure-issues">
          {view.issues.slice(0, 6).map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {view?.previewSvg && (
        <details className="fd-enclosure-drawing"><summary>Cutout drawing</summary><div
          className="mt-2 max-w-full overflow-auto rounded-md border border-border bg-bg [&_svg]:h-auto [&_svg]:max-w-full"
          data-testid="enclosure-preview"
          dangerouslySetInnerHTML={{ __html: view.previewSvg }}
        /></details>
      )}

    </section>
  );
}

export function EnclosurePanel() {
  const client = useCoreClient();
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const checkedRevision = useRef<string | null>(null);
  const sourceRevision = project.data ? `${projectId}:${project.dataUpdatedAt}` : null;
  const [view, setView] = useState<EnclosureView | null>(null);
  const [draft, setDraft] = useState<EnclosureDraft>(DEFAULT_ENCLOSURE_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const download = async (path: string) => {
    if (!projectId || downloading) return;
    setDownloading(path);
    setError(null);
    try {
      const blob = await client.readFileBlob(projectId, path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").pop() ?? "enclosure.stl";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(`Could not download ${path}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloading(null);
    }
  };

  const call = useCallback(
    async (action: "generate" | "status" | "check", extras: Record<string, unknown> = {}, preserveDraft = false) => {
      if (!projectId) return;
      setBusy(true);
      setError(null);
      try {
        const res = await client.callTool("cad_enclosure", {
          projectId,
          action,
          ...extras,
        });
        const next = await enclosureWithSavedPreview(enclosureFromTool(res), (path) =>
          client.readFile(projectId, path),
        );
        setView(next);
        if (action !== "generate" && !preserveDraft) setDraft(next.draft);
        const rec = asRecord(res);
        if (rec && rec["ok"] === false && typeof rec["text"] === "string") setError(rec["text"]);
      } catch (e) {
        const failure = enclosureFailure(e);
        if (failure.result)
          setView(
            await enclosureWithSavedPreview(enclosureFromTool(failure.result), (path) =>
              client.readFile(projectId, path),
            ),
          );
        if (failure.message) setError(failure.message);
      } finally {
        setBusy(false);
      }
    },
    [client, projectId],
  );

  useEffect(() => {
    if (!projectId || !sourceRevision || busy || checkedRevision.current === sourceRevision) return;
    const initial = checkedRevision.current === null;
    checkedRevision.current = sourceRevision;
    // Background source changes update the report without replacing unsaved controls.
    void call("status", {}, !initial);
  }, [projectId, sourceRevision, busy, call]);

  if (!projectId) return null;
  return (
    <EnclosureScreen
      view={view}
      draft={draft}
      busy={busy}
      error={error}
      onDraftChange={(patch) => {
        setDraft((cur) => ({ ...cur, ...patch }));
        setError(null);
      }}
      onGenerate={() =>
        void call("generate", {
          applyToCad: true,
          outlineOffsetMm: parseMm(draft.outlineOffsetMm, 0),
          clearanceMm: parseMm(draft.clearanceMm, 1),
          ventPattern: draft.ventPattern,
          ventFaces: draft.ventFaces,
          snapFit: draft.snapFit,
        })
      }
      onCheck={() => void call("check", {}, true)}
      onDownload={(path) => void download(path)}
      onOpenFiles={(path) => useUiStore.getState().openProjectFile(path)}
      downloading={downloading}
    />
  );
}
