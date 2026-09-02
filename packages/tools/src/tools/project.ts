/** Project toolset: files, sketches and board settings. All paths are jailed under the project dir. */
import { readdir, readFile, stat } from "node:fs/promises";
import { z } from "zod/v4";
import { PROJECT_FILES, jailPath, projectRelative, writeAtomic } from "../fs";
import { ToolError, defineTool } from "../registry";
import { ok, p, trim } from "./common";

const MAX_READ = 512 * 1024;

export const project_read_file = defineTool({
  name: "project_read_file",
  toolset: "project",
  title: "Read a project file",
  description:
    "Read a text file inside the project directory (e.g. circuit.tsx, reports/drc.json, fabdesk.json). Paths are relative to the project and may not leave it. Binary files are reported by size only; use project_list_sketches for images.",
  inputSchema: {
    path: z.string().min(1).describe("Relative path, e.g. circuit.tsx"),
    maxChars: z.number().int().min(100).max(200_000).default(50_000),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
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
    if (st.size > MAX_READ) return ok(`${path} is ${st.size} bytes; too large to inline.`, { path, size: st.size, truncated: true });
    const buf = await readFile(abs);
    if (isBinary(buf)) return ok(`${path} is binary (${st.size} bytes).`, { path, size: st.size, binary: true });
    const content = buf.toString("utf8");
    return ok(trim(content, maxChars), { path, size: st.size, content: content.slice(0, maxChars) });
  },
});

export const project_write_file = defineTool({
  name: "project_write_file",
  toolset: "project",
  title: "Write a project file",
  description:
    "Create or overwrite a text file inside the project directory, creating parent directories. Use it to write circuit.tsx. Paths are relative to the project and may not leave it; fabdesk.json must be changed through project_set_board.",
  inputSchema: {
    path: z.string().min(1).describe("Relative path, e.g. circuit.tsx"),
    content: z.string().describe("Full file content (UTF-8)"),
  },
  annotations: { destructiveHint: true, idempotentHint: true },
  handler: async ({ path, content }, ctx) => {
    const project = ctx.requireProject();
    const abs = await jailPath(project.dir, path);
    const rel = projectRelative(project.dir, abs);
    if (rel === PROJECT_FILES.manifest) throw new ToolError("fabdesk.json is managed by fabdesk; use project_set_board", "invalid_args");
    if (rel.startsWith(".fabdesk/")) throw new ToolError(".fabdesk/ is managed by fabdesk", "invalid_args");
    await writeAtomic(abs, content);
    return ok(`Wrote ${rel} (${Buffer.byteLength(content)} bytes).`, { path: rel, bytes: Buffer.byteLength(content) });
  },
});

export const project_list_sketches = defineTool({
  name: "project_list_sketches",
  toolset: "project",
  title: "List sketches",
  description:
    "List the user's sketch images (PNG/JPEG/SVG under sketches/) with absolute paths so you can open them with your image reading capability. Sketches describe the desired board; interpret them before writing circuit.tsx.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const dir = p(project, PROJECT_FILES.sketches);
    const names = (await readdir(dir).catch(() => [])).filter((f) => /\.(png|jpe?g|svg)$/i.test(f)).sort();
    const sketches = await Promise.all(
      names.map(async (name) => {
        const abs = p(project, PROJECT_FILES.sketches, name);
        const st = await stat(abs);
        return { name, path: abs, size: st.size, mtime: st.mtime.toISOString(), mime: mimeFor(name) };
      }),
    );
    const text = sketches.length ? `Sketches:\n${sketches.map((s) => `- ${s.path} (${s.size} bytes, ${s.mtime})`).join("\n")}` : "No sketches in sketches/.";
    return ok(text, { sketches }, { images: sketches.filter((s) => s.mime !== "image/svg+xml").map((s) => ({ path: s.path, mime: s.mime })) });
  },
});

export const project_set_board = defineTool({
  name: "project_set_board",
  toolset: "project",
  title: "Set board settings",
  description:
    "Update board constraints in fabdesk.json: layer count (1-8), outline width/height in mm, and the router to use. These drive routing and the KiCad conversion; put matching values in circuit.tsx's <board> element.",
  inputSchema: {
    layers: z.number().int().min(1).max(8).optional(),
    widthMm: z.number().positive().optional(),
    heightMm: z.number().positive().optional(),
    router: z.enum(["capacity", "freerouting"]).optional(),
  },
  annotations: { idempotentHint: true },
  handler: async ({ layers, widthMm, heightMm, router }, ctx) => {
    const project = ctx.requireProject();
    if (router === "freerouting" && ctx.services.channel !== "internal") {
      throw new ToolError("the freerouting router is only available in internal builds", "unavailable");
    }
    const current = project.manifest();
    const board = {
      ...current.board,
      ...(layers !== undefined ? { layers } : {}),
      ...(widthMm !== undefined ? { widthMm } : {}),
      ...(heightMm !== undefined ? { heightMm } : {}),
    };
    const next = await project.updateManifest({ board, ...(router ? { router } : {}) });
    return ok(`Board: ${next.board.layers} layers, ${next.board.widthMm ?? "?"}×${next.board.heightMm ?? "?"} mm, router ${next.router}.`, { board: next.board, router: next.router });
  },
});

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function mimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", glb: "model/gltf-binary", json: "application/json" }[ext] ?? "application/octet-stream";
}

export const projectTools = [project_read_file, project_write_file, project_list_sketches, project_set_board];
