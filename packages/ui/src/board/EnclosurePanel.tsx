import { useCallback, useEffect, useState } from "react";
import { useCoreClient } from "@fabdesk/client-core";
import { Button, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";

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
};

export function enclosureFromTool(result: unknown): EnclosureView {
  const rec = asRecord(result);
  const body = rec && "json" in rec ? asRecord(rec["json"]) : rec;
  const nested = body && "json" in body ? asRecord(body["json"]) : body;
  const data = nested ?? body ?? {};
  const alignment = asRecord(data["alignment"]);
  const board = asRecord(data["board"]);
  const features = asRecord(data["features"]) ?? board;
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
  const files = ["spec", "stl", "lidStl", "step"]
    .map((k) => data[k])
    .filter((v): v is string => typeof v === "string");
  const text = typeof rec?.["text"] === "string" ? rec["text"] : "";
  return {
    exists: data["exists"] !== false && (Boolean(alignment) || files.length > 0),
    stale: alignment?.["stale"] === true,
    ok: alignment?.["ok"] !== false && issues.length === 0,
    summary: firstLine(text) || (data["exists"] === false ? "No enclosure yet." : "Enclosure"),
    issues,
    cutouts,
    holes: typeof features?.["holes"] === "number" ? features["holes"] : 0,
    connectors: Array.isArray(features?.["connectors"])
      ? features["connectors"].length
      : cutouts.length,
    files,
    ...(data["appliedToCad"] === true ? { appliedToCad: true } : {}),
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim()) ?? "";
}

/** Presentational enclosure strip shared by the CAD tab and static tests. */
export function EnclosureScreen({
  view,
  busy,
  error,
  onGenerate,
  onCheck,
}: {
  view: EnclosureView | null;
  busy: boolean;
  error: string | null;
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
          Enclosure
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
              ? `In sync · ${view.cutouts.length} cutout(s) · ${view.holes} hole(s)`
              : view.issues[0] ?? "Cutouts need attention."}
          {view.files.length ? ` · ${view.files.join(", ")}` : ""}
        </p>
      )}
    </section>
  );
}

export function EnclosurePanel() {
  const client = useCoreClient();
  const projectId = useUiStore((s) => s.activeProjectId);
  const [view, setView] = useState<EnclosureView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: "generate" | "status" | "check") => {
      if (!projectId) return;
      setBusy(true);
      setError(null);
      try {
        const res = await client.callTool("cad_enclosure", {
          projectId,
          action,
          ...(action === "generate" ? { applyToCad: true } : {}),
        });
        setView(enclosureFromTool(res));
        const rec = asRecord(res);
        if (rec && rec["ok"] === false && typeof rec["text"] === "string") setError(rec["text"]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
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
    void run("status");
  }, [projectId, run]);

  if (!projectId) return null;
  return (
    <EnclosureScreen
      view={view}
      busy={busy}
      error={error}
      onGenerate={() => void run("generate")}
      onCheck={() => void run("check")}
    />
  );
}
