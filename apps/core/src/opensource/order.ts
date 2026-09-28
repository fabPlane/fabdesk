import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gate, type DrcReport, type ErcReport } from "@fabdesk/kicad";
import type {
  FileEntry,
  OrderCheckStatus,
  OrderReadiness,
  OrderSession,
  OrderVendorId,
} from "@fabdesk/protocol";

type OrderFile = Pick<FileEntry, "path" | "mtime">;

/**
 * The saved-file DRC/ERC evidence the release gate (`verify_gate`) reads: `reports/drc.json` from
 * verify_drc (bound to the board by `pcbRevision.sha256`) and `reports/erc.json` from verify_erc.
 */
export type OrderCheckEvidence = {
  allowedDrcWarnings: readonly string[];
  drc: (DrcReport & { pcbRevision?: { sha256?: unknown } }) | null;
  erc: (ErcReport & { measurement?: { revisionStable?: unknown } }) | null;
  /** sha256 of the current `board.kicad_pcb`, or null when it does not exist. */
  currentPcbSha256: string | null;
};

const DRC_REPORT = "reports/drc.json";
const ERC_REPORT = "reports/erc.json";
const BOARD_PCB = "board.kicad_pcb";

const mtimeOf = (file: OrderFile | undefined): number | null => {
  const parsed = Date.parse(file?.mtime ?? "");
  return Number.isFinite(parsed) ? parsed : null;
};

const latestMtime = (files: readonly OrderFile[], match: (path: string) => boolean): number =>
  Math.max(0, ...files.filter((f) => match(f.path)).map((f) => mtimeOf(f) ?? 0));

function drcStatus(files: readonly OrderFile[], evidence: OrderCheckEvidence): OrderCheckStatus {
  const report = evidence.drc;
  const reportMtime = mtimeOf(files.find((f) => f.path === DRC_REPORT));
  if (!report || reportMtime === null) return "missing";
  const checked = report.pcbRevision?.sha256;
  if (typeof checked === "string" && evidence.currentPcbSha256 !== null) {
    // verify_drc binds the report to the exact board bytes; prefer that over timestamps.
    if (checked !== evidence.currentPcbSha256) return "stale";
  } else if (
    reportMtime <
    latestMtime(files, (path) => path.endsWith(".kicad_pcb") || path === "circuit.routed.json")
  ) {
    return "stale";
  }
  try {
    return gate(report, undefined, [...evidence.allowedDrcWarnings]).pass ? "pass" : "fail";
  } catch {
    return "missing";
  }
}

function ercStatus(files: readonly OrderFile[], evidence: OrderCheckEvidence): OrderCheckStatus {
  const report = evidence.erc;
  const reportMtime = mtimeOf(files.find((f) => f.path === ERC_REPORT));
  if (!report || reportMtime === null) return "missing";
  if (report.measurement?.revisionStable === false) return "stale";
  if (reportMtime < latestMtime(files, (path) => path.endsWith(".kicad_sch"))) return "stale";
  const errors: unknown = report.counts?.errors;
  if (typeof errors !== "number") return "missing";
  return errors === 0 ? "pass" : "fail";
}

const CHECK_REASONS: Record<"drc" | "erc", Partial<Record<OrderCheckStatus, string>>> = {
  drc: {
    missing: "Run DRC on the current board before ordering.",
    stale: "The DRC report is older than the current board. Run DRC again.",
    fail: "The current board fails the DRC release gate. Open DRC/ERC, fix the violations, and run DRC again.",
  },
  erc: {
    missing: "Run ERC on the current schematic before ordering.",
    stale: "The ERC report is older than the current schematic. Run ERC again.",
    fail: "The current schematic has ERC errors. Open DRC/ERC, fix them, and run ERC again.",
  },
};

export function assessOrderReadiness(
  files: readonly OrderFile[],
  evidence: OrderCheckEvidence,
): OrderReadiness {
  const hasGerbers = files.some((f) => f.path.startsWith("exports/gerbers/") || /gerber/i.test(f.path));
  const hasFabricationZip = files.some((f) => f.path === "exports/fabrication.zip" || (f.path.startsWith("exports/") && f.path.endsWith(".zip")));
  const hasRouted = files.some((f) => f.path === "circuit.routed.json");
  const hasKicadPcb = files.some((f) => f.path.endsWith(".kicad_pcb"));
  const hasKicadSch = files.some((f) => f.path.endsWith(".kicad_sch"));
  const hasOrderArtifact = hasGerbers || hasFabricationZip || hasKicadPcb || hasRouted;
  const checks: OrderReadiness["checks"] = {
    drc: hasKicadPcb || hasRouted ? drcStatus(files, evidence) : "not_required",
    erc: hasKicadSch ? ercStatus(files, evidence) : "not_required",
  };
  const reasons: string[] = [];
  if (!hasOrderArtifact) {
    reasons.push("Add a routed board or KiCad PCB, then export gerbers before ordering.");
  } else if (!hasGerbers && !hasFabricationZip) {
    reasons.push("Export gerbers or a fabrication zip to send to a fab house.");
  }
  for (const key of ["drc", "erc"] as const) {
    const reason = CHECK_REASONS[key][checks[key]];
    if (reason) reasons.push(reason);
  }
  const checksPass = [checks.drc, checks.erc].every((s) => s === "pass" || s === "not_required");
  return {
    ready: hasOrderArtifact && checksPass,
    hasGerbers,
    hasFabricationZip,
    hasRouted,
    hasKicadPcb,
    checks,
    reasons,
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Loads the release gate's saved DRC/ERC evidence for `assessOrderReadiness`. */
export async function loadOrderCheckEvidence(
  projectDir: string,
  allowedDrcWarnings: readonly string[],
): Promise<OrderCheckEvidence> {
  const [drc, erc, board] = await Promise.all([
    readJson<OrderCheckEvidence["drc"]>(join(projectDir, DRC_REPORT)),
    readJson<OrderCheckEvidence["erc"]>(join(projectDir, ERC_REPORT)),
    readFile(join(projectDir, BOARD_PCB)).catch(() => null),
  ]);
  return {
    allowedDrcWarnings,
    drc,
    erc,
    currentPcbSha256: board ? createHash("sha256").update(board).digest("hex") : null,
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
