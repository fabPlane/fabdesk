import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { useProjectJson, useRunTool } from "@fabdesk/client-core";
import { ProjectImage } from "../chat/ProjectImage";
import { useUiStore } from "../stores/ui";
import { cn } from "../util";
import {
  isFabCheckReport,
  markerPercent,
  verdictTone,
  type FabCheckFinding,
  type FabCheckReport,
  type FabCheckRender,
} from "./fab-check";

export function FabCheckTab() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const reportQ = useProjectJson(projectId, "reports/fab-check/latest.json");
  const tool = useRunTool();
  const [selected, setSelected] = useState<string | null>(null);
  const [layer, setLayer] = useState<string | null>(null);
  const report = isFabCheckReport(reportQ.data) ? reportQ.data : null;
  const finding = report?.findings.find((f) => f.id === selected) ?? null;
  const renders = report?.renders ?? [];
  const active = useMemo(() => pickRender(renders, layer, finding), [renders, layer, finding]);

  if (!projectId) return <EmptyState title="No project selected" />;
  return (
    <div className="flex h-full flex-col" data-testid="fab-check-tab">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <Button
          size="sm"
          disabled={tool.state.status === "running"}
          onClick={() => void tool.run("fab_package_check", { projectId })}
          data-testid="fab-check-run"
        >
          Check fab package
        </Button>
        {tool.state.status === "running" && <Spinner />}
        {tool.state.error && <span className="text-xs text-danger">{tool.state.error}</span>}
        <span className="ml-auto text-[11px] text-muted">
          {report ? `${report.overall} · ${report.rules.label} · ${report.files.length} files` : "no report yet"}
        </span>
      </div>
      <p className="px-3 py-2 text-xs text-muted">Checks project-level exports. This does not verify individual assembly boards, assembly connections, or stock.</p>
      {reportQ.isError || reportQ.parseError ? (
        <LoadError title="Could not load the fab package report" onRetry={() => void reportQ.refetch()} />
      ) : reportQ.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : !report ? (
        <EmptyState title="No fab package check yet">
          Export gerbers, then run Check fab package. The report lands in reports/fab-check/.
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-72 shrink-0 flex-col border-r border-border">
            <div className="border-b border-border px-3 py-2">
              <Badge tone={verdictTone(report.overall)}>{report.overall}</Badge>
              <div className="mt-1 text-xs text-muted">{report.source}</div>
            </div>
            <ul className="min-h-0 flex-1 overflow-auto p-2 text-xs" data-testid="fab-check-sections">
              {report.checks.map((check) => (
                <li key={check.id} className="mb-2 rounded border border-border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{check.title}</span>
                    <Badge tone={verdictTone(check.verdict)}>{check.verdict}</Badge>
                  </div>
                  <p className="mt-1 text-muted">{check.summary}</p>
                  {check.findings.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={cn(
                        "mt-1 block w-full rounded px-1 py-0.5 text-left hover:bg-panel-2",
                        selected === f.id && "bg-panel-2",
                      )}
                      onClick={() => {
                        setSelected(f.id);
                        if (f.layer) setLayer(f.layer);
                      }}
                    >
                      <span className={f.severity === "fail" ? "text-danger" : "text-warning"}>{f.message}</span>
                      {f.x != null && f.y != null && (
                        <span className="ml-1 font-mono text-[10px] text-accent">
                          ({f.x.toFixed(2)}, {f.y.toFixed(2)})
                        </span>
                      )}
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1">
              {renders.map((r) => (
                <button
                  key={r.layer}
                  type="button"
                  className={cn(
                    "shrink-0 rounded border px-2 py-1 text-[11px]",
                    active?.layer === r.layer ? "border-accent bg-accent/10" : "border-border",
                  )}
                  onClick={() => setLayer(r.layer)}
                >
                  {r.layer.split("/").pop()}
                </button>
              ))}
            </div>
            <div className="relative min-h-0 flex-1 overflow-auto bg-black/40 p-3" data-testid="fab-check-viewer">
              {active && projectId ? (
                <div className="relative inline-block max-w-full">
                  <ProjectImage projectId={projectId} path={active.pngPath} className="max-h-full max-w-full" />
                  {finding && finding.x != null && finding.y != null && (
                    <span
                      className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-danger bg-danger/40"
                      style={markerPercent(active.bounds, finding.x, finding.y)}
                      data-testid="fab-check-marker"
                    />
                  )}
                </div>
              ) : (
                <EmptyState title="No layer renders">Run the check to render each Gerber layer.</EmptyState>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function pickRender(
  renders: FabCheckRender[],
  layer: string | null,
  finding: FabCheckFinding | null,
): FabCheckRender | undefined {
  if (layer) {
    const exact = renders.find((r) => r.layer === layer || r.layer.endsWith(layer));
    if (exact) return exact;
  }
  if (finding?.layer) {
    const match = renders.find((r) => r.layer === finding.layer || r.layer.endsWith(finding.layer ?? ""));
    if (match) return match;
  }
  return renders.find((r) => r.layer === "top-composite") ?? renders[0];
}

export function FabCheckSummaryCard({ report }: { report: FabCheckReport }) {
  return (
    <div className="rounded-lg border border-border bg-panel-2/40 p-3 text-xs" data-testid="fab-check-chat-card">
      <div className="flex items-center gap-2">
        <Badge tone={verdictTone(report.overall)}>Fab package {report.overall}</Badge>
        <span className="text-muted">{report.rules.label}</span>
      </div>
      <ul className="mt-2 space-y-1">
        {report.checks.map((c) => (
          <li key={c.id}>
            <span className="font-medium">{c.title}</span>
            <span className="text-muted"> — {c.verdict}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
