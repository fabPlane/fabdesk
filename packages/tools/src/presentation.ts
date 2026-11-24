/** Source binding reused from the panel work. Exports never adopt or rename native repository files. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { parseNativeSchematic } from "@fabdesk/kicad";
import { z } from "zod/v4";
import { jailPath, writeAtomic } from "./fs";
import { ToolError, type ToolContext } from "./registry";
export type NativeViewKind = "pcb" | "schematic" | "3d";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const Binding = z.object({
  source: z.string().max(1024),
  artifactSha256: sha,
  inputs: z.record(z.string(), sha.nullable()).refine((v) => Object.keys(v).length <= 128),
  renderer: z.string().optional(),
  warnings: z.array(z.string()).max(10).optional(),
});

export async function presentationBinding(root: string, path: string, artifactSha256: string) {
  try {
    if (!path.startsWith("renders/presented/")) return { status: "unknown" as const };
    const receipt = await jailPath(root, `${path}.binding.json`);
    if ((await stat(receipt)).size > 200_000) return { status: "unknown" as const };
    const binding = Binding.parse(JSON.parse(await readFile(receipt, "utf8")));
    if (binding.artifactSha256 !== artifactSha256 || !binding.inputs[binding.source])
      return { status: "unknown" as const };
    let current = true;
    for (const [path, expected] of Object.entries(binding.inputs)) {
      let actual: string | null;
      try {
        const file = await jailPath(root, path);
        if ((await stat(file)).size > 32 * 1024 * 1024) return { status: "unknown" as const };
        actual = digest(await readFile(file));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        actual = null;
      }
      if (actual !== expected) current = false;
    }
    return {
      ...binding,
      status: current ? ("current" as const) : ("stale" as const),
      checkedAt: new Date().toISOString(),
      dependencies:
        "native documents, reachable sheets and project/rules; external assets unverified",
    };
  } catch {
    return { status: "unknown" as const };
  }
}
export function summarizePresentationBinding(
  binding: Awaited<ReturnType<typeof presentationBinding>>,
) {
  if (!("inputs" in binding)) return binding;
  const { inputs, ...summary } = binding;
  return {
    ...summary,
    sourceSha256: inputs[binding.source],
    sourceRevision: digest(JSON.stringify(inputs)),
    inputCount: Object.keys(inputs).length,
  };
}

/** All existing views share one revision, including changes confined to another schematic sheet. */
export async function captureNativeDesign(root: string, path: string) {
  if (!/\.kicad_(pcb|sch|pro)$/i.test(path))
    throw new ToolError("Choose a native KiCad project, PCB or schematic source", "invalid_args");
  await jailPath(root, path);
  const files = new Map<string, Buffer>(),
    inputs: Record<string, string | null> = {};
  let bytes = 0;
  const capture = async (
    relative: string,
    optional = false,
    ancestors = new Set<string>(),
  ): Promise<void> => {
    if (ancestors.has(relative)) throw new ToolError("Cyclic schematic hierarchy", "invalid_args");
    if (relative in inputs) return;
    if (Object.keys(inputs).length >= 128)
      throw new ToolError("Native design exceeds 128 files", "invalid_args");
    let content: Buffer;
    try {
      const source = await jailPath(root, relative);
      if ((await stat(source)).size > 32 * 1024 * 1024)
        throw new Error("Native file exceeds 32 MiB");
      content = await readFile(source);
    } catch (e) {
      if (optional && (e as NodeJS.ErrnoException).code === "ENOENT") {
        inputs[relative] = null;
        return;
      }
      throw e;
    }
    bytes += content.length;
    if (bytes > 32 * 1024 * 1024)
      throw new ToolError("Native design exceeds 32 MiB", "invalid_args");
    inputs[relative] = digest(content);
    files.set(relative, content);
    if (/\.kicad_sch$/i.test(relative))
      for (const sheet of parseNativeSchematic(content.toString("utf8")).sheets) {
        if (isAbsolute(sheet.filename) || /[$\\]/.test(sheet.filename))
          throw new ToolError("Unsupported schematic sheet path", "invalid_args");
        await capture(
          normalize(join(dirname(relative), sheet.filename)),
          false,
          new Set([...ancestors, relative]),
        );
      }
  };
  const stem = path.replace(/\.kicad_(pcb|sch|pro)$/i, "");
  const board = /\.kicad_pcb$/i.test(path) ? path : `${stem}.kicad_pcb`;
  const schematic = /\.kicad_sch$/i.test(path) ? path : `${stem}.kicad_sch`;
  const projectFile = /\.kicad_pro$/i.test(path) ? path : `${stem}.kicad_pro`;
  await capture(path);
  await capture(board, true);
  await capture(schematic, true);
  await capture(projectFile, true);
  await capture(`${stem}.kicad_dru`, true);
  if (files.has(board) && !/^\s*\(kicad_pcb[\s)]/.test(files.get(board)!.toString("utf8")))
    throw new ToolError("Not a native KiCad PCB", "invalid_args");
  const settings = files.get(projectFile);
  if (settings && files.has(schematic))
    for (const sheet of JSON.parse(settings.toString("utf8"))?.schematic?.top_level_sheets ?? []) {
      if (
        typeof sheet.filename !== "string" ||
        isAbsolute(sheet.filename) ||
        /[$\\]/.test(sheet.filename)
      )
        throw new ToolError("Unsupported project sheet path", "invalid_args");
      await capture(normalize(join(dirname(projectFile), sheet.filename)));
    }
  if (!files.has(board) && !files.has(schematic))
    throw new ToolError("No native PCB or schematic accompanies this project", "precondition");
  return {
    files,
    inputs,
    stem,
    board: files.has(board) ? board : null,
    schematic: files.has(schematic) ? schematic : null,
    projectFile: files.has(projectFile) ? projectFile : null,
    sourceRevision: digest(JSON.stringify(inputs)),
  };
}

export async function preparePresentation(ctx: ToolContext, path: string, view?: NativeViewKind) {
  ctx.signal.throwIfAborted();
  const project = ctx.requireProject();
  const absolute = await jailPath(project.dir, path);
  if (!(await stat(absolute)).isFile())
    throw new ToolError("Presentation needs a regular file", "invalid_args");
  if ((await stat(absolute)).size > 32 * 1024 * 1024)
    throw new ToolError("Presentation source exceeds 32 MiB", "invalid_args");
  if (!/\.kicad_(pcb|sch|pro)$/i.test(path)) {
    const artifactSha256 = digest(await readFile(absolute));
    return {
      path,
      artifactSha256,
      sourceBinding: await presentationBinding(project.dir, path, artifactSha256),
    };
  }
  const captured = await captureNativeDesign(project.dir, path);
  const kind =
    view ?? (/\.kicad_sch$/i.test(path) ? "schematic" : captured.board ? "pcb" : "schematic");
  const source = kind === "schematic" ? captured.schematic : captured.board;
  if (!source)
    throw new ToolError(
      `This design has no ${kind === "schematic" ? "schematic" : "PCB"} source`,
      "precondition",
    );
  const cli = await ctx.services.kicad.resolveCli();
  if (!cli) throw new ToolError("KiCad is unavailable for this native preview", "unavailable");
  const artifact = `renders/presented/${captured.sourceRevision}/${basename(captured.stem)}${view ? `-${kind}` : ""}.${kind === "3d" ? "glb" : "svg"}`;
  const root = await realpath(project.dir),
    output = await jailPath(root, artifact);
  if (output !== resolve(root, artifact))
    throw new ToolError(
      "Preview output path is aliased; original files were preserved",
      "precondition",
    );
  // Reuse an exact verified native revision across tab openings and app restarts.
  // External model assets remain explicitly unverified; cache validity is native-input scope.
  if (view) {
    const info = await stat(output).catch(() => null);
    if (info?.isFile() && info.size <= (kind === "3d" ? 80 : 16) * 1024 * 1024) {
      const artifactSha256 = digest(await readFile(output));
      const sourceBinding = await presentationBinding(project.dir, artifact, artifactSha256);
      const summary = summarizePresentationBinding(sourceBinding);
      if (
        sourceBinding.status === "current" &&
        sourceBinding.renderer === cli.version &&
        "sourceRevision" in summary &&
        summary.sourceRevision === captured.sourceRevision &&
        sourceBinding.source === path
      )
        return { path: artifact, artifactSha256, sourceBinding };
    }
  }
  const scratch = await mkdtemp(join(tmpdir(), "fabdesk-presentation-"));
  try {
    for (const [name, content] of captured.files) {
      const target = await jailPath(scratch, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const snapshot = await jailPath(scratch, source),
      temporary = join(scratch, kind === "3d" ? "output.glb" : "output.svg");
    let rendered: Buffer,
      warnings: string[] = [];
    if (kind === "pcb") {
      await ctx.services.kicad.exportPcbSvg(cli, {
        board: snapshot,
        output: temporary,
        signal: ctx.signal,
      });
      rendered = await readFile(temporary);
    } else if (kind === "3d") {
      const result = await ctx.services.kicad.exportGlb(cli, {
        board: snapshot,
        output: temporary,
        modelProjectDir: dirname(await jailPath(project.dir, source)),
        signal: ctx.signal,
      });
      warnings = result.warnings.slice(0, 10).map((w) => w.slice(0, 300));
      rendered = await readFile(temporary);
    } else {
      const outDir = join(scratch, "svg");
      await mkdir(outDir);
      const result = await ctx.services.kicad.exportSchematicSvg(cli, {
        schematic: snapshot,
        outDir,
        signal: ctx.signal,
      });
      const stem = basename(source).replace(/\.kicad_sch$/i, "");
      const selected =
        result.paths.find((p) => basename(p) === `${stem}.svg`) ??
        (result.paths.length === 1 ? result.paths[0] : undefined);
      if (!selected)
        throw new ToolError(
          "Could not identify the requested schematic's root preview",
          "unavailable",
        );
      rendered = await readFile(selected);
    }
    ctx.signal.throwIfAborted();
    if (rendered.length > (kind === "3d" ? 80 : 16) * 1024 * 1024)
      throw new ToolError("Preview exceeds the viewer size limit", "invalid_args");
    const artifactSha256 = digest(rendered);
    await mkdir(dirname(output), { recursive: true });
    await writeAtomic(output, rendered);
    const receipt = await jailPath(root, `${artifact}.binding.json`);
    if (receipt !== `${output}.binding.json`)
      throw new ToolError("Preview receipt path is aliased", "precondition");
    await writeAtomic(
      receipt,
      JSON.stringify({
        source: path,
        artifactSha256,
        inputs: captured.inputs,
        renderer: cli.version,
        warnings,
      }),
    );
    const sourceBinding = await presentationBinding(project.dir, artifact, artifactSha256);
    if (sourceBinding.status !== "current")
      throw new ToolError(
        "Native source changed while rendering; retry with the current source",
        "precondition",
      );
    return { path: artifact, artifactSha256, sourceBinding };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
