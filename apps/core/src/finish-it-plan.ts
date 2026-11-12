/**
 * Pure planner for Finish it: inspect a project directory, decide remaining milestones,
 * write the autonomous agent prompt, and map MCP tools onto those milestones.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  FINISH_IT_MILESTONE_LABELS,
  FINISH_IT_MILESTONES,
  NetlistFile,
  type FinishItMilestone,
  type FinishItMilestoneId,
  type FinishItMilestoneState,
} from "@fabdesk/protocol";
import { acceptanceSatisfied, readAcceptanceState, readDoneMode, readReviewGate, type AcceptanceState, type DoneMode, type ReviewGate } from "@fabdesk/tools";

export type FinishItSnapshot = {
  hasNetlist: boolean;
  netlistComponents: number;
  hasBoard: boolean;
  hasSchematic: boolean;
  routed: boolean;
  routeOpen: number | null;
  drcErrors: number | null;
  drcUnconnected: number | null;
  ercErrors: number | null;
  spiceOk: boolean | null;
  /**
   * The board's own definition of done (A1-A9) when the board workflow is in use on this project; absent
   * otherwise, and the DRC/ERC counts alone decide.
   */
  acceptance?: AcceptanceState;
  /** Strict, or "no new failure" for a board that came in already failing checks (set when the run starts). */
  doneMode?: DoneMode;
  /** The board workflow's review gate for the saved board (present when the board workflow is in use). */
  review?: ReviewGate;
};

export type FinishItRouteHint = {
  status: string;
  open: number | null;
  /** Only completed+applied routes count; manual/stale/failed candidates do not. */
  applied?: boolean;
  /** sha256 of the PCB after apply; must match the live board when set. */
  pcbRevision?: string | null;
};

const ROUTED_STATUSES = new Set(["completed", "done"]);

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function mtimeMs(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null);
  return info?.mtimeMs ?? null;
}

async function newestMtime(paths: string[]): Promise<number | null> {
  let max: number | null = null;
  for (const path of paths) {
    const t = await mtimeMs(path);
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max;
}

function laterOf(...times: Array<number | null>): number | null {
  let max: number | null = null;
  for (const t of times) {
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max;
}

async function schematicPaths(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".kicad_sch")).map((name) => join(dir, name));
}

/** Ignore a report that is older than the board it describes. */
async function readFreshJson(path: string, sourceMtime: number | null): Promise<unknown | null> {
  const raw = await readJson(path);
  if (raw === null) return null;
  if (sourceMtime === null) return raw;
  const reportMtime = await mtimeMs(path);
  if (reportMtime === null || reportMtime < sourceMtime) return null;
  return raw;
}

function countsOf(value: unknown): { errors?: number; unconnected?: number } | null {
  if (!value || typeof value !== "object") return null;
  const counts = (value as { counts?: unknown }).counts;
  if (!counts || typeof counts !== "object") return null;
  const rec = counts as { errors?: unknown; unconnected?: unknown };
  return {
    ...(typeof rec.errors === "number" ? { errors: rec.errors } : {}),
    ...(typeof rec.unconnected === "number" ? { unconnected: rec.unconnected } : {}),
  };
}

function spicePassed(value: unknown): boolean | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { ok?: unknown; error?: unknown };
  if (rec.ok === true) return true;
  if (rec.ok === false || typeof rec.error === "string") return false;
  return null;
}

function routeFilePassed(value: unknown): { routed: boolean; open: number | null } | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as {
    ok?: unknown;
    open?: unknown;
    status?: unknown;
    application?: { state?: unknown };
    applied?: unknown;
  };
  const open = typeof rec.open === "number" ? rec.open : null;
  if (rec.application && rec.application.state !== "applied") return { routed: false, open };
  if (rec.applied === false) return { routed: false, open };
  if (rec.ok === true || ROUTED_STATUSES.has(String(rec.status ?? "")))
    return { routed: open === null || open === 0, open };
  if (rec.ok === false) return { routed: false, open };
  return null;
}

export async function inspectProject(
  dir: string,
  extras: { lastRoute?: FinishItRouteHint | null; boardChecks?: boolean } = {},
): Promise<FinishItSnapshot> {
  const netlistRaw = await readJson(join(dir, "circuit.netlist.json"));
  const parsed = netlistRaw === null ? null : NetlistFile.safeParse(netlistRaw);
  const netlist = parsed?.success ? parsed.data : null;

  const boardPath = join(dir, "board.kicad_pcb");
  const netlistPath = join(dir, "circuit.netlist.json");
  const board = await readFile(boardPath, "utf8").catch(() => null);
  const schematicFiles = await schematicPaths(dir);
  const schematic = schematicFiles.length > 0;
  const boardMtime = board ? await mtimeMs(boardPath) : null;
  const netlistMtime = await mtimeMs(netlistPath);
  const schematicMtime = await newestMtime(schematicFiles);
  // Git checkout writes files in index order (`board.kicad_pcb` before
  // `circuit.netlist.json`), so the netlist can be a few ms newer on a
  // finished clone. Treat sub-second / low-second skew as the same generation.
  const CHECKOUT_MTIME_SLACK_MS = 2_000;
  const boardCurrent =
    board !== null &&
    board.length > 0 &&
    (netlistMtime === null ||
      boardMtime === null ||
      boardMtime + CHECKOUT_MTIME_SLACK_MS >= netlistMtime);
  const reportSource = laterOf(boardMtime, netlistMtime);
  const ercSource = laterOf(schematicMtime, boardMtime);
  const boardHash = board !== null ? createHash("sha256").update(board).digest("hex") : null;
  const drcReport = await readFreshJson(join(dir, "reports", "drc.json"), reportSource);
  const drcEvidence = drcReport as {
    pcbRevision?: { sha256?: string };
    schematicParityChecked?: boolean;
  } | null;
  const drcMatchesBoard = drcEvidence?.pcbRevision?.sha256 === boardHash && boardHash !== null;
  // Legacy reports use timestamps; revision-bearing reports must describe this exact PCB.
  const drc = drcEvidence?.pcbRevision?.sha256 && !drcMatchesBoard ? null : countsOf(drcReport);
  const erc = countsOf(await readFreshJson(join(dir, "reports", "erc.json"), ercSource));
  const spice = spicePassed(await readFreshJson(join(dir, "reports", "spice.json"), reportSource));
  const routeFile = routeFilePassed(await readFreshJson(join(dir, "reports", "route.json"), reportSource));

  const lastRoute = extras.lastRoute;
  const routeApplied =
    lastRoute?.applied === true &&
    (lastRoute.pcbRevision == null || lastRoute.pcbRevision === boardHash);
  const routeFromStore =
    lastRoute && ROUTED_STATUSES.has(lastRoute.status) && routeApplied
      ? { routed: lastRoute.open === 0, open: lastRoute.open }
      : null;
  // Cleanup can change the PCB hash after routing. A parity-aware connectivity check
  // on the final revision proves routing without applying the router a second time.
  const connectivityVerified = boardCurrent && drcMatchesBoard &&
    drcEvidence?.schematicParityChecked === true && drc?.errors === 0 && drc.unconnected === 0;
  const routed = connectivityVerified || routeFromStore?.routed === true || routeFile?.routed === true;
  const routeOpen = connectivityVerified ? 0 : routeFromStore?.open ?? routeFile?.open ?? null;

  return {
    hasNetlist: netlist !== null,
    netlistComponents: netlist?.netlist.components.length ?? 0,
    hasBoard: boardCurrent,
    hasSchematic: schematic,
    routed,
    routeOpen,
    drcErrors: drc?.errors ?? null,
    drcUnconnected: drc?.unconnected ?? null,
    ercErrors: erc?.errors ?? null,
    spiceOk: spice,
    ...(extras.boardChecks ? { acceptance: await readAcceptanceState(dir), doneMode: await readDoneMode(dir), review: await readReviewGate(dir) } : {}),
  };
}

/** Acceptance results are keyed `A1_connectivity`, `A2_drc`, ...: match a check by its code. */
const hasCheck = (list: string[], code: string) => list.some((k) => k === code || k.startsWith(`${code}_`));

export function milestoneDone(id: FinishItMilestoneId, snap: FinishItSnapshot): boolean {
  switch (id) {
    case "schematic":
      return snap.hasNetlist && snap.netlistComponents > 0;
    case "build":
      return snap.hasBoard;
    case "route": {
      // a measured A1 (connectivity) on this exact board outranks an earlier route report; a board that came in with
      // opens is judged by no new failure (they were there before the work)
      const a = snap.acceptance;
      if (a?.state === "current" && hasCheck(a.failing, "A1")) return snap.doneMode === "no-regression" && !hasCheck(a.regressions, "A1");
      return snap.routed && (snap.routeOpen === null || snap.routeOpen === 0);
    }
    case "review":
      // every finding settled on the saved board; a board change since the last review makes it stale
      return snap.review?.state === "pass";
    case "verify":
      // with the board workflow in use, done means A1-A9 pass on the saved board, not only DRC/ERC counts
      if (snap.acceptance && !acceptanceSatisfied(snap.acceptance, snap.doneMode ?? "strict")) return false;
      // no new failure: the board's own pre-existing DRC/ERC findings are judged by A1-A9, not by raw counts of zero
      if (snap.acceptance && snap.doneMode === "no-regression") return true;
      return (
        snap.drcErrors === 0 &&
        (snap.drcUnconnected === null || snap.drcUnconnected === 0) &&
        (snap.hasSchematic ? snap.ercErrors === 0 : true)
      );
  }
}

export function planMilestones(snap: FinishItSnapshot): FinishItMilestone[] {
  // the review milestone exists only where the board workflow can run one
  return FINISH_IT_MILESTONES.filter((id) => id !== "review" || snap.review !== undefined).map((id) => {
    const done = milestoneDone(id, snap);
    const status: FinishItMilestoneState = done ? "skipped" : "pending";
    return {
      id,
      label: FINISH_IT_MILESTONE_LABELS[id],
      status,
      ...(done ? { note: "Already complete" } : {}),
    };
  });
}

/** Everything not yet done or skipped, including a milestone the agent is still working on. */
export function remainingMilestones(milestones: FinishItMilestone[]): FinishItMilestoneId[] {
  return milestones.filter((m) => m.status !== "done" && m.status !== "skipped").map((m) => m.id);
}

export function progressFraction(milestones: FinishItMilestone[]): number {
  if (milestones.length === 0) return 1;
  const done = milestones.filter((m) => m.status === "done" || m.status === "skipped").length;
  return done / milestones.length;
}

export function milestoneForTool(name: string): FinishItMilestoneId | null {
  const bare = name.replace(/^mcp__[^_]+__/, "");
  switch (bare) {
    case "circuit_build":
      return "build";
    case "route_run":
    case "route_status":
    case "route_unroute":
    case "board_route":
    case "board_edit":
      return "route";
    case "board_check":
    case "board_release":
      return "verify";
    case "board_review":
      return "review";
    case "verify_drc":
    case "verify_erc":
    case "verify_gate":
    case "sim_run":
    case "sim_spice_netlist":
      return "verify";
    default:
      return null;
  }
}

export function snapshotNote(id: FinishItMilestoneId, snap: FinishItSnapshot): string {
  switch (id) {
    case "schematic":
      return snap.hasNetlist
        ? `Netlist has ${snap.netlistComponents} component${snap.netlistComponents === 1 ? "" : "s"}`
        : "No circuit.netlist.json yet";
    case "build":
      return snap.hasBoard ? "board.kicad_pcb is present" : "Board not built";
    case "route":
      if (snap.routed && (snap.routeOpen === null || snap.routeOpen === 0)) return "Routing closed";
      if (snap.routeOpen !== null) return `${snap.routeOpen} open connection${snap.routeOpen === 1 ? "" : "s"}`;
      return "Not routed";
    case "review": {
      const r = snap.review;
      if (!r || r.state === "none") return "Review not run";
      if (r.state === "pass") return "Review gate passes: every finding settled";
      if (r.state === "stale") return "Review is stale (the board changed since)";
      if (r.state === "errors") return "Review has check errors";
      return `${r.open ?? "?"} finding${r.open === 1 ? "" : "s"} open (${r.mustFix ?? 0} must-fix)`;
    }
    case "verify": {
      const parts: string[] = [];
      parts.push(
        snap.drcErrors === null
          ? "DRC not run"
          : `DRC ${snap.drcErrors} error${snap.drcErrors === 1 ? "" : "s"}`,
      );
      if (snap.drcUnconnected !== null) parts.push(`${snap.drcUnconnected} unconnected`);
      if (snap.hasSchematic)
        parts.push(
          snap.ercErrors === null
            ? "ERC not run"
            : `ERC ${snap.ercErrors} error${snap.ercErrors === 1 ? "" : "s"}`,
        );
      if (snap.acceptance)
        parts.push(
          snap.acceptance.state === "none"
            ? "A1-A9 not measured"
            : snap.acceptance.state === "stale"
              ? "A1-A9 stale (board changed)"
              : snap.acceptance.pass
                ? "A1-A9 pass"
                : `A1-A9 failing ${snap.acceptance.failing.join(", ")}${
                    snap.doneMode === "no-regression"
                      ? snap.acceptance.regressions.length
                        ? `; new: ${snap.acceptance.regressions.join(", ")}`
                        : " (all were failing before the work: no new failure)"
                      : ""
                  }`,
        );
      if (snap.spiceOk === true) parts.push("SPICE ok");
      else if (snap.spiceOk === false) parts.push("SPICE failed");
      return parts.join(", ");
    }
  }
}

/**
 * Stage tools are named for what later board-workflow stages register in the `board` toolset (board_check, board_edit,
 * board_route, board_review, board_release); milestoneForTool already maps them, and a name that is not registered is
 * simply never called.
 */
const BOARD_METHOD = `Board workflow (load_toolset {"toolset":"board"}): board_check measures A1-A9 on the saved board and says where it stands.
An edit makes the review stale; long jobs return a job id (board_job waits for, reports or cancels them).
Many opens after routing usually mean a placement problem: restructure the block or re-seed before tuning the router. Look at the board (render_view) before deciding.`;

/** Prompt the existing agent to finish remaining work without asking the user. */
export function finishItPrompt(input: {
  projectName: string;
  snapshot: FinishItSnapshot;
  remaining: FinishItMilestoneId[];
  followUp?: boolean;
}, opts: { boardChecks?: boolean } = {}): string {
  const remaining = input.remaining
    .map((id) => `- ${FINISH_IT_MILESTONE_LABELS[id]} (${id})`)
    .join("\n");
  const status = [
    `Netlist: ${input.snapshot.hasNetlist ? `${input.snapshot.netlistComponents} components` : "missing"}`,
    `Board: ${input.snapshot.hasBoard ? "board.kicad_pcb present" : "not built"}`,
    `Schematic: ${input.snapshot.hasSchematic ? "board.kicad_sch present" : "absent"}`,
    `Route: ${snapshotNote("route", input.snapshot)}`,
    `Verify: ${snapshotNote("verify", input.snapshot)}`,
  ].join("\n");
  const header = input.followUp
    ? "Continue the Finish it run. Do not stop to ask questions. Finish the remaining work."
    : "Finish it mode: take this partially done fabPlane project all the way to a manufacturable board. Do not ask the user step-by-step questions. Work autonomously with the fabPlane MCP tools.";
  return `${header}

Project: ${input.projectName}

Current state:
${status}

Remaining milestones (in order):
${remaining || "- none — confirm verify reports are clean and stop"}

How to finish each milestone:
1. schematic — write or complete circuit.netlist.json (real parts and nets). Use library search tools when you need footprints.
2. build — run circuit_build so board.kicad_pcb exists with placed footprints.
3. route — run route_run and keep going until open connections are 0. Unroute and retry a net if needed.
4. verify — ${opts.boardChecks ? "run board_check: done means A1-A9 pass on the saved board with schematic parity (a board that came in already failing checks is judged by no new failure against its first result; name each pre-existing failure). Also run " : "run "}verify_erc (if a schematic exists), verify_drc, and sim_run when the design can be simulated. Fix violations and re-run until DRC errors and unconnected items are 0 (and ERC errors are 0 when a schematic exists). SPICE is best-effort: run it, but a missing simulator is not a reason to stop.
${opts.boardChecks ? "5. review — run the review checks (board_check), then settle what they leave: dispose each finding with evidence or fix it. Done when the review gate passes. A finding only the owner can decide (spending money, changing a hard constraint) is reported, not decided: stop and list it.\n" : ""}
${opts.boardChecks ? BOARD_METHOD + "\n\n" : ""}Rules:
- Use the fabPlane MCP tools. Do not invent a parallel workflow.
- Do not wait for another user message. Keep going until the remaining milestones are done or you are blocked by a missing tool/runtime.
- Prefer fixing the design over declaring victory with open DRC/ERC errors.
- When finished, reply with a short status of each milestone.`;
}
