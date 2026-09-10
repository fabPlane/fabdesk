// ported from fabplane packages/pcb/src/kicad-cli.ts; replace with @pcb/pcb/kicad-cli once it lands on fabplane main
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type KicadCli = { path: string; version: string };

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Resolve with the exit code instead of throwing on a non-zero exit. */
  tolerateExit?: boolean;
}

/**
 * Roots that may contain a FabPlane-bundled KiCad tree.
 * Packaged layout: `<resources>/kicad/` next to `<resources>/core/fabdesk-core`.
 * Override the resources dir with `FABDESK_RESOURCES`, or the kicad tree with `FABDESK_BUNDLED_KICAD`.
 */
export function bundledKicadRoots(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string[] {
  const roots: string[] = [];
  const push = (p: string | undefined) => {
    if (p && p.length > 0) roots.push(p);
  };
  push(env["FABDESK_BUNDLED_KICAD"]);
  const resources = env["FABDESK_RESOURCES"];
  if (resources) push(join(resources, "kicad"));
  // Packaged core lives at <resources>/core/fabdesk-core[.exe] → sibling ../kicad
  push(join(dirname(execPath), "..", "kicad"));
  // Dev / stage-kicad-bundle output next to the core dist or cwd
  push(join(dirname(execPath), "kicad"));
  return roots;
}

/** Candidate `kicad-cli` paths inside a bundled (or staged) FabPlane KiCad tree. */
export function bundledKicadCliCandidates(roots: string[] = bundledKicadRoots()): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (process.platform === "darwin") {
      out.push(
        // Nightly TensorFleet/kicad archive layout (flattened `kicad-cli/` tree).
        join(root, "kicad-cli"),
        join(root, "KiCad.app", "Contents", "MacOS", "kicad-cli"),
        join(root, "Contents", "MacOS", "kicad-cli"),
        join(root, "bin", "kicad-cli"),
      );
    } else if (process.platform === "win32") {
      out.push(join(root, "bin", "kicad-cli.exe"), join(root, "kicad-cli.exe"));
    } else {
      out.push(join(root, "kicad-cli"), join(root, "bin", "kicad-cli"));
    }
  }
  return out;
}

function knownLocations(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        // FabPlane-branded standalone installs (optional override of the in-app bundle).
        "/Applications/FabPlane KiCad/KiCad.app/Contents/MacOS/kicad-cli",
        join(homedir(), "Applications/FabPlane KiCad/KiCad.app/Contents/MacOS/kicad-cli"),
        "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
        join(homedir(), "Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"),
      ];
    case "win32": {
      // Per-machine installs, then the per-user installs winget and the "current user" installer write.
      const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
      return ["10.0", "9.0"].flatMap((v) => [
        join(local, "Programs", "FabPlane", "KiCad", v, "bin", "kicad-cli.exe"),
        `C:\\Program Files\\KiCad\\${v}\\bin\\kicad-cli.exe`,
        join(local, "Programs", "KiCad", v, "bin", "kicad-cli.exe"),
      ]);
    }
    default:
      return [
        "/opt/fabplane/kicad/bin/kicad-cli",
        "/usr/bin/kicad-cli",
        "/usr/local/bin/kicad-cli",
        "/usr/lib/kicad/bin/kicad-cli",
        "/usr/lib/kicad-nightly/bin/kicad-cli",
        "/opt/kicad/bin/kicad-cli",
        "/snap/bin/kicad.kicad-cli",
        join(homedir(), ".local/bin/kicad-cli"),
      ];
  }
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Locates a usable `kicad-cli`.
 * Order: explicit argument (Settings.kicadCliPath), `$KICAD_CLI`, the FabPlane-bundled tree,
 * `PATH`, `extraLocations`, then stock / standalone install paths.
 * Each candidate is validated by running `version`.
 */
export async function findKicadCli(explicit?: string, opts: { extraLocations?: string[] } = {}): Promise<KicadCli | null> {
  const candidates = [
    explicit,
    process.env.KICAD_CLI,
    ...bundledKicadCliCandidates(),
    Bun.which("kicad-cli"),
    ...(process.platform === "win32" ? [Bun.which("kicad-cli.exe")] : []),
    ...(opts.extraLocations ?? []),
    ...knownLocations(),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!isFile(path)) continue;
    try {
      const result = await runKicadCli({ path, version: "" }, ["version"], { tolerateExit: true });
      const version = result.stdout.trim().split("\n")[0]?.trim() ?? "";
      if (result.exitCode === 0 && version) return { path, version };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const NOISE = [
  // macOS builds print a harmless NSCocoa error for every overwritten output file.
  "Error retrieving source file attributes",
  // Homebrew fontconfig on macOS complains about its own config.
  "Fontconfig warning:",
];

/** Runs kicad-cli with `args`, filtering platform noise from stderr. Throws on non-zero exit unless `tolerateExit`. */
export async function runKicadCli(cli: KicadCli, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  opts.signal?.throwIfAborted();
  const proc = Bun.spawn([cli.path, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  const onAbort = () => proc.kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, rawStderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const stderr = rawStderr
      .split("\n")
      .filter((line) => !NOISE.some((n) => line.includes(n)))
      .join("\n");
    if (opts.signal?.aborted) throw new Error(`kicad-cli ${args.slice(0, 3).join(" ")} aborted`);
    if (exitCode !== 0 && !opts.tolerateExit) {
      throw new Error(`kicad-cli ${args.slice(0, 3).join(" ")} failed (${exitCode}): ${lastLines(stderr || stdout)}`);
    }
    return { stdout, stderr, exitCode };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export function lastLines(text: string, count = 5): string {
  return text.trim().split("\n").slice(-count).join(" | ");
}

/** Counts copper layers declared in the board file header. */
export function countCopperLayers(boardText: string): number {
  const start = boardText.indexOf("(layers");
  if (start === -1) return 0;
  // The layer block ends at the first line that closes back to the board level.
  const block = boardText.slice(start, start + 6000);
  const matches = block.match(/\(\d+\s+"(?:F|B|In\d+)\.Cu"/g);
  return matches ? matches.length : 0;
}
