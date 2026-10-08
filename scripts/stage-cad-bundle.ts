#!/usr/bin/env bun
/** Assemble the exact native engine, compiled bridge and production viewer. Never use the mock. */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface NativeCadRuntime {
  format: 1;
  target: string;
  freecadCommit: string;
  apiServer: string;
  pythonHome?: string;
  environmentPaths?: Record<string, string>;
}

export function validateRuntime(m: NativeCadRuntime, target: string, commit: string): void {
  if (m.format !== 1 || m.target !== target || m.freecadCommit !== commit)
    throw new Error(`native CAD runtime must match ${target} and FreeCAD ${commit}`);
  if (!m.apiServer || /mock/i.test(m.apiServer))
    throw new Error("a real FreeCADApiServer is required");
  for (const p of [m.apiServer, m.pythonHome, ...Object.values(m.environmentPaths ?? {})]) {
    if (p && (p.startsWith("/") || p.includes("\\") || p.split("/").includes("..")))
      throw new Error(`runtime path must stay within the engine bundle: ${p}`);
  }
}

async function noSourceMaps(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await noSourceMaps(p);
    else if (e.name.endsWith(".map")) throw new Error(`source map must not ship: ${p}`);
  }
}

function run(args: string[], cwd: string): void {
  const p = Bun.spawnSync(args, { cwd, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`${args[0]} failed (${p.exitCode})`);
}

export async function stageCad(runtime: string, target: string): Promise<string> {
  const root = resolve(import.meta.dir, "..");
  const commit = (
    await readFile(join(root, "vendor/fab_cad/packages/protocol/FREECAD_COMMIT"), "utf8")
  ).trim();
  const m = JSON.parse(await readFile(join(runtime, "runtime.json"), "utf8")) as NativeCadRuntime;
  validateRuntime(m, target, commit);
  for (const p of [m.apiServer, "licenses/NOTICE.txt", "sources/FreeCAD.tar.gz"])
    if (!existsSync(join(runtime, p))) throw new Error(`native CAD runtime is incomplete: ${p}`);
  const output = join(root, "dist/cad", target);
  const temp = await mkdtemp(join(tmpdir(), "fabdesk-cad-build-"));
  try {
    // Build the pinned web workspace in a disposable checkout, never install into vendor/.
    run(
      [
        "git",
        "clone",
        "--shared",
        "--no-checkout",
        join(root, "vendor/fab_cad"),
        join(temp, "cad"),
      ],
      root,
    );
    const cad = join(temp, "cad");
    const pin = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: join(root, "vendor/fab_cad"),
    }).stdout;
    run(["git", "checkout", new TextDecoder().decode(pin).trim()], cad);
    run([process.execPath, "install", "--frozen-lockfile"], cad);
    run([process.execPath, "run", "--cwd", "apps/web", "build", "--sourcemap", "false"], cad);
    await noSourceMaps(join(cad, "apps/web/dist"));
    await rm(output, { recursive: true, force: true });
    await mkdir(join(output, "bin"), { recursive: true });
    await cp(runtime, join(output, "freecad"), { recursive: true, verbatimSymlinks: true });
    await cp(join(cad, "apps/web/dist"), join(output, "web"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    const suffix = target.startsWith("windows-") ? ".exe" : "";
    run(
      [
        process.execPath,
        "build",
        "--compile",
        `--target=bun-${target}`,
        "packages/bridge/src/main.ts",
        "--outfile",
        join(output, "bin", `fab-cad-bridge${suffix}`),
      ],
      cad,
    );
    await writeFile(
      join(output, "bundle.json"),
      JSON.stringify(
        {
          format: 1,
          target,
          engine: "native",
          freecadCommit: commit,
          fabCadCommit: new TextDecoder().decode(pin).trim(),
          bridge: `bin/fab-cad-bridge${suffix}`,
          freecadApiServer: `freecad/${m.apiServer}`,
          web: "web",
          libraryPaths: ["freecad/lib"],
          ...(m.pythonHome ? { pythonHome: `freecad/${m.pythonHome}` } : {}),
          environmentPaths: Object.fromEntries(
            Object.entries(m.environmentPaths ?? {}).map(([k, v]) => [k, `freecad/${v}`]),
          ),
        },
        null,
        2,
      ) + "\n",
    );
    return output;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const option = (name: string) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  const runtime = option("--from") ?? process.env["FABDESK_FREECAD_RUNTIME"];
  const target = (option("--target") ?? `bun-${process.platform}-${process.arch}`)
    .replace(/^bun-/, "")
    .replace(/^win32-/, "windows-");
  if (!runtime)
    throw new Error(
      `No native FreeCAD runtime for ${target}. Build the pinned fork first; mock fallback is forbidden.`,
    );
  console.log(await stageCad(resolve(runtime), target));
}
