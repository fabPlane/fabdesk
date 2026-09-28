import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gate, type DrcReport, type ErcReport } from "@fabdesk/kicad";
import type {
  FileEntry,
  OrderCheckStatus,
  OrderReadiness,
  OrderSession,
  OrderVendorId,
} from "@fabdesk/protocol";
import { savedHierarchyRevision, type SavedSheetRef } from "@fabdesk/tools";

/** The board and schematic verify_drc / verify_erc check (packages/tools PROJECT_FILES). */
const BOARD_PCB = "board.kicad_pcb";
const BOARD_SCH = "board.kicad_sch";
const DRC_REPORT = "reports/drc.json";
const ERC_REPORT = "reports/erc.json";

type DrcEvidenceReport = DrcReport & { pcbRevision?: { sha256?: unknown } };
type ErcEvidenceReport = ErcReport & {
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
  /** `board.kicad_pcb` exists, so verify_drc can run. */
  hasBoardPcb: boolean;
  /** `board.kicad_sch` exists, so verify_erc can run. */
  hasBoardSch: boolean;
  /** `inputsChanged`: the files the report measured changed after it was written. */
  drc: { report: DrcEvidenceReport; inputsChanged: boolean } | null;
  erc: { report: ErcEvidenceReport; inputsChanged: boolean } | null;
};

function drcStatus(evidence: OrderCheckEvidence): OrderCheckStatus {
  if (!evidence.hasBoardPcb) return "not_required";
  if (!evidence.drc) return "missing";
  if (evidence.drc.inputsChanged) return "stale";
  try {
    return gate(evidence.drc.report, undefined, [...evidence.allowedDrcWarnings]).pass
      ? "pass"
      : "fail";
  } catch {
    return "missing";
  }
}

function ercStatus(evidence: OrderCheckEvidence): OrderCheckStatus {
  if (!evidence.hasBoardSch) return "not_required";
  if (!evidence.erc) return "missing";
  const { report, inputsChanged } = evidence.erc;
  // verify_erc writes a non-applicable report when the saved hierarchy is incomplete (common on
  // remixed boards). Nothing the user can run clears that, so it is a warning, not a block.
  if (report.measurement?.applicability === false || report.measurement?.evidenceLevel === "missing")
    return "not_applicable";
  if (inputsChanged || report.measurement?.revisionStable === false) return "stale";
  const errors: unknown = report.counts?.errors;
  if (typeof errors !== "number") return "missing";
  return errors === 0 ? "pass" : "fail";
}

const CHECK_REASONS: Record<"drc" | "erc", Partial<Record<OrderCheckStatus, string>>> = {
  drc: {
    missing: "Run DRC on the current board before ordering.",
    stale: "The board changed after the last DRC report. Run DRC again.",
    fail: "The current board fails the DRC release gate. Open DRC/ERC, fix the violations, and run DRC again.",
  },
  erc: {
    missing: "Run ERC on the current schematic before ordering.",
    stale: "The schematic changed after the last ERC report. Run ERC again.",
    fail: "The current schematic has ERC errors. Open DRC/ERC, fix them, and run ERC again.",
  },
};

export function assessOrderReadiness(
  files: readonly Pick<FileEntry, "path">[],
  evidence: OrderCheckEvidence,
): OrderReadiness {
  const hasGerbers = files.some((f) => f.path.startsWith("exports/gerbers/") || /gerber/i.test(f.path));
  const hasFabricationZip = files.some((f) => f.path === "exports/fabrication.zip" || (f.path.startsWith("exports/") && f.path.endsWith(".zip")));
  const hasRouted = files.some((f) => f.path === "circuit.routed.json");
  const hasKicadPcb = evidence.hasBoardPcb || files.some((f) => f.path.endsWith(".kicad_pcb"));
  const hasOrderArtifact = hasGerbers || hasFabricationZip || hasKicadPcb || hasRouted;
  const checks: OrderReadiness["checks"] = { drc: drcStatus(evidence), erc: ercStatus(evidence) };
  const reasons: string[] = [];
  const warnings: string[] = [];
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
  const blocking = (s: OrderCheckStatus) => s === "missing" || s === "stale" || s === "fail";
  return {
    ready: hasOrderArtifact && !blocking(checks.drc) && !blocking(checks.erc),
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
  // Older reports carry no sheet identities; fall back to the times of the sheets they measured.
  const referenced = m?.hierarchy?.referencedFiles;
  const inputs = (
    Array.isArray(referenced) && referenced.every((f) => typeof f === "string")
      ? (referenced as string[])
      : [BOARD_SCH]
  ).filter(isNativeSheet);
  for (const input of inputs) {
    const t = await mtimeMs(join(projectDir, input));
    if (t === null || t > erc.mtimeMs) return true;
  }
  return false;
}

/** Loads the release gate's saved DRC/ERC evidence for `assessOrderReadiness`. */
export async function loadOrderCheckEvidence(
  projectDir: string,
  allowedDrcWarnings: readonly string[],
): Promise<OrderCheckEvidence> {
  const [board, boardMtime, schMtime, drc, erc] = await Promise.all([
    readFile(join(projectDir, BOARD_PCB)).catch(() => null),
    mtimeMs(join(projectDir, BOARD_PCB)),
    mtimeMs(join(projectDir, BOARD_SCH)),
    readJson<DrcEvidenceReport>(join(projectDir, DRC_REPORT)),
    readJson<ErcEvidenceReport>(join(projectDir, ERC_REPORT)),
  ]);
  let drcEvidence: OrderCheckEvidence["drc"] = null;
  if (drc && board) {
    const checked = drc.value.pcbRevision?.sha256;
    const inputsChanged =
      typeof checked === "string"
        ? checked !== createHash("sha256").update(board).digest("hex")
        : (boardMtime ?? 0) > drc.mtimeMs;
    drcEvidence = { report: drc.value, inputsChanged };
  }
  return {
    allowedDrcWarnings,
    hasBoardPcb: board !== null,
    hasBoardSch: schMtime !== null,
    drc: drcEvidence,
    erc: erc ? { report: erc.value, inputsChanged: await ercInputsChanged(projectDir, erc) } : null,
  };
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
