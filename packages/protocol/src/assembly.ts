import { z } from "zod/v4";

export const ASSEMBLY_MANIFEST_PATH = "fabplane.assembly.json";
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
/** A captured editable source identity, not a physical instance or a mutable active-board selection. */
export const BoardSourceSelection = z.object({ sourceId: Id, manifestSha256: Hash }).strict();
export type BoardSourceSelection = z.infer<typeof BoardSourceSelection>;
/** Portable project-relative paths only; filesystem inspection additionally rejects symlink aliases. */
export const AssemblyRelativePath = z.string().min(1).max(1024).refine(path => !path.startsWith("/") && !path.includes("\\") && !path.includes(":") && !path.includes("\0") && path.split("/").every(part => part !== "" && part !== "." && part !== ".."), "Use a portable project-relative path without dot segments");
const Directory = z.union([z.literal("."), AssemblyRelativePath]);
export const BoardSourceProvenance = z.object({
  repository: z.string().url().optional(),
  ref: z.string().min(1).max(256).optional(),
  path: AssemblyRelativePath,
  sha256: Hash.optional(),
}).strict();
export const AssemblyBoardSource = z.discriminatedUnion("location", [
  z.object({ id: Id, name: z.string().min(1).max(120), location: z.literal("project"), directory: Directory, provenance: BoardSourceProvenance.optional() }).strict(),
  z.object({ id: Id, name: z.string().min(1).max(120), location: z.literal("unresolved"), provenance: BoardSourceProvenance }).strict(),
]);
export type AssemblyBoardSource = z.infer<typeof AssemblyBoardSource>;
export const AssemblyBoardInstance = z.object({
  id: Id, sourceId: Id, name: z.string().min(1).max(120),
  /** Canvas pixels are presentation only, never installed chassis or KiCad coordinates. */
  presentation: z.object({ units: z.literal("canvas-px"), x: z.number().finite().min(-1e6).max(1e6), y: z.number().finite().min(-1e6).max(1e6) }).strict().optional(),
}).strict();
const Endpoint = z.object({ instanceId: Id, connector: z.string().min(1).max(120) }).strict();
export const AssemblyConnection = z.object({
  id: Id, name: z.string().min(1).max(160), a: Endpoint, b: Endpoint,
  /** A source reference is not evidence of compatibility or a passed pin-map check. */
  contract: z.object({ path: AssemblyRelativePath, id: z.string().min(1).max(160), sha256: Hash.optional() }).strict().optional(),
}).strict();
export const ProjectAssembly = z.object({
  contract: z.literal("fabplane.assembly.v1"),
  sources: z.array(AssemblyBoardSource).min(1).max(128),
  instances: z.array(AssemblyBoardInstance).min(1).max(256),
  connections: z.array(AssemblyConnection).max(512).default([]),
}).strict().superRefine((value, ctx) => {
  for (const key of ["sources", "instances", "connections"] as const) {
    const seen = new Set<string>();
    value[key].forEach((row, index) => { if (seen.has(row.id)) ctx.addIssue({ code: "custom", path: [key, index, "id"], message: "IDs must be unique in their collection" }); seen.add(row.id); });
  }
  const directories = new Set<string>();
  value.sources.forEach((source, index) => {
    if (source.location !== "project") return;
    if (directories.has(source.directory)) ctx.addIssue({ code: "custom", path: ["sources", index, "directory"], message: "Declare a source directory once; use instances to repeat a physical board" });
    directories.add(source.directory);
  });
  const sources = new Set(value.sources.map(row => row.id)), instances = new Set(value.instances.map(row => row.id));
  value.instances.forEach((row, index) => { if (!sources.has(row.sourceId)) ctx.addIssue({ code: "custom", path: ["instances", index, "sourceId"], message: "Instance source is not declared" }); });
  value.connections.forEach((row, index) => {
    for (const endpoint of ["a", "b"] as const) if (!instances.has(row[endpoint].instanceId)) ctx.addIssue({ code: "custom", path: ["connections", index, endpoint, "instanceId"], message: "Connection instance is not declared" });
    if (row.a.instanceId === row.b.instanceId && row.a.connector === row.b.connector) ctx.addIssue({ code: "custom", path: ["connections", index], message: "A connection needs two distinct endpoints" });
  });
});
export type ProjectAssembly = z.infer<typeof ProjectAssembly>;
export const InspectedBoardSource = z.object({
  source: AssemblyBoardSource,
  status: z.enum(["available", "missing", "unresolved", "blocked"]),
  reason: z.string().optional(),
  pcbPath: AssemblyRelativePath.optional(), schematicPath: AssemblyRelativePath.optional(), previewPath: AssemblyRelativePath.optional(),
  pcbSha256: Hash.optional(), bytes: z.number().int().nonnegative().optional(),
});
export const ProjectBoardSources = z.object({
  projectId: z.string().min(1),
  mode: z.enum(["single", "assembly"]),
  assembly: ProjectAssembly.nullable(), manifestSha256: Hash.nullable(),
  sources: z.array(InspectedBoardSource),
  observedAt: z.string().datetime(),
  /** Only opted-in source tools can mutate members; this does not enable every board workflow. */
  editing: z.enum(["single-board-only", "explicit-source-tools"]),
});
export type ProjectBoardSources = z.infer<typeof ProjectBoardSources>;
