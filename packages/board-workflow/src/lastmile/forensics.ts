/**
 * Router forensics for `why` and `validate` (toolkit bench.py cmd_why / cmd_validate): KiCadRoutingTools'
 * net_forensics names the copper walling each stuck end; TraceMaker classifies every open connection (`causes`),
 * measures pairs (`pairs`) and audits return paths (`return-paths --diff-pairs`). Each engine is optional: what is not
 * installed is reported as such, and the board-model reading in why.ts still answers.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { engineReady, type LayoutHost } from "../layout/ctx";
import { krtPaths } from "../layout/engines";
import { convertTransforms } from "../layout/text";

/** The board as the routers read it: native transforms converted to `(at ...)` poses (toolkit krt_board). */
export async function routerBoard(boardFile: string, workDir: string, stem: string): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const out = join(workDir, `${stem}.kicad_pcb`);
  await writeFile(out, convertTransforms(await readFile(boardFile, "utf8")).text);
  return out;
}

const strip = (s: string) => s.replace(/^\w+::/g, "");

/** Parse net_forensics output into the toolkit's one-line-per-stuck-end text. */
export function forensicsLines(stdout: string): string[] {
  const out: string[] = [];
  let wall: [string, string[]] | null = null;
  const flush = () => {
    if (wall) out.push(`    ${wall[0]}: ` + (wall[1].slice(0, 5).join("; ") || "nothing within reach") + (wall[1].length > 5 ? ` (+${wall[1].length - 5} more)` : ""));
  };
  for (const l of stdout.split("\n")) {
    if (l.startsWith("===")) {
      flush();
      wall = null;
      out.push(strip(l.replace(/^[= ]+|[= ]+$/g, "")));
    } else if (l.startsWith("  GAP")) {
      flush();
      wall = null;
      out.push("  " + l.trim().slice(0, 120));
    } else if (l.startsWith("  WALL")) {
      flush();
      wall = [l.trim().replace(/WALL around island\d+-end /, "end ").split(",  r=")[0]!.split(", r=")[0]!, []];
    } else if (l.startsWith("    ") && wall) {
      const t = l.trim();
      const i = t.indexOf(": ");
      const net = i < 0 ? t : t.slice(0, i);
      const items = i < 0 ? "" : t.slice(i + 2);
      wall[1].push(`${strip(net)} ${items.split(",")[0]}`);
    }
  }
  flush();
  return out;
}

/** KRT net_forensics on `board` (already converted) for `nets`; null when KRT is not configured. */
export async function krtForensics(host: LayoutHost, board: string, nets: string[], radius = 1.0): Promise<string[] | null> {
  if (!nets.length) return null;
  const root = (await engineReady(host, "krt")).path;
  if (!root) return null;
  const k = krtPaths(root);
  const log = join(board + ".forensics.log");
  await host.spawn([...k.python, join(k.plugins, "py_tools", "net_forensics.py"), board, "--nets", ...nets, "--radius", String(radius)], {
    cwd: k.plugins,
    log,
    timeoutMs: 300_000,
    ...(host.signal ? { signal: host.signal } : {}),
  });
  return forensicsLines(await readFile(log, "utf8").catch(() => ""));
}

async function tm(host: LayoutHost, args: string[], log: string, timeoutMs = 300_000): Promise<string | null> {
  if (!host.tools.tracemaker) return null;
  await host.spawn([host.tools.tracemaker, ...args], { log, timeoutMs, ...(host.signal ? { signal: host.signal } : {}) });
  return readFile(log, "utf8").catch(() => "");
}

/** TraceMaker's cause class of every open connection (seconds; no copper changes); the summary tail. */
export async function tmCauses(host: LayoutHost, board: string): Promise<string[] | null> {
  const t = await tm(host, ["causes", board, "--threads", "2"], board + ".causes.log");
  if (t === null) return null;
  const skip = ["searches", "clean-up", "restarts", "failed-search", "late "];
  return t.split("\n").filter((l) => l.trim() && !skip.some((p) => l.startsWith(p))).slice(-6);
}

/** TraceMaker pair report (`pairs --json`) and return-path audit; written beside `board`. */
export async function tmPairAudit(host: LayoutHost, board: string, outDir: string): Promise<{ pairs: string; returnPaths: string; returnPathWarnings: number } | null> {
  if (!host.tools.tracemaker) return null;
  const pairs = (await tm(host, ["pairs", board, "--json", join(outDir, "tm-pairs.json")], join(outDir, "tm-pairs.txt"))) ?? "";
  const returnPaths = (await tm(host, ["return-paths", board, "--diff-pairs"], join(outDir, "tm-return-paths.txt"))) ?? "";
  return { pairs, returnPaths, returnPathWarnings: returnPaths.split("\n").filter((l) => l.trimEnd().endsWith("WARN")).length };
}
