import { project_checkpoint } from "./task-checkpoint";
/** Project toolset: files, sketches and board settings. All paths are jailed under the project dir. */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod/v4";
import { PROJECT_FILES, jailPath, projectRelative, writeAtomic } from "../fs";
import { ToolError, defineTool } from "../registry";
import { VIAGRID_9055 } from "../templates/viagrid-9055";
import { ok, p, trim } from "./common";
import { partsTools } from "./parts";

const MAX_READ = 512 * 1024;

export const project_read_file = defineTool({
  name: "project_read_file",
  toolset: "project",
  title: "Read a project file",
  description:
    "Read a text file inside the project directory. Paths are relative to the project and may not leave it. Binary files are reported by size only; project_list_sketches returns image content.",
  inputSchema: {
    path: z.string().min(1).describe("Relative path, e.g. circuit.netlist.json"),
    maxChars: z.number().int().min(100).max(200_000).default(50_000),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ path, maxChars }, ctx) => {
    const project = ctx.requireProject();
    const abs = await jailPath(project.dir, path);
    const st = await stat(abs).catch(() => null);
    if (!st) throw new ToolError(`file not found: ${path}`, "not_found");
    if (st.isDirectory()) {
      const entries = await readdir(abs, { withFileTypes: true });
      const listing = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      return ok(`Directory ${path}:\n${listing.join("\n")}`, { path, entries: listing });
    }
    if (st.size > MAX_READ)
      return ok(`${path} is ${st.size} bytes; too large to inline.`, {
        path,
        size: st.size,
        truncated: true,
      });
    const buf = await readFile(abs);
    if (isBinary(buf))
      return ok(`${path} is binary (${st.size} bytes).`, { path, size: st.size, binary: true });
    const content = buf.toString("utf8");
    return ok(trim(content, maxChars), {
      path,
      size: st.size,
      content: content.slice(0, maxChars),
    });
  },
});

export const project_write_file = defineTool({
  name: "project_write_file",
  toolset: "project",
  title: "Write a project file",
  description:
    "Create or overwrite a UTF-8 text file inside the project directory. Paths are relative to the project and may not leave it; fabdesk.json is managed by project_set_board.",
  inputSchema: {
    path: z.string().min(1).describe("Relative path, e.g. circuit.netlist.json"),
    content: z.string().describe("Full file content (UTF-8)"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ path, content }, ctx) => {
    const project = ctx.requireProject();
    const abs = await jailPath(project.dir, path);
    const rel = projectRelative(project.dir, abs);
    if (rel === PROJECT_FILES.manifest)
      throw new ToolError(
        "fabdesk.json is managed by fabdesk; use project_set_board",
        "invalid_args",
      );
    if (rel.startsWith(".fabdesk/"))
      throw new ToolError(".fabdesk/ is managed by fabdesk", "invalid_args");
    await writeAtomic(abs, content);
    return ok(`Wrote ${rel} (${Buffer.byteLength(content)} bytes).`, {
      path: rel,
      bytes: Buffer.byteLength(content),
    });
  },
});

export const project_list_sketches = defineTool({
  name: "project_list_sketches",
  toolset: "project",
  title: "List sketches",
  description:
    "List PNG, JPEG, and SVG files under sketches/ with absolute paths and image content for raster formats.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const dir = p(project, PROJECT_FILES.sketches);
    const names = (await readdir(dir).catch(() => []))
      .filter((f) => /\.(png|jpe?g|svg)$/i.test(f))
      .sort();
    const sketches = await Promise.all(
      names.map(async (name) => {
        const abs = p(project, PROJECT_FILES.sketches, name);
        const st = await stat(abs);
        return {
          name,
          path: abs,
          size: st.size,
          mtime: st.mtime.toISOString(),
          mime: mimeFor(name),
        };
      }),
    );
    const text = sketches.length
      ? `Sketches:\n${sketches.map((s) => `- ${s.path} (${s.size} bytes, ${s.mtime})`).join("\n")}`
      : "No sketches in sketches/.";
    return ok(
      text,
      { sketches },
      {
        images: sketches
          .filter((s) => s.mime !== "image/svg+xml")
          .map((s) => ({ path: s.path, mime: s.mime })),
      },
    );
  },
});

export const project_set_board = defineTool({
  name: "project_set_board",
  toolset: "project",
  title: "Set board settings",
  description:
    'Update fabdesk.json board settings: layer count, outline dimensions, router, and optional prefab blank template. template="viagrid-9055" represents the Opulo 90 x 55 mm blank with its factory vias, mounting holes, and 0.2 mm track and clearance rules; template="none" removes the template.',
  inputSchema: {
    layers: z.number().int().min(1).max(32).optional(),
    widthMm: z.number().positive().optional(),
    heightMm: z.number().positive().optional(),
    router: z
      .enum(["fab_router", "capacity", "freerouting", "tracemaker"])
      .optional()
      .describe(
        "Pin this project to fab_router, Freerouting, or TraceMaker; capacity is a legacy fab_router alias. TraceMaker must be installed (Settings → Routers) before route_run uses it.",
      ),
    template: z
      .enum(["viagrid-9055", "none"])
      .optional()
      .describe("Prefab blank to design on; viagrid-9055 or none"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ layers, widthMm, heightMm, router, template }, ctx) => {
    const project = ctx.requireProject();
    const current = project.manifest();
    const { template: currentTemplate, ...currentBoard } = current.board;
    const templateBoard =
      template === "viagrid-9055"
        ? {
            layers: VIAGRID_9055.layers,
            widthMm: VIAGRID_9055.widthMm,
            heightMm: VIAGRID_9055.heightMm,
            rules: { ...(current.board.rules ?? {}), ...VIAGRID_9055.rules },
            template: "viagrid-9055" as const,
          }
        : template === "none"
          ? {}
          : currentTemplate !== undefined
            ? { template: currentTemplate }
            : {};
    const board = {
      ...currentBoard,
      ...templateBoard,
      ...(layers !== undefined ? { layers } : {}),
      ...(widthMm !== undefined ? { widthMm } : {}),
      ...(heightMm !== undefined ? { heightMm } : {}),
    };
    const normalizedRouter = router === "capacity" ? "fab_router" : router;
    const next = await project.updateManifest({
      board,
      ...(normalizedRouter ? { router: normalizedRouter } : {}),
    });
    const displayedRouter =
      next.router === "capacity"
        ? "fab_router"
        : (next.router ?? "freerouting (default; fab_router fallback)");
    const text = [
      `Board: ${next.board.layers} layers, ${next.board.widthMm ?? "?"}×${next.board.heightMm ?? "?"} mm, router ${displayedRouter}${next.board.template ? `, template ${next.board.template}` : ""}.`,
      ...(next.board.template === "viagrid-9055"
        ? [
            "Viagrid geometry: factory-via-free areas include x in -12..12 and |x| > 26 with |y| < 14; mounting-hole centres are at (±38.75, ±18.25) mm in the blank frame.",
          ]
        : []),
    ].join("\n");
    return ok(text, {
      board: next.board,
      router: next.router === "capacity" ? "fab_router" : (next.router ?? "auto"),
    });
  },
});

export const project_import_kicad = defineTool({
  name: "project_import_kicad",
  toolset: "project",
  title: "Adopt a KiCad board",
  description:
    "Copy an existing .kicad_pcb and adjacent .kicad_pro/.kicad_sch/.kicad_dru files into canonical project paths. Preserves adjacent sheets, rejects conflicting names and unsaved live work. This is native-file adoption, not a complete project-folder import. Also records copper-layer count when kicad-cli is available.",
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe("Absolute path to the .kicad_pcb, or a path relative to the project"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async ({ path }, ctx) => {
    const project = ctx.requireProject();
    const abs = resolve(isAbsolute(path) ? path : await jailPath(project.dir, path));
    if (!(await stat(abs).catch(() => null))?.isFile())
      throw new ToolError(`file not found: ${path}`, "not_found");
    if (!/\.kicad_pcb$/i.test(abs))
      throw new ToolError("path must be a .kicad_pcb", "invalid_args");
    // Resolve the complete plan before writing: an adjacent board.kicad_sch must
    // never overwrite the imported root after product.kicad_sch was renamed.
    const plan = new Map<string, string>();
    const destinations = new Map<string, string>();
    const add = (source: string, destination: string) => {
      // Imported projects must also be safe on case-insensitive macOS/Windows volumes.
      const key = destination.toLowerCase();
      if (destinations.has(key) && destinations.get(key) !== source)
        throw new ToolError(`multiple source files map to ${destination}; resolve the conflicting sheet names before importing`, "precondition");
      destinations.set(key, source);
      plan.set(destination, source);
    };
    add(abs, PROJECT_FILES.boardPcb);
    for (const [ext, dest] of [
      [".kicad_pro", PROJECT_FILES.boardPro],
      [".kicad_sch", PROJECT_FILES.boardSch],
      [".kicad_dru", "board.kicad_dru"],
    ] as const) {
      const sibling = abs.replace(/\.kicad_pcb$/i, ext);
      if ((await stat(sibling).catch(() => null))?.isFile()) add(sibling, dest);
    }
    // Preserve adjacent native sheets without confusing another root with ours.
    for (const name of await readdir(dirname(abs))) {
      if (!name.toLowerCase().endsWith(".kicad_sch")) continue;
      const sibling = join(dirname(abs), name);
      if (sibling === abs.replace(/\.kicad_pcb$/i, ".kicad_sch")) continue;
      add(sibling, basename(name));
    }
    const files: Array<{ destination: string; data: Buffer }> = [];
    for (const [destination, source] of plan) {
      const target = await jailPath(project.dir, destination);
      if (source !== target) files.push({ destination, data: await readFile(source) });
    }
    const route = ctx.services.routeRuns.latest(project.id);
    if (route && ["queued", "running", "cancel_requested", "cancelling"].includes(route.state))
      throw new ToolError("import refused: routing is active; wait for it to finish", "precondition");
    const recovery = ctx.services.design.withSavedFilesRecovery;
    if (!recovery) throw new ToolError("native saved-file recovery is unavailable in this runtime", "unavailable");
    ctx.progress(0.1, "copying");
    await recovery(project.dir, async () => {
      for (const file of files) await writeAtomic(await jailPath(project.dir, file.destination), file.data);
    });
    const copied = files.map(file => file.destination);
    const target = p(project, PROJECT_FILES.boardPcb);
    let layers: number | undefined;
    const cli = await ctx.services.kicad.resolveCli();
    if (cli) {
      ctx.progress(0.5, "reading board stats");
      const stats = (await ctx.services.kicad
        .boardStats(cli, {
          board: target,
          scratchFile: p(project, PROJECT_FILES.reports, "stats.json"),
        })
        .catch(() => ({}))) as Record<string, unknown>;
      const n = Number(stats["copperLayers"] ?? stats["copper_layers"] ?? stats["layers"]);
      if (Number.isInteger(n) && n >= 1 && n <= 8) layers = n;
    }
    if (layers !== undefined)
      await project.updateManifest({ board: { ...project.manifest().board, layers } });
    ctx.progress(1, "done");
    return ok(
      `Adopted ${abs} as the project board: ${copied.length ? copied.join(", ") : "already in place"}.${layers !== undefined ? ` fabdesk.json board.layers=${layers}.` : ""}`,
      { source: abs, copied, ...(layers !== undefined ? { layers } : {}) },
    );
  },
});

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function mimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      svg: "image/svg+xml",
      glb: "model/gltf-binary",
      json: "application/json",
      gif: "image/gif",
      mp4: "video/mp4",
      webm: "video/webm",
    }[ext] ?? "application/octet-stream"
  );
}

export const projectTools = [
  project_checkpoint,
  project_read_file,
  project_write_file,
  project_list_sketches,
  project_set_board,
  project_import_kicad,
  ...partsTools,
];
