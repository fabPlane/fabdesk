import type { FileEntry, ToolManifestEntry } from "@fabdesk/protocol";
import { projectJobBoard, type ProjectJob } from "./project-jobs";

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const resultJson = (job: ProjectJob) => record(record(job.result)?.json);

/** Fold consecutive successful read operations only; keep every run available for inspection. */
export function activityGroups(jobs: ProjectJob[], manifest: Pick<ToolManifestEntry, "name" | "annotations">[]) {
  const groups: ProjectJob[][] = [];
  const readOnly = new Set(manifest.filter(tool => tool.annotations.readOnlyHint).map(tool => tool.name));
  const key = (job: ProjectJob) => {
    if (job.status !== "done" || record(job.result)?.isError === true || !readOnly.has(job.kind.replace(/^tool:/, ""))) return null;
    return JSON.stringify([job.projectId, job.kind, projectJobBoard(job)]);
  };
  for (const job of jobs) {
    const previous = groups.at(-1), first = previous?.[0], nextKey = key(job);
    if (previous && first && nextKey !== null && nextKey === key(first)) previous.push(job);
    else groups.push([job]);
  }
  return groups;
}

/** A completed process is not a passed design check. Summarize recorded measurements only. */
export function activityOutcome(job: ProjectJob): string {
  if (job.status === "failed") return job.error?.split("\n")[0]?.slice(0, 180) || "Task failed. Open details for the recorded error.";
  if (job.status === "cancelled") return "Task cancelled";
  if (job.status !== "done") return job.note || (job.status === "queued" ? "Waiting to start" : "Working…");
  const json = resultJson(job), counts = record(json?.counts);
  if (/verify|drc|erc/.test(job.kind) && counts && Number.isSafeInteger(counts.errors) && Number.isSafeInteger(counts.warnings) && Number(counts.errors) >= 0 && Number(counts.warnings) >= 0) {
    return `Saved report: ${counts.errors} errors · ${counts.warnings} warnings. Review coverage and freshness in Checks.`;
  }
  if (job.kind.replace(/^tool:/, "") === "bom_read" && Array.isArray(json?.lines)) return `${json.lines.length} BOM lines read${json.complete === false ? " · incomplete source coverage" : ""}`;
  if (record(job.result)?.isError === true) return "Run finished with reported concerns. Review the result.";
  return "Run finished. Review its recorded result.";
}

/** Resolve only explicit result paths that still exist in this project's file inventory. */
export function activityArtifacts(job: ProjectJob, projectId: string, projectPath: string, files: Pick<FileEntry, "path">[]): string[] {
  if (job.projectId !== projectId || job.status !== "done") return [];
  const json = resultJson(job);
  if (!json || typeof json.projectId === "string" && json.projectId !== projectId) return [];
  const board = record(json._board);
  if (board && board.projectId !== projectId) return [];
  const candidates: unknown[] = [json.path, json.modelPath, json.pngPath, json.poster, json.receiptPath, json.manifest];
  if (Array.isArray(json.files)) candidates.push(...json.files);
  else if (record(json.files)) candidates.push(...Object.values(record(json.files)!));
  const root = projectPath.replace(/\/+$/, "") + "/", existing = new Set(files.map(file => file.path));
  const paths = candidates.flatMap(value => {
    if (typeof value !== "string") return [];
    const relative = value.startsWith(root) ? value.slice(root.length) : value;
    if (relative.startsWith("/") || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..") || !existing.has(relative)) return [];
    return [relative];
  });
  return [...new Set(paths)];
}
