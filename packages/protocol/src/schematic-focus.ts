import { z } from "zod/v4";
import { AssemblyRelativePath, BoardSourceSelection } from "./assembly";

/** Saved-source navigation request. No claim that a client displayed or validated the design. */
export const SchematicFocus = z.object({
  id: z.string().uuid(), projectId: z.string().min(1), requestedAt: z.number(),
  reference: z.string().min(1).max(128), value: z.string().max(1000),
  sourcePath: AssemblyRelativePath.refine(path => path.endsWith(".kicad_sch"), "Focus requires a native schematic"), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  svgPath: AssemblyRelativePath, svgSha256: z.string().regex(/^[a-f0-9]{64}$/),
  board: BoardSourceSelection.optional(),
  sheet: z.object({ identity: z.string().min(1).max(1024), hierarchyPath: z.string().min(1).max(1024), pageNumber: z.number().int().positive().optional() }).strict().optional(),
  sourceFiles: z.array(z.object({ path: AssemblyRelativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(257).optional(),
  points: z.array(z.object({ x: z.number().finite(), y: z.number().finite(), unit: z.number().int().positive() })).min(1).max(32),
  page: z.object({ width: z.number().positive(), height: z.number().positive() }),
}).strict().superRefine((focus, ctx) => {
  if ((focus.board || focus.sourcePath !== "board.kicad_sch") && (!focus.sheet || !focus.sourceFiles)) ctx.addIssue({ code: "custom", message: "Qualified focus requires native sheet identity and the complete source file snapshot" });
  if (focus.sourceFiles && (new Set(focus.sourceFiles.map(file => file.path)).size !== focus.sourceFiles.length || !focus.sourceFiles.some(file => file.path === focus.sourcePath && file.sha256 === focus.sourceSha256))) ctx.addIssue({ code: "custom", message: "The source snapshot must include the exact focused native file once" });
});
export type SchematicFocus = z.infer<typeof SchematicFocus>;

/** Source-backed alternatives; choosing one re-inspects the captured hierarchy before navigation. */
export const SchematicFocusChoices = z.object({
  projectId: z.string().min(1), reference: z.string().min(1).max(128),
  board: BoardSourceSelection.optional(), expectedHierarchyRevision: z.string().regex(/^[a-f0-9]{64}$/),
  sheets: z.array(z.object({ identity: z.string().min(1).max(1024), hierarchyPath: z.string().min(1).max(1024), sourcePath: AssemblyRelativePath }).strict()).min(2).max(256),
}).strict();
export type SchematicFocusChoices = z.infer<typeof SchematicFocusChoices>;
