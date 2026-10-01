/**
 * CAD toolset: the project's mechanical model in FreeCAD, over the FabPlane CAD bridge
 * (`@fab-cad/bridge`, fabPlane/fab_cad). One `FreeCADApiServer` per project holds
 * `model.FCStd` open; every editing tool recomputes and saves, so the file on disk always matches
 * what the agent and the CAD tab in the app see.
 */
import { writeFile } from "node:fs/promises";
import { z } from "zod/v4";
import { PROJECT_FILES, ensureDir } from "../fs";
import { defineTool, ToolError, type ToolContext } from "../registry";
import type { CadObject, CadProperty, CadService } from "../services";
import { ok, p, table, trim } from "./common";

export function requireCad(ctx: ToolContext): CadService {
  const cad = ctx.services.cad;
  if (!cad)
    throw new ToolError(
      "FreeCAD is not available in this fabdesk daemon: start the FabPlane CAD bridge (`bun run dev:cad`) or set FABDESK_FAB_CAD_BRIDGE_URL.",
      "unavailable",
    );
  return cad;
}

const PropertyValues = z
  .record(z.string(), z.unknown())
  .describe(
    'Property name → value. Numbers are in FreeCAD base units (mm, deg); strings may carry units ("25 mm", "1 in"); vectors, placements and links use the FreeCAD API\'s tagged form, e.g. {"$type":"Vector","x":0,"y":0,"z":5}.',
  );

function objectRows(objects: CadObject[]) {
  return objects.map((o) => ({
    name: o.name,
    label: o.label,
    type: o.type,
    status: o.status,
    visible: o.visibility,
    children: o.children.join(" "),
    ...(o.bbox
      ? {
          size: o.bbox.max.map((v, i) => +(v - o.bbox!.min[i]!).toFixed(3)).join(" × "),
        }
      : {}),
  }));
}

function propertyRows(props: CadProperty[]) {
  return props.map((pr) => ({
    name: pr.name,
    group: pr.group,
    type: pr.type.replace(/^App::Property/, ""),
    value: pr.value,
    ...(pr.expression ? { expression: pr.expression } : {}),
    ...(pr.readOnly ? { readOnly: true } : {}),
  }));
}

/** Recompute, then save; recompute errors are reported, not thrown, so the agent can fix them. */
async function commit(cad: CadService, dir: string) {
  const recompute = await cad.recompute(dir);
  const saved = await cad.save(dir);
  return { recompute, saved };
}

function recomputeNote(errors: Array<{ object: string; message: string }>): string {
  return errors.length
    ? `\nRecompute errors:\n${errors.map((e) => `- ${e.object}: ${e.message}`).join("\n")}`
    : "";
}

export const cad_status = defineTool({
  name: "cad_status",
  toolset: "cad",
  title: "FreeCAD status",
  description:
    "Report whether the FabPlane CAD bridge is reachable and which FreeCAD it runs, and summarise the current project's model (model.FCStd) when a project is selected.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  scope: "global",
  handler: async (_args, ctx) => {
    const cad = requireCad(ctx);
    const status = await cad.status();
    const lines = [
      `Bridge: ${status.bridgeUrl} ${status.reachable ? "✓" : "✗"} ${status.detail}`,
      `FreeCAD: ${status.freecad ?? "none configured"}`,
      `Web UI: ${status.ui ? "served" : "not served"}`,
    ];
    let model: Awaited<ReturnType<CadService["model"]>> | null = null;
    if (status.reachable && ctx.project) {
      model = await cad.model(ctx.project.dir);
      lines.push(
        `Model: ${PROJECT_FILES.cadModel} (document ${model.document}, ${model.objects.length} objects${model.modified ? ", unsaved changes" : ""})`,
      );
    }
    return ok(lines.join("\n"), { status, ...(model ? { model } : {}) });
  },
});

export const cad_model = defineTool({
  name: "cad_model",
  toolset: "cad",
  title: "List CAD model objects",
  description:
    "List the objects of the project's FreeCAD model (model.FCStd, created empty on first use): internal name, label, type, recompute status, children and bounding-box size in mm.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const model = await requireCad(ctx).model(project.dir);
    return ok(
      `${PROJECT_FILES.cadModel} — document ${model.document}, ${model.objects.length} objects${model.modified ? " (unsaved changes)" : ""}\n${table(objectRows(model.objects))}`,
      model,
    );
  },
});

export const cad_properties = defineTool({
  name: "cad_properties",
  toolset: "cad",
  title: "Read CAD object properties",
  description:
    "Read an object's properties (value, unit, expression, group) from the project's FreeCAD model. Pass `names` to read only some.",
  inputSchema: {
    object: z.string().describe("Internal object name, e.g. Box"),
    names: z.array(z.string()).optional().describe("Only these properties"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async ({ object, names }, ctx) => {
    const project = ctx.requireProject();
    const props = await requireCad(ctx).properties(project.dir, object, names);
    return ok(`${object}:\n${table(propertyRows(props))}`, { object, properties: props });
  },
});

export const cad_add_object = defineTool({
  name: "cad_add_object",
  toolset: "cad",
  title: "Add CAD object",
  description:
    "Add a FreeCAD object to the project's model (e.g. Part::Box, Part::Cylinder, Part::Cut, PartDesign::Body, Sketcher::SketchObject), set its properties, recompute and save.",
  inputSchema: {
    type: z.string().describe("FreeCAD type id, e.g. Part::Box"),
    name: z.string().optional().describe("Internal name; FreeCAD picks one when omitted"),
    label: z.string().optional(),
    properties: PropertyValues.optional(),
    group: z.string().optional().describe("Internal name of a group or body to add it to"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  handler: async ({ type, name, label, properties, group }, ctx) => {
    const project = ctx.requireProject();
    const cad = requireCad(ctx);
    const added = await cad.addObject(project.dir, {
      type,
      ...(name ? { name } : {}),
      ...(label ? { label } : {}),
      ...(properties ? { properties } : {}),
      ...(group ? { group } : {}),
    });
    const { recompute } = await commit(cad, project.dir);
    return ok(
      `Added ${added.name} (${added.type}, label "${added.label}") to ${PROJECT_FILES.cadModel}.${recomputeNote(recompute.errors)}`,
      { object: added, recompute },
    );
  },
});

export const cad_set_properties = defineTool({
  name: "cad_set_properties",
  toolset: "cad",
  title: "Set CAD object properties",
  description:
    "Set properties of an object in the project's FreeCAD model (one undo step), optionally bind expressions (`expressions`: path → formula, null clears), then recompute and save.",
  inputSchema: {
    object: z.string().describe("Internal object name"),
    values: PropertyValues.optional(),
    expressions: z
      .record(z.string(), z.string().nullable())
      .optional()
      .describe('Property path → expression, e.g. {"Height": "Box.Length * 2"}; null clears'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async ({ object, values, expressions }, ctx) => {
    const project = ctx.requireProject();
    const cad = requireCad(ctx);
    if (!values && !expressions)
      throw new ToolError("pass `values` or `expressions`", "invalid_args");
    const changed = values ? await cad.setProperties(project.dir, object, values) : [];
    for (const [path, expression] of Object.entries(expressions ?? {}))
      await cad.setExpression(project.dir, object, path, expression);
    const { recompute } = await commit(cad, project.dir);
    return ok(
      `Updated ${object}: ${[...Object.keys(values ?? {}), ...Object.keys(expressions ?? {})].join(", ")}.${recomputeNote(recompute.errors)}`,
      { object, properties: changed, recompute },
    );
  },
});

export const cad_remove_object = defineTool({
  name: "cad_remove_object",
  toolset: "cad",
  title: "Remove CAD object",
  description:
    "Remove an object from the project's FreeCAD model (with `recursive`, also the objects it claims as children), then recompute and save. Undo with cad_undo.",
  inputSchema: {
    object: z.string().describe("Internal object name"),
    recursive: z.boolean().default(false),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  handler: async ({ object, recursive }, ctx) => {
    const project = ctx.requireProject();
    const cad = requireCad(ctx);
    await cad.removeObject(project.dir, object, recursive);
    const { recompute } = await commit(cad, project.dir);
    return ok(`Removed ${object}.${recomputeNote(recompute.errors)}`, { object, recompute });
  },
});

export const cad_recompute = defineTool({
  name: "cad_recompute",
  toolset: "cad",
  title: "Recompute CAD model",
  description:
    "Recompute the project's FreeCAD model and save it; reports objects that failed to recompute.",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const { recompute, saved } = await commit(requireCad(ctx), project.dir);
    return ok(
      `Recomputed ${recompute.recomputed} objects; saved ${saved.path}.${recomputeNote(recompute.errors)}`,
      { ...recompute, path: saved.path },
    );
  },
});

export const cad_undo = defineTool({
  name: "cad_undo",
  toolset: "cad",
  title: "Undo / redo in the CAD model",
  description:
    "Undo (or with `redo`, redo) the last change to the project's FreeCAD model, recompute and save. Returns the remaining undo and redo steps.",
  inputSchema: { redo: z.boolean().default(false) },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  handler: async ({ redo }, ctx) => {
    const project = ctx.requireProject();
    const cad = requireCad(ctx);
    const stack = await cad.undo(project.dir, redo);
    await commit(cad, project.dir);
    return ok(
      `${redo ? "Redone" : "Undone"}. Undo: ${stack.undo.join(", ") || "(empty)"}; redo: ${stack.redo.join(", ") || "(empty)"}`,
      stack,
    );
  },
});

const EXTENSIONS = { step: "step", iges: "iges", brep: "brep", stl: "stl", obj: "obj" } as const;

export const cad_export = defineTool({
  name: "cad_export",
  toolset: "cad",
  title: "Export CAD model",
  description:
    "Export objects of the project's FreeCAD model (default: every visible top-level shape) to exports/<name>.<format> as STEP, IGES, BREP, STL or OBJ, e.g. an enclosure for printing or a STEP for the board's 3D check.",
  inputSchema: {
    format: z.enum(["step", "iges", "brep", "stl", "obj"]).default("step"),
    objects: z.array(z.string()).optional().describe("Internal object names"),
    name: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .default("model")
      .describe("Output base name under exports/"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  handler: async ({ format, objects, name }, ctx) => {
    const project = ctx.requireProject();
    const out = await requireCad(ctx).export(project.dir, {
      format,
      ...(objects ? { objects } : {}),
    });
    await ensureDir(p(project, PROJECT_FILES.exports));
    const rel = `${PROJECT_FILES.exports}/${name}.${EXTENSIONS[format]}`;
    const path = p(project, rel);
    await writeFile(path, out.data);
    return ok(
      `Exported ${out.objects.join(", ")} as ${format.toUpperCase()} to ${rel} (${out.data.byteLength} bytes).`,
      {
        path,
        format,
        objects: out.objects,
        bytes: out.data.byteLength,
      },
    );
  },
});

export const cad_python = defineTool({
  name: "cad_python",
  toolset: "cad",
  title: "Run FreeCAD Python",
  description:
    "Run Python in the project's FreeCAD session (`FreeCAD`/`App`, `Part`, `Sketcher`, `PartDesign` importable; the model is `App.ActiveDocument`), for work the other cad tools do not cover: sketches with constraints, pads and pockets, booleans, fillets. The model is recomputed and saved afterwards. Returns stdout, stderr, an expression's repr, or the exception.",
  inputSchema: {
    code: z.string().min(1),
    mode: z
      .enum(["exec", "eval", "auto"])
      .default("auto")
      .describe("auto evaluates an expression and falls back to executing statements"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  handler: async ({ code, mode }, ctx) => {
    const project = ctx.requireProject();
    const cad = requireCad(ctx);
    const result = await cad.python(project.dir, code, mode);
    const { recompute } = await commit(cad, project.dir);
    const parts = [
      result.stdout && `stdout:\n${trim(result.stdout, 8_000)}`,
      result.stderr && `stderr:\n${trim(result.stderr, 8_000)}`,
      result.repr !== undefined && `=> ${trim(result.repr, 4_000)}`,
      result.exception && `exception:\n${result.exception}`,
    ].filter(Boolean);
    return ok(
      `${parts.join("\n") || "(no output)"}${recomputeNote(recompute.errors)}`,
      {
        ...result,
        recompute,
      },
      result.exception ? { isError: true } : {},
    );
  },
});

export const cad_view = defineTool({
  name: "cad_view",
  toolset: "cad",
  title: "Open the CAD view",
  description:
    "Return the URL of the fab_cad web UI attached to the project's live FreeCAD session (what the app's CAD tab shows), and the session's WebSocket for a FreeCAD API client.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const view = await requireCad(ctx).view(project.dir);
    return ok(
      view.uiUrl
        ? `CAD view: ${view.uiUrl}`
        : `The bridge at ${view.bridgeUrl} serves no web UI; FreeCAD API socket: ${view.wsUrl}`,
      view,
    );
  },
});

export const cadTools = [
  cad_status,
  cad_model,
  cad_properties,
  cad_add_object,
  cad_set_properties,
  cad_remove_object,
  cad_recompute,
  cad_undo,
  cad_export,
  cad_python,
  cad_view,
];
