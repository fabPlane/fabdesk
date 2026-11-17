import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PROJECT_FILES, jailPath, readJsonOrNull } from "./fs";
import type { ToolContext } from "./registry";
import { inspectSavedHierarchy } from "./tools/common";

type Freshness = { status: "missing" | "unverified" | "current" | "stale"; reason?: string };
/** Compare reports with saved sources; a report without provenance cannot establish freshness. */
export async function canonicalReportStatus(
  ctx: ToolContext,
): Promise<{ drc: Freshness; erc: Freshness }> {
  const project = ctx.requireProject();
  const drc = await readJsonOrNull<{
    pcbRevision?: { sha256?: string };
    schematicHierarchy?: { aggregateRevision?: string };
  }>(await jailPath(project.dir, `${PROJECT_FILES.reports}/drc.json`));
  const erc = await readJsonOrNull<{
    measurement?: { checkedRevision?: string; revisionStable?: boolean; evidenceLevel?: string };
  }>(await jailPath(project.dir, `${PROJECT_FILES.reports}/erc.json`));
  let currentHierarchy: string | null = null;
  if (drc?.schematicHierarchy?.aggregateRevision || erc?.measurement?.checkedRevision) {
    try {
      const hierarchy = await inspectSavedHierarchy(ctx, project);
      if (hierarchy.complete) currentHierarchy = hierarchy.aggregateRevision;
    } catch {
      /* Unavailable hierarchy never establishes current evidence. */
    }
  }
  const pcb = await readFile(await jailPath(project.dir, "board.kicad_pcb")).catch(() => null);
  const currentPcb = pcb ? createHash("sha256").update(pcb).digest("hex") : null;
  return {
    drc: !drc
      ? { status: "missing" }
      : !drc.pcbRevision?.sha256
        ? { status: "unverified", reason: "report has no saved PCB revision" }
        : drc.pcbRevision.sha256 !== currentPcb
          ? { status: "stale", reason: "saved PCB changed; run verify_drc" }
          : drc.schematicHierarchy?.aggregateRevision && !currentHierarchy
            ? { status: "unverified", reason: "current schematic hierarchy unavailable" }
            : drc.schematicHierarchy?.aggregateRevision &&
                drc.schematicHierarchy.aggregateRevision !== currentHierarchy
              ? { status: "stale", reason: "schematic parity source changed; run verify_drc" }
              : { status: "current" },
    erc: !erc
      ? { status: "missing" }
      : !erc.measurement?.checkedRevision || erc.measurement.evidenceLevel !== "measured"
        ? { status: "unverified", reason: "report has no measured schematic revision" }
        : erc.measurement.revisionStable === false
          ? { status: "stale", reason: "schematic changed during ERC; run verify_erc" }
          : !currentHierarchy
            ? { status: "unverified", reason: "current schematic hierarchy unavailable" }
            : erc.measurement.checkedRevision !== currentHierarchy
              ? { status: "stale", reason: "saved schematic hierarchy changed; run verify_erc" }
              : { status: "current" },
  };
}
