/** Read-only summaries of persisted source-build and release evidence for project status surfaces. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_FILES, exists, readJsonOrNull } from "../fs";
import type { ProjectHandle } from "../registry";
import { p } from "./common";

export type SourceBuildSummary = {
  ok: boolean;
  at: string;
  errors: unknown[];
  warnings: unknown[];
};

type ReleaseReport = {
  capturedAt?: unknown;
  pass?: unknown;
  revisions?: { schematic?: unknown; pcb?: unknown; project?: unknown } | undefined;
  inventory?: Array<{ status?: unknown }> | undefined;
  schematicHierarchy?:
    | {
        rootFile?: unknown;
        sheets?: Array<{
          hierarchyPath?: unknown;
          nativePath?: unknown;
          identity?: unknown;
          sha256?: unknown;
        }>;
      }
    | undefined;
};

export type LastReleaseStatus =
  | { status: "never" }
  | { status: "missing"; reason: string }
  | {
      status: "pass" | "fail";
      capturedAt: string;
      checkedRevisions: { schematic: string; pcb: string; project: string | null };
      currentRevisions: {
        schematic: string | null;
        pcb: string | null;
        project: string | null;
      };
      outputs: { available: number; total: number; missing: number };
      stale: boolean;
    };

async function sha256OrNull(path: string): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return null;
  }
}

export type SavedSheetRef = { hierarchyPath?: unknown; nativePath?: unknown; identity?: unknown };

/**
 * Recomputes a saved schematic hierarchy's aggregate revision (the formula of `inspectSchematicHierarchy`)
 * from the current bytes of the sheets an earlier measurement recorded, without running kicad-cli.
 * Null when a sheet reference is malformed or a sheet can no longer be read.
 */
export async function savedHierarchyRevision(
  projectDir: string,
  sheets: readonly SavedSheetRef[],
): Promise<string | null> {
  const entries: string[] = [];
  for (const sheet of sheets) {
    if (
      typeof sheet.hierarchyPath !== "string" ||
      typeof sheet.nativePath !== "string" ||
      typeof sheet.identity !== "string"
    )
      return null;
    const revision = await sha256OrNull(join(projectDir, sheet.nativePath));
    if (!revision) return null;
    entries.push(`${sheet.hierarchyPath}\0${sheet.nativePath}\0${sheet.identity}\0${revision}`);
  }
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

async function aggregateRevisionOrNull(
  project: ProjectHandle,
  release: ReleaseReport,
): Promise<string | null> {
  const sheets = release.schematicHierarchy?.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0)
    return sha256OrNull(p(project, PROJECT_FILES.boardSch));
  return savedHierarchyRevision(project.dir, sheets);
}

export async function readProjectStatusEvidence(project: ProjectHandle): Promise<{
  lastSourceBuild: {
    ok: boolean;
    errors: number;
    warnings: number;
    at: string;
  } | null;
  lastRelease: LastReleaseStatus;
}> {
  const build = await readJsonOrNull<SourceBuildSummary>(
    p(project, PROJECT_FILES.reports, "build.json"),
  );
  const releasePath = p(project, PROJECT_FILES.reports, "release.json");
  const releaseExists = await exists(releasePath);
  const release = await readJsonOrNull<ReleaseReport>(releasePath);
  const lastSourceBuild = build
    ? {
        ok: build.ok,
        errors: Array.isArray(build.errors) ? build.errors.length : 0,
        warnings: Array.isArray(build.warnings) ? build.warnings.length : 0,
        at: build.at,
      }
    : null;

  if (!releaseExists) return { lastSourceBuild, lastRelease: { status: "never" } };
  if (!release)
    return {
      lastSourceBuild,
      lastRelease: { status: "missing", reason: "release.json is unreadable" },
    };

  const schematicRevision = release.revisions?.schematic;
  const pcbRevision = release.revisions?.pcb;
  const projectRevision = release.revisions?.project;
  if (
    typeof release.pass !== "boolean" ||
    typeof release.capturedAt !== "string" ||
    typeof schematicRevision !== "string" ||
    typeof pcbRevision !== "string" ||
    !Array.isArray(release.inventory)
  )
    return {
      lastSourceBuild,
      lastRelease: {
        status: "missing",
        reason: "release.json lacks pass/fail, capture time, revisions, or output inventory",
      },
    };

  const [currentSchematic, currentPcb, currentProject] = await Promise.all([
    aggregateRevisionOrNull(project, release),
    sha256OrNull(p(project, PROJECT_FILES.boardPcb)),
    sha256OrNull(p(project, PROJECT_FILES.boardPro)),
  ]);
  const available = release.inventory.filter((entry) => entry.status === "available").length;
  const total = release.inventory.length;
  return {
    lastSourceBuild,
    lastRelease: {
      status: release.pass ? "pass" : "fail",
      capturedAt: release.capturedAt,
      checkedRevisions: {
        schematic: schematicRevision,
        pcb: pcbRevision,
        project: typeof projectRevision === "string" ? projectRevision : null,
      },
      currentRevisions: {
        schematic: currentSchematic,
        pcb: currentPcb,
        project: currentProject,
      },
      outputs: { available, total, missing: total - available },
      stale:
        currentSchematic !== schematicRevision ||
        currentPcb !== pcbRevision ||
        (typeof projectRevision === "string" && currentProject !== projectRevision),
    },
  };
}

export function formatLastRelease(release: LastReleaseStatus): string {
  if (release.status === "never") return "never";
  if (release.status === "missing") return `missing (${release.reason})`;
  return `${release.status.toUpperCase()} (${release.outputs.available}/${release.outputs.total} outputs, captured ${release.capturedAt}, checked schematic ${release.checkedRevisions.schematic.slice(0, 12)}/PCB ${release.checkedRevisions.pcb.slice(0, 12)}, ${release.stale ? "STALE relative to current native files" : "current native files match"})`;
}
