import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { ASSEMBLY_MANIFEST_PATH, NetlistFile, ProjectPartsFile, projectBomLines, type NetlistComponent, type ProjectBomSnapshot, type BomSourceCoverage } from "@fabdesk/protocol";
import { inspectOwnedProjectFile, inspectProjectBoardSources } from "./assembly";
import { ToolError, type ToolContext } from "./registry";
import { requireKicad } from "./tools/common";
import { nativeBomComponents } from "./bom-csv";

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** One source receipt for displayed quantities and CSV. No PCB artwork or implicit root membership. */
export async function readProjectBom(ctx: ToolContext): Promise<ProjectBomSnapshot> {
  if (ctx.board) throw new ToolError("Project BOM counts declared physical instances; open it at project scope.", "precondition");
  const project = ctx.requireProject(), root = await realpath(project.dir);
  const membership = await inspectProjectBoardSources(project);
  const inputs = new Map<string, string>(), absent = new Set<string>();
  const read = async (path: string, content = true) => {
    try {
      const file = await inspectOwnedProjectFile(root, path, content ? 10 * 1024 * 1024 : 512 * 1024 * 1024, content);
      if (inputs.has(path) && inputs.get(path) !== file.sha256) throw new ToolError("BOM inputs changed while reading; refresh the parts list.", "precondition");
      inputs.set(path, file.sha256); return file;
    } catch (error) { if (missing(error)) { absent.add(path); return null; } throw error; }
  };
  if (membership.manifestSha256) inputs.set(ASSEMBLY_MANIFEST_PATH, membership.manifestSha256);
  else absent.add(ASSEMBLY_MANIFEST_PATH);
  const components: NetlistComponent[] = [], coverage: BomSourceCoverage[] = [];
  for (const record of membership.sources) {
    if (ctx.signal.aborted) throw new ToolError("cancelled", "cancelled");
    const source = record.source, assembly = membership.mode === "assembly";
    const instanceIds = membership.assembly?.instances.filter(instance => instance.sourceId === source.id).map(instance => instance.id) ?? [];
    const multiplier = assembly ? instanceIds.length : 1;
    const directory = source.location === "project" ? source.directory : "";
    const entry: BomSourceCoverage = { sourceId: assembly ? source.id : null, name: source.name, directory, instanceIds, multiplier, status: "unavailable", componentCount: 0 };
    coverage.push(entry);
    if (!multiplier) { entry.status = "unused"; entry.reason = "No physical instance is declared; this source contributes no quantity."; continue; }
    if (source.location !== "project" || (assembly && record.status !== "available")) { entry.reason = record.reason ?? "Board source is unavailable."; continue; }
    const prefix = directory === "." ? "" : `${directory}/`;
    if (record.pcbPath && record.pcbSha256) inputs.set(record.pcbPath, record.pcbSha256);
    try {
      const schematic = await read(`${prefix}board.kicad_sch`, false);
      let sourceComponents: NetlistComponent[];
      if (schematic) {
        const pro = await read(`${prefix}board.kicad_pro`, false);
        const cli = await requireKicad(ctx), projectDir = join(root, directory);
        const hierarchy = await ctx.services.kicad.inspectSchematicHierarchy(cli, { projectDir, rootSchematic: join(projectDir, "board.kicad_sch"), ...(pro ? { projectFile: join(projectDir, "board.kicad_pro") } : {}), ownedFilesOnly: true, signal: ctx.signal });
        if (!hierarchy.complete) throw new Error("The saved schematic hierarchy is incomplete. Resolve its missing or unreadable sheets.");
        const bom = await ctx.services.kicad.exportOwnedSchematicBom(cli, { projectDir, hierarchy, signal: ctx.signal });
        for (const file of bom.sourceFiles) {
          const path = `${prefix}${file.path}`;
          if (inputs.has(path) && inputs.get(path) !== file.sha256) throw new ToolError("BOM inputs changed while reading; refresh the parts list.", "precondition");
          inputs.set(path, file.sha256);
        }
        entry.status = "native-schematic"; entry.sourceRevision = bom.sourceRevision;
        sourceComponents = nativeBomComponents(bom.csv);
      } else {
        const netlist = await read(`${prefix}circuit.netlist.json`);
        if (!netlist) { entry.status = "missing-schematic"; entry.reason = "Add a native schematic or saved design netlist to list this board’s parts."; continue; }
        sourceComponents = NetlistFile.parse(JSON.parse(netlist.text!)).netlist.components;
        entry.status = "saved-netlist"; entry.sourceRevision = netlist.sha256;
        entry.reason = "Saved design netlist only; native schematic exclusions and PCB parity have not been checked.";
      }
      const includedRefs = new Set(projectBomLines(sourceComponents, []).flatMap(line => line.refs));
      entry.componentCount = includedRefs.size;
      const included = sourceComponents.filter(component => includedRefs.has(component.ref));
      if (assembly) for (const instance of instanceIds) components.push(...included.map(component => ({ ...component, ref: `${instance}:${component.ref}` })));
      else components.push(...included);
    } catch (error) {
      if (ctx.signal.aborted) throw new ToolError("cancelled", "cancelled");
      entry.status = "failed"; entry.reason = error instanceof Error ? error.message : String(error);
    }
  }
  const extraFile = await read("project.parts.json");
  const extras = extraFile ? ProjectPartsFile.parse(JSON.parse(extraFile.text!)).parts : [];
  const lines = projectBomLines(components, extras);
  const complete = coverage.every(source => source.status === "native-schematic" || source.status === "unused");
  const receipt = { projectId: project.id, manifestSha256: membership.manifestSha256, lines, coverage, inputs: [...inputs].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)), absentInputs: [...absent].sort() };
  await assertProjectBomInputs(root, receipt);
  return { contract: "fabplane.project-bom.v1", ...receipt, revision: hash(JSON.stringify(receipt)), capturedAt: new Date().toISOString(), complete, notes: ["Quantities use declared physical instances. Off-board hardware is counted once per project.", "Native BOM exclusions are respected. Source coverage is separate from PCB parity, electrical checks and purchasing readiness."] };
}

export async function assertProjectBomInputs(root: string, snapshot: Pick<ProjectBomSnapshot, "inputs" | "absentInputs">): Promise<void> {
  root = await realpath(root);
  for (const input of snapshot.inputs) {
    const current = await inspectOwnedProjectFile(root, input.path, 512 * 1024 * 1024).catch(() => null);
    if (current?.sha256 !== input.sha256) throw new ToolError("BOM inputs changed; refresh and review the parts list before exporting.", "precondition");
  }
  for (const path of snapshot.absentInputs) {
    try { await inspectOwnedProjectFile(root, path, 512 * 1024 * 1024); }
    catch (error) { if (missing(error)) continue; throw new ToolError("BOM inputs changed; refresh and review the parts list before exporting.", "precondition"); }
    throw new ToolError("BOM inputs changed; refresh and review the parts list before exporting.", "precondition");
  }
}
