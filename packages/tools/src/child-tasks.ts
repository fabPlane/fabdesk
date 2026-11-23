/**
 * Board computations that run in a child process of the core instead of inside it. On a large board an ECO's impact
 * and apply hold several GiB and minutes of CPU (jetson, 86 MB: impact 3.7 GiB / 151 s, apply over 6.8 GiB before its
 * scoring); inside the daemon that stalled every client and, in the eval, grew the core to 20 GB until the machine ran
 * out of memory. A child has its own heap (freed when it exits), is admitted by the governor on its own estimate, can
 * be killed on cancel, and leaves the daemon's event loop free.
 *
 * Protocol (the core implements `RunChild` by starting itself with the hidden `board-child` subcommand): the input is a
 * JSON file, progress comes back as stdout lines `@@progress {"p":0.5,"n":"note"}`, the result as a JSON file
 * `{ok:true,result}` or `{ok:false,error,name}`. Tasks are named here; add one by adding a case to `runChildTask`.
 */
import { readFile } from "node:fs/promises";
import { runAcceptance, edit } from "@fabdesk/board-workflow";
import { parseDrcJson, runDrc } from "@fabdesk/kicad";

export type ChildTaskName = "edit";

export interface ChildRunOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number, note: string) => void;
}

/** Run a named task in a child process and return its result (rejects with the child's error). */
export type RunChild = (task: ChildTaskName, input: unknown, opts: ChildRunOptions) => Promise<unknown>;

/** An error a child task ended with, carrying the error's class name (`EditStop` is a decision, not a crash). */
export class ChildTaskError extends Error {
  constructor(
    message: string,
    readonly errorName: string,
    /** A `ToolError` code the child's error carried (invalid_args, not_found ...), to rebuild it in the parent. */
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface EditChildInput {
  projectDir: string;
  plan: unknown;
  mode: "impact" | "apply" | "proof";
  pcb?: string;
  candidate?: string;
  /** kicad-cli for the scoring DRC (null for impact, which runs none). */
  kicadCli: string | null;
}

/** DRC as the board tools judge it: project severity, refilled zones, owner-excluded items dropped (tools `runLiveDrc`). */
async function liveDrc(cliPath: string, o: { board: string; outFile: string; parity: boolean }) {
  const report = await runDrc({ path: cliPath, version: "" }, { board: o.board, outFile: o.outFile, severity: "project", schematicParity: o.parity, refillZones: true });
  type Raw = { violations?: Array<{ excluded?: boolean }>; unconnected_items?: Array<{ excluded?: boolean }>; schematic_parity?: Array<{ excluded?: boolean }> };
  const raw = JSON.parse(await readFile(o.outFile, "utf8").catch(() => "null")) as Raw | null;
  if (!raw) return report;
  const live = <T extends { excluded?: boolean }>(l: T[] | undefined) => (l ?? []).filter((v) => !v.excluded);
  return parseDrcJson({ ...raw, violations: live(raw.violations), unconnected_items: live(raw.unconnected_items), schematic_parity: live(raw.schematic_parity) } as never);
}

/** Inside the child: run one task to completion. */
export async function runChildTask(task: string, input: unknown, onProgress: (fraction: number, note: string) => void): Promise<unknown> {
  if (task === "edit") {
    const i = input as EditChildInput;
    const cli = i.kicadCli;
    return edit.runEdit({
      projectDir: i.projectDir,
      plan: i.plan,
      mode: i.mode,
      ...(i.pcb ? { pcb: i.pcb } : {}),
      ...(i.candidate ? { candidate: i.candidate } : {}),
      runners: {
        progress: onProgress,
        accept: (dir, pcb) => {
          if (!cli) throw new Error("kicad-cli is needed to score the board");
          return runAcceptance(dir, {
            pcb,
            parity: true,
            drc: async ({ board, parity, outFile }) => {
              const r = await liveDrc(cli, { board, outFile, parity });
              return { violations: r.violations, unconnected: r.unconnected.length, parity: r.schematicParity.length };
            },
          });
        },
        // repair (the last-mile bench) runs in the parent between apply and proof
      },
    });
  }
  throw new Error(`unknown child task ${task}`);
}
