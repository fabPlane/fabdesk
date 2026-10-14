import { useCallback, useEffect, useState } from "react";
import { useCoreClient } from "@fabdesk/client-core";
import { Button, Input, Select, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";

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
      typeof params?.["outlineOffsetMm"] === "number" ? String(params["outlineOffsetMm"]) : DEFAULT_ENCLOSURE_DRAFT.outlineOffsetMm,
    clearanceMm:
      typeof params?.["clearanceMm"] === "number" ? String(params["clearanceMm"]) : DEFAULT_ENCLOSURE_DRAFT.clearanceMm,
    ventPattern:
      vent === "grid" || vent === "slots" || vent === "honeycomb" || vent === "none"
        ? vent
        : DEFAULT_ENCLOSURE_DRAFT.ventPattern,
    ventFaces: faces === "walls" || faces === "both" || faces === "lid" ? faces : DEFAULT_ENCLOSURE_DRAFT.ventFaces,
    snapFit: params?.["snapFit"] === true,
  };
}

/**
 * A tool that reports `isError` comes back as HTTP 422 whose body is the tool envelope; the client
 * throws it as the error message. Recover the envelope (or a plain `{ error }` body) so the panel
 * can show the alignment report instead of raw JSON.
 */
export function enclosureFailure(e: unknown): { result: Record<string, unknown> | null; message: string } {
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

/** Presentational enclosure strip shared by the CAD tab and static tests. */
export function EnclosureScreen({
  view,
  draft,
  busy,
  error,
  onDraftChange,
  onGenerate,
  onCheck,
}: {
  view: EnclosureView | null;
  draft: EnclosureDraft;
  busy: boolean;
  error: string | null;
  onDraftChange: (patch: Partial<EnclosureDraft>) => void;
  onGenerate: () => void;
  onCheck: () => void;
}) {
  return (
    <section
      className="shrink-0 border-b border-border bg-panel-2/40 px-3 py-2"
      data-testid="enclosure-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">
          Enclosure v2
        </span>
        <span className="min-w-0 flex-1 text-xs text-fg" data-testid="enclosure-summary">
          {view?.summary ?? "Generate a printable case from the board outline, holes and connectors."}
        </span>
        {busy && <Spinner />}
        <Button size="sm" variant="primary" disabled={busy} onClick={onGenerate} data-testid="enclosure-generate">
          {view?.exists ? "Regenerate" : "Generate"}
        </Button>
        <Button size="sm" disabled={busy || !view?.exists} onClick={onCheck} data-testid="enclosure-check">
          Check alignment
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="enclosure-v2-controls">
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.08em] text-muted">
          Outline offset mm
          <Input
            type="number"
            min={0}
            max={40}
            step={0.5}
            value={draft.outlineOffsetMm}
            onChange={(e) => onDraftChange({ outlineOffsetMm: e.target.value })}
            data-testid="enclosure-offset"
            className="h-8 px-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.08em] text-muted">
          Clearance mm
          <Input
            type="number"
            min={0}
            max={20}
            step={0.5}
            value={draft.clearanceMm}
            onChange={(e) => onDraftChange({ clearanceMm: e.target.value })}
            data-testid="enclosure-clearance"
            className="h-8 px-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.08em] text-muted">
          Vent pattern
          <Select
            value={draft.ventPattern}
            onChange={(e) =>
              onDraftChange({ ventPattern: e.target.value as EnclosureDraft["ventPattern"] })
            }
            data-testid="enclosure-vents"
            className="h-8"
          >
            <option value="none">None</option>
            <option value="grid">Grid</option>
            <option value="slots">Slots</option>
            <option value="honeycomb">Honeycomb</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.08em] text-muted">
          Vent faces
          <Select
            value={draft.ventFaces}
            onChange={(e) => onDraftChange({ ventFaces: e.target.value as EnclosureDraft["ventFaces"] })}
            data-testid="enclosure-vent-faces"
            className="h-8"
            disabled={draft.ventPattern === "none"}
          >
            <option value="lid">Lid</option>
            <option value="walls">Walls</option>
            <option value="both">Lid + walls</option>
          </Select>
        </label>
        <label className="flex items-end gap-2 pb-1 text-xs text-fg">
          <input
            type="checkbox"
            checked={draft.snapFit}
            onChange={(e) => onDraftChange({ snapFit: e.target.checked })}
            data-testid="enclosure-snapfit"
            className="accent-primary"
          />
          Snap-fit clips
        </label>
      </div>
      {error && (
        <p className="mt-1 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {view && (
        <p className="mt-1 text-xs text-muted" data-testid="enclosure-meta">
          {view.stale
            ? "Board changed — regenerate so cutouts stay aligned."
            : view.ok
              ? `In sync · ${view.cutouts.length} cutout(s) · ${view.holes} hole(s) · ${view.vents} vent(s) · ${view.clips} clip(s)`
              : view.issues[0] ?? "Cutouts need attention."}
          {view.files.length ? ` · ${view.files.join(", ")}` : ""}
        </p>
      )}
      {view && view.issues.length > 1 && (
        <ul className="mt-1 list-disc pl-4 text-xs text-warning" data-testid="enclosure-issues">
          {view.issues.slice(0, 6).map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {view?.previewSvg && (
        <div
          className="mt-2 max-w-full overflow-auto rounded-md border border-border bg-bg [&_svg]:h-auto [&_svg]:max-w-full"
          data-testid="enclosure-preview"
          dangerouslySetInnerHTML={{ __html: view.previewSvg }}
        />
      )}
    </section>
  );
}

export function EnclosurePanel() {
  const client = useCoreClient();
  const projectId = useUiStore((s) => s.activeProjectId);
  const [view, setView] = useState<EnclosureView | null>(null);
  const [draft, setDraft] = useState<EnclosureDraft>(DEFAULT_ENCLOSURE_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (action: "generate" | "status" | "check", extras: Record<string, unknown> = {}) => {
      if (!projectId) return;
      setBusy(true);
      setError(null);
      try {
        const res = await client.callTool("cad_enclosure", {
          projectId,
          action,
          ...extras,
        });
        const next = enclosureFromTool(res);
        setView(next);
        if (action !== "generate") setDraft(next.draft);
        const rec = asRecord(res);
        if (rec && rec["ok"] === false && typeof rec["text"] === "string") setError(rec["text"]);
      } catch (e) {
        const failure = enclosureFailure(e);
        if (failure.result) setView(enclosureFromTool(failure.result));
        if (failure.message) setError(failure.message);
      } finally {
        setBusy(false);
      }
    },
    [client, projectId],
  );

  useEffect(() => {
    if (!projectId) {
      setView(null);
      return;
    }
    void call("status");
  }, [projectId, call]);

  if (!projectId) return null;
  return (
    <EnclosureScreen
      view={view}
      draft={draft}
      busy={busy}
      error={error}
      onDraftChange={(patch) => setDraft((cur) => ({ ...cur, ...patch }))}
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
      onCheck={() => void call("check")}
    />
  );
}
