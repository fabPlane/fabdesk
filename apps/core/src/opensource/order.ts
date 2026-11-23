import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gate, type DrcReport, type ErcReport } from "@fabdesk/kicad";
import { ASSEMBLY_MANIFEST_PATH, ProjectDependencySnapshot } from "@fabdesk/protocol";
import type {
  FileEntry,
  OrderCheckStatus,
  OrderReadiness,
  OrderSession,
  OrderVendorId,
} from "@fabdesk/protocol";
import { loadFabCheckEvidence, publicationInProgress, savedHierarchyRevision, snapshotProjectDependencies, type SavedSheetRef } from "@fabdesk/tools";

/** The board and schematic verify_drc / verify_erc check (packages/tools PROJECT_FILES). */
const BOARD_PCB = "board.kicad_pcb";
const BOARD_SCH = "board.kicad_sch";
const DRC_REPORT = "reports/drc.json";
const ERC_REPORT = "reports/erc.json";

type DrcEvidenceReport = DrcReport & { pcbRevision?: { sha256?: unknown }; projectDependencies?: unknown; schematicHierarchy?: { aggregateRevision?: unknown; sheets?: unknown } };
type ErcEvidenceReport = ErcReport & {
  projectDependencies?: unknown;
  measurement?: {
    evidenceLevel?: unknown;
    applicability?: unknown;
    revisionStable?: unknown;
    checkedRevision?: unknown;
    hierarchy?: { referencedFiles?: unknown; sheets?: unknown };
  };
};

/**
 * The saved-file evidence the release gate (`verify_gate`) reads, loaded straight from disk: the
 * project file listing is capped and must not decide whether a report exists.
 */
export type OrderCheckEvidence = {
  allowedDrcWarnings: readonly string[];
  /** A declared assembly cannot use the root-only fabrication/order flow. */
  assemblyDeclared?: boolean;
  publicationInProgress?: boolean;
  /** `board.kicad_pcb` exists, so verify_drc can run. */
  hasBoardPcb: boolean;
  /** `board.kicad_sch` exists, so verify_erc can run. */
  hasBoardSch: boolean;
  /** `inputsChanged`: the files the report measured changed after it was written. */
  drc: { report: DrcEvidenceReport; inputsChanged: boolean } | null;
  erc: { report: ErcEvidenceReport; inputsChanged: boolean } | null;
  /** Soft gate: missing/stale/fail warn, they do not block `ready`. */
  fabPackage: { overall: "pass" | "warn" | "fail"; inputsChanged: boolean } | null;
};

function drcStatus(evidence: OrderCheckEvidence): OrderCheckStatus {
  if (!evidence.hasBoardPcb) return "missing";
  if (!evidence.drc) return "missing";
  if (!ProjectDependencySnapshot.safeParse(evidence.drc.report.projectDependencies).success) return "missing";
  if (typeof evidence.drc.report.pcbRevision?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.drc.report.pcbRevision.sha256)) return "missing";
  if (evidence.drc.inputsChanged) return "stale";
  try {
    return gate(evidence.drc.report, undefined, [...evidence.allowedDrcWarnings]).pass
      ? "pass"
      : "fail";
  } catch {
    return "missing";
  }
}

function fabPackageStatus(
  evidence: OrderCheckEvidence,
  hasPackage: boolean,
): OrderCheckStatus {
  if (!hasPackage) return "not_required";
  if (!evidence.fabPackage) return "missing";
  if (evidence.fabPackage.inputsChanged) return "stale";
  return evidence.fabPackage.overall === "fail" ? "fail" : "pass";
}

function ercStatus(evidence: OrderCheckEvidence): OrderCheckStatus {
  if (!evidence.hasBoardSch) return "not_required";
  if (!evidence.erc) return "missing";
  const { report, inputsChanged } = evidence.erc;
  // verify_erc writes a non-applicable report when the saved hierarchy is incomplete (common on
  // remixed boards). Nothing the user can run clears that, so it is a warning, not a block.
  if (report.measurement?.applicability === false || report.measurement?.evidenceLevel === "missing")
    return "not_applicable";
  if (report.measurement?.evidenceLevel !== "measured" || typeof report.measurement.checkedRevision !== "string" || report.measurement.revisionStable !== true) return "missing";
  if (!ProjectDependencySnapshot.safeParse(report.projectDependencies).success) return "missing";
  if (inputsChanged) return "stale";
  const errors: unknown = report.counts?.errors;
  if (typeof errors !== "number") return "missing";
  return errors === 0 ? "pass" : "fail";
}

const CHECK_REASONS: Record<"drc" | "erc", Partial<Record<OrderCheckStatus, string>>> = {
  drc: {
    missing: "Run DRC on the current board before ordering.",
    stale: "The board, parity sources, rules, libraries or model dependencies changed after the last DRC report. Run DRC again.",
    fail: "The current board fails the DRC release gate. Open DRC/ERC, fix the violations, and run DRC again.",
  },
  erc: {
    missing: "Run ERC on the current schematic before ordering.",
    stale: "The schematic or its rules, libraries or model dependencies changed after the last ERC report. Run ERC again.",
    fail: "The current schematic has ERC errors. Open DRC/ERC, fix them, and run ERC again.",
  },
};

export function assessOrderReadiness(
  files: readonly Pick<FileEntry, "path">[],
  evidence: OrderCheckEvidence,
): OrderReadiness {
  const assemblyDeclared = evidence.assemblyDeclared ?? files.some(f => f.path === ASSEMBLY_MANIFEST_PATH);
  const hasGerbers = files.some((f) => f.path.startsWith("exports/gerbers/") || /gerber/i.test(f.path));
  const hasFabricationZip = files.some((f) => f.path === "exports/fabrication.zip" || (f.path.startsWith("exports/") && f.path.endsWith(".zip")));
  const hasRouted = files.some((f) => f.path === "circuit.routed.json");
  const hasKicadPcb = evidence.hasBoardPcb || files.some((f) => f.path.endsWith(".kicad_pcb"));
  const hasOrderArtifact = hasGerbers || hasFabricationZip || hasKicadPcb || hasRouted;
  const hasPackage = hasGerbers || hasFabricationZip;
  const checks: OrderReadiness["checks"] = {
    drc: drcStatus(evidence),
    erc: ercStatus(evidence),
    fabPackage: fabPackageStatus(evidence, hasPackage),
  };
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (evidence.publicationInProgress) reasons.push("Board views and checks are being published. Wait for publication to complete before ordering.");
  if (hasOrderArtifact && !evidence.hasBoardPcb)
    reasons.push("Open or import the source board as board.kicad_pcb and run DRC before ordering. Export files and legacy routing artifacts alone cannot establish readiness.");
  if (assemblyDeclared) reasons.push("Ordering is not available for multi-board projects. Review each board’s checks; assembly fabrication exports are not yet supported.");
  if (!hasOrderArtifact) {
    reasons.push("Add a routed board or KiCad PCB, then export gerbers before ordering.");
  } else if (!hasGerbers && !hasFabricationZip) {
    reasons.push("Export gerbers or a fabrication zip to send to a fab house.");
  }
  for (const key of ["drc", "erc"] as const) {
    const reason = CHECK_REASONS[key][checks[key]];
    if (reason) reasons.push(reason);
  }
  if (checks.erc === "not_applicable")
    warnings.push(
      "ERC could not check this schematic (its saved hierarchy is incomplete). Review the schematic before ordering.",
    );
  if (checks.fabPackage === "missing")
    warnings.push("The exported fab package has not been checked yet. Run a fab package check before sending files.");
  if (checks.fabPackage === "stale")
    warnings.push("The fabrication files changed after the last fab package check. Run the check again.");
  if (checks.fabPackage === "fail")
    warnings.push("The last fab package check reported failures. Review the Fab check tab before ordering.");
  if (checks.fabPackage === "pass" && evidence.fabPackage?.overall === "warn")
    warnings.push("The last fab package check passed with warnings. Review the Fab check tab.");
  const blocking = (s: OrderCheckStatus) => s === "missing" || s === "stale" || s === "fail";
  return {
    ready: !evidence.publicationInProgress && !assemblyDeclared && hasOrderArtifact && !blocking(checks.drc) && !blocking(checks.erc),
    hasGerbers,
    hasFabricationZip,
    hasRouted,
    hasKicadPcb,
    checks,
    reasons,
    warnings,
  };
}

async function readJson<T>(path: string): Promise<{ value: T; mtimeMs: number } | null> {
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { value: JSON.parse(text) as T, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

const mtimeMs = (path: string) => stat(path).then((s) => s.mtimeMs, () => null);

/** Backups, autosaves and library sheets never belong to the measured hierarchy. */
const isNativeSheet = (path: string) =>
  path.endsWith(".kicad_sch") &&
  !/(^|\/)[^/]*-backups\//.test(path) &&
  !/(^|\/)libraries\//.test(path) &&
  !/(^|\/)_autosave-[^/]*$/.test(path);

async function ercInputsChanged(projectDir: string, erc: { value: ErcEvidenceReport; mtimeMs: number }) {
  const m = erc.value.measurement;
  const sheets = m?.hierarchy?.sheets;
  if (typeof m?.checkedRevision === "string" && Array.isArray(sheets) && sheets.length) {
    // Content, as the release gate does: recompute the aggregate revision from current bytes.
    return (await savedHierarchyRevision(projectDir, sheets as SavedSheetRef[])) !== m.checkedRevision;
  }
  // Older reports cannot establish content freshness from timestamps alone.
  return true;
}

/** Loads the release gate's saved DRC/ERC evidence for `assessOrderReadiness`. */
export async function loadOrderCheckEvidence(
  projectDir: string,
  allowedDrcWarnings: readonly string[],
): Promise<OrderCheckEvidence> {
  const publishingBefore = await publicationInProgress(projectDir);
  const [board, boardMtime, schMtime, drc, erc, assemblyMtime] = await Promise.all([
    readFile(join(projectDir, BOARD_PCB)).catch(() => null),
    mtimeMs(join(projectDir, BOARD_PCB)),
    mtimeMs(join(projectDir, BOARD_SCH)),
    readJson<DrcEvidenceReport>(join(projectDir, DRC_REPORT)),
    readJson<ErcEvidenceReport>(join(projectDir, ERC_REPORT)),
    mtimeMs(join(projectDir, ASSEMBLY_MANIFEST_PATH)),
  ]);
  const dependencies = await snapshotProjectDependencies(projectDir).catch(() => null);
  const dependenciesChanged = (report: { projectDependencies?: unknown }) => {
    const expected = ProjectDependencySnapshot.safeParse(report.projectDependencies);
    return !expected.success || !dependencies || dependencies.unresolved.length > 0 || expected.data.revision !== dependencies.revision;
  };
  let drcEvidence: OrderCheckEvidence["drc"] = null;
  if (drc && board) {
    const checked = drc.value.pcbRevision?.sha256;
    let inputsChanged =
      typeof checked === "string"
        ? checked !== createHash("sha256").update(board).digest("hex")
        : true;
    inputsChanged ||= dependenciesChanged(drc.value);
    if (typeof drc.value.schematicHierarchy?.aggregateRevision === "string") {
      const sheets = drc.value.schematicHierarchy.sheets ?? erc?.value.measurement?.hierarchy?.sheets;
      inputsChanged ||= !Array.isArray(sheets) || !sheets.length || await savedHierarchyRevision(projectDir, sheets as SavedSheetRef[]) !== drc.value.schematicHierarchy.aggregateRevision;
    }
    drcEvidence = { report: drc.value, inputsChanged };
  }
  return {
    allowedDrcWarnings,
    publicationInProgress: publishingBefore || await publicationInProgress(projectDir),
    assemblyDeclared: assemblyMtime !== null,
    hasBoardPcb: board !== null,
    hasBoardSch: schMtime !== null,
    drc: drcEvidence,
    erc: erc ? { report: erc.value, inputsChanged: dependenciesChanged(erc.value) || await ercInputsChanged(projectDir, erc) } : null,
    fabPackage: await loadFabPackageEvidence(projectDir),
  };
}

async function loadFabPackageEvidence(
  projectDir: string,
): Promise<OrderCheckEvidence["fabPackage"]> {
  try {
    const evidence = await loadFabCheckEvidence(projectDir);
    if (!evidence) return null;
    const overall = evidence.report.overall;
    if (overall !== "pass" && overall !== "warn" && overall !== "fail") return null;
    return { overall, inputsChanged: evidence.inputsChanged };
  } catch {
    return null;
  }
}

const VENDORS: Record<OrderVendorId, { label: string; enabled: boolean; orderUrl?: string }> = {
  jlcpcb: { label: "JLCPCB", enabled: true, orderUrl: "https://cart.jlcpcb.com/quote" },
  pcbway: { label: "PCBWay", enabled: true, orderUrl: "https://www.pcbway.com/orderonline.aspx" },
  laser: { label: "Laser", enabled: false },
  cnc: { label: "CNC", enabled: false },
};

export function orderVendors(): Array<{ id: OrderVendorId; label: string; enabled: boolean }> {
  return (Object.entries(VENDORS) as Array<[OrderVendorId, (typeof VENDORS)[OrderVendorId]]>).map(([id, v]) => ({
    id,
    label: v.label,
    enabled: v.enabled,
  }));
}

export function startOrderSession(vendor: OrderVendorId): OrderSession {
  const info = VENDORS[vendor];
  if (!info.enabled) {
    return {
      vendor,
      label: info.label,
      enabled: false,
      steps: [{ title: "Coming later", body: `${info.label} ordering is not available yet.` }],
    };
  }
  return {
    vendor,
    label: info.label,
    enabled: true,
    ...(info.orderUrl ? { orderUrl: info.orderUrl } : {}),
    steps: [
      {
        title: "Export fabrication files",
        body: "Use export_zip (or export_gerbers + export_drill) so exports/fabrication.zip is ready to upload.",
      },
      {
        title: "Check the fab package",
        body: "Run fab_package_check (or open the Fab check tab) so Gerbers, drill, BOM and pick-and-place are inspected before you upload them.",
      },
      {
        title: `Open ${info.label}`,
        body: `Create a PCB order on ${info.label} and upload the fabrication zip. fabPlane does not place the order for you.`,
      },
      {
        title: "Check the quote",
        body: "Confirm layers, thickness, surface finish, and quantity on the fab house quote before paying.",
      },
    ],
  };
}
