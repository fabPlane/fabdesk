import { parseLibraryTable, readSavedBoardModels } from "@fabdesk/kicad";
import { BoardModelRevision, PcbPreviewRevision, RootSchematicPreviewRevision } from "@fabdesk/protocol";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { assertProjectBomInputs } from "./project-bom";
import { canonicalReportStatus } from "./canonical-report-status";
import { snapshotProjectDependencies, assertProjectDependencies } from "./project-dependencies";
import { jailPath, writeAtomic, writeJson } from "./fs";
import { ToolError, type ToolContext } from "./registry";
import { inspectSavedHierarchy, ok } from "./tools/common";

/** Editable handoff, with source-bound inventory. Host-specific library/model references fail closed. */
export async function portableHandoff(ctx: ToolContext, filename: string, zip: (output: string, entries: Array<{ name: string; path: string }>) => Promise<void>) {
  if (ctx.board) throw new ToolError("Portable handoff currently supports one root board; assembly handoff remains unsupported", "precondition");
  const project = ctx.requireProject(), status = await canonicalReportStatus(ctx);
  if (status.drc.status !== "current" || status.erc.status !== "current") throw new ToolError("Portable handoff requires current saved DRC and ERC; run render_publish first", "precondition");
  const hierarchy = await inspectSavedHierarchy(ctx, project);
  if (!hierarchy.complete) throw new ToolError("Portable handoff requires a complete project-owned schematic hierarchy", "precondition");
  const dependencies = await snapshotProjectDependencies(project.dir);
  const bad = dependencies.unresolved.filter(item => item.startsWith("library:") || /model:(?:\/|[A-Za-z]:[\\/])/.test(item));
  if (bad.length) throw new ToolError(`Package libraries/models inside the project before handoff: ${bad.join(", ")}`, "precondition");
  const scratch = await jailPath(project.dir, ".fabdesk/handoff/archive");
  await writeAtomic(join(scratch, ".keep"), "");
  const stage = await mkdtemp(join(scratch, "prepare-"));
  const bytes = new Map<string, Buffer>(), hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const directories = new Set<string>();
  let total = 0, visited = 0;
  const add = async (path: string, required = true) => {
    if (path.split("/").some(part => part.startsWith(".") || part.startsWith("~")) || /\.(bak|zip|kicad_prl|map)$/.test(path)) return;
    const abs = await jailPath(project.dir, path), info = await stat(abs).catch(() => null);
    if (!info) { if (required) throw new ToolError(`Handoff input missing: ${path}`, "precondition"); return; }
    if (++visited > 8192) throw new ToolError("Handoff exceeds entry limit", "precondition");
    if (info.isDirectory()) {
      const canonical = await realpath(abs); if (directories.has(canonical)) return; directories.add(canonical);
      for (const entry of await readdir(abs)) if (!entry.startsWith(".") && !entry.startsWith("~") && !/\.(bak|zip|kicad_prl|map)$/.test(entry)) await add(`${path}/${entry}`);
    } else if (info.isFile()) {
      if (bytes.size >= 4096 || info.size > 100 * 1024 * 1024 || (total += info.size) > 256 * 1024 * 1024) throw new ToolError("Handoff exceeds file limits", "precondition");
      bytes.set(path, await readFile(abs));
    }
  };
  try {
    for (const path of ["fabdesk.json", "board.kicad_pcb", ...hierarchy.referencedFiles, ...(hierarchy.projectFile ? [hierarchy.projectFile] : []), ...dependencies.files.filter(f => f.sha256 !== null && (/(?:^|\/)(?:fp|sym)-lib-table$/.test(f.path) || /\.(?:kicad_(?:pro|dru|sch|pcb|mod|sym)|step|stp|wrl|vrml|iges|igs)$/i.test(f.path))).map(f => f.path)]) await add(path);
    for (const path of ["renders", "reports/drc.json", "reports/erc.json"]) await add(path);
    for (const path of ["bom.csv", "bom.coverage.json", "pcb-features.json", "positions.csv", "positions.csv.revision.json", "positions.contract.json", "placement-features.csv", "schematic.pdf", "schematic.pdf.revision.json"]) await add(`exports/${path}`, false);
    for (const name of ["gerbers.inventory.json", "drills.inventory.json"]) {
      const path = `exports/gerbers/${name}`; await add(path);
      const inventory = JSON.parse(bytes.get(path)!.toString());
      if (!Array.isArray(inventory.files) || inventory.files.some((file: unknown) => typeof file !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file))) throw new ToolError("Invalid CAM inventory", "precondition");
      for (const file of inventory.files) { await add(`exports/gerbers/${file}`); await add(`exports/gerbers/${file}.revision.json`); }
    }
    for (const path of ["fp-lib-table", "sym-lib-table"]) for (const row of parseLibraryTable(bytes.get(path)?.toString() ?? ""))
      if (/^(?:\/|[A-Za-z]:[\\/])/.test(row.uri)) throw new ToolError("Portable handoff refuses host-absolute library references; register project-contained libraries", "precondition");
    for (const fp of readSavedBoardModels(bytes.get("board.kicad_pcb")!.toString())) for (const model of fp.models)
      if (/^(?:\/|[A-Za-z]:[\\/])/.test(model.declared)) throw new ToolError("Portable handoff refuses host-absolute model references; use project-contained models", "precondition");
    for (const path of ["renders/pcb.svg", "renders/pcb.svg.revision.json", "renders/board.glb", "renders/board.glb.revision.json", "renders/schematic.revision.json", "exports/schematic.pdf", "exports/schematic.pdf.revision.json", "exports/positions.csv", "exports/positions.csv.revision.json", "exports/positions.contract.json", "exports/bom.csv", "exports/bom.coverage.json", "exports/gerbers/gerbers.inventory.json", "exports/gerbers/drills.inventory.json"]) if (!bytes.has(path)) throw new ToolError(`Handoff input missing: ${path}; export current views, PDF, placements and production CAM first`, "precondition");
    const pcbHash = hash(bytes.get("board.kicad_pcb")!);
    for (const path of ["exports/gerbers/gerbers.inventory.json", "exports/gerbers/drills.inventory.json"]) if (JSON.parse(bytes.get(path)!.toString()).pcbSha256 !== pcbHash) throw new ToolError("CAM inventory is stale; regenerate exports", "precondition");
    const pcbReceipt = PcbPreviewRevision.safeParse(JSON.parse(bytes.get("renders/pcb.svg.revision.json")!.toString()));
    const modelReceipt = BoardModelRevision.safeParse(JSON.parse(bytes.get("renders/board.glb.revision.json")!.toString()));
    const schematicPreview = RootSchematicPreviewRevision.safeParse(JSON.parse(bytes.get("renders/schematic.revision.json")!.toString()));
    if (!pcbReceipt.success || !modelReceipt.success || !schematicPreview.success) throw new ToolError("Handoff view receipt is unverified; run render_publish", "precondition");
    for (const receipt of [pcbReceipt.data, modelReceipt.data, schematicPreview.data])
      if (receipt.dependencySnapshot?.revision !== dependencies.revision) throw new ToolError("Handoff view dependencies are stale or unverified; run render_publish", "precondition");
    for (const receipt of [pcbReceipt.data, modelReceipt.data])
      if (receipt.sourceSha256 !== pcbHash || receipt.artifactSha256 !== hash(bytes.get(receipt.artifact)!)) throw new ToolError("Handoff view is stale; run render_publish", "precondition");
    const schematicReceipt = schematicPreview.data;
    if (schematicReceipt.projectId !== project.id || schematicReceipt.sourceRevision !== hierarchy.aggregateRevision) throw new ToolError("Handoff schematic view is stale; run render_publish", "precondition");
    for (const sheet of schematicReceipt.sheets)
      if (!bytes.has(sheet.path) || hash(bytes.get(sheet.path)!) !== sheet.sha256) throw new ToolError(`Handoff schematic view is missing or altered: ${sheet.path}; run render_publish`, "precondition");
    const camFiles = ["gerbers.inventory.json", "drills.inventory.json"].flatMap(name => JSON.parse(bytes.get(`exports/gerbers/${name}`)!.toString()).files);
    if (!camFiles.length) throw new ToolError("Handoff has no production CAM payloads", "precondition");
    for (const path of ["exports/positions.csv", ...camFiles.map((file: string) => `exports/gerbers/${file}`)]) {
      const receipt = JSON.parse(bytes.get(`${path}.revision.json`)!.toString());
      if (receipt.artifactSha256 !== hash(bytes.get(path)!) || receipt.basis !== "pcb" || receipt.inputs?.length !== 1 || receipt.inputs[0]?.path !== "board.kicad_pcb" || receipt.inputs[0]?.sha256 !== pcbHash) throw new ToolError(`Manufacturing payload is stale or altered: ${path}; regenerate exports`, "precondition");
    }
    const bom = JSON.parse(bytes.get("exports/bom.coverage.json")!.toString());
    if (!Array.isArray(bom.inputs) || !Array.isArray(bom.absentInputs) || bom.complete !== true) throw new ToolError("Handoff BOM source coverage is incomplete or unverified; export_bom after reviewing sources", "precondition");
    await assertProjectBomInputs(project.dir, bom);
    if (bom.export?.artifactSha256 !== hash(bytes.get("exports/bom.csv")!)) throw new ToolError("BOM payload is altered or lacks export provenance; regenerate export_bom", "precondition");
    const pdfReceipt = JSON.parse(bytes.get("exports/schematic.pdf.revision.json")!.toString());
    for (const receipt of [schematicReceipt, pdfReceipt]) {
      const inputs = receipt.sourceFiles ?? receipt.inputs;
      if (!Array.isArray(inputs) || !inputs.length) throw new ToolError("Schematic/PDF source receipt is unverified", "precondition");
      for (const input of inputs) if (!bytes.has(input.path) || hash(bytes.get(input.path)!) !== input.sha256) throw new ToolError("Schematic/PDF source receipt is stale", "precondition");
    }
    if (pdfReceipt.artifactSha256 !== hash(bytes.get("exports/schematic.pdf")!)) throw new ToolError("PDF artifact does not match its source receipt", "precondition");
    const entries: Array<{ name: string; path: string }> = [];
    for (const [name, value] of bytes) { const path = await jailPath(stage, name); await writeAtomic(path, value); entries.push({ name, path }); }
    const inventory = { contract: "fabplane.portable-handoff.v1", pcbSha256: pcbHash, schematicRevision: hierarchy.aggregateRevision, dependencies, files: [...bytes].map(([path, value]) => ({ path, sha256: hash(value), bytes: value.length })), limits: ["Stock model variables require a compatible KiCad stock model installation; unavailable models remain disclosed in the 3D receipt.", "This package records engineering evidence, not supplier qualification or manufacturing approval."] };
    await writeJson(join(stage, "handoff-inventory.json"), inventory);
    entries.push({ name: "handoff-inventory.json", path: join(stage, "handoff-inventory.json") });
    const output = await jailPath(project.dir, `exports/${filename}`), temporary = join(stage, "handoff.zip");
    await zip(temporary, entries);
    ctx.signal.throwIfAborted();
    await assertProjectDependencies(project.dir, dependencies);
    for (const [path, value] of bytes) if (hash(await readFile(await jailPath(project.dir, path))) !== hash(value)) throw new ToolError("Handoff inputs changed during packaging; previous archive kept", "precondition");
    await writeAtomic(output, await readFile(temporary));
    return ok(`Wrote editable portable handoff exports/${filename}. Stock model installation requirements and missing models remain explicit.`, { path: output, files: entries.map(e => e.name), source: inventory, size: (await stat(output)).size });
  } finally { await rm(stage, { recursive: true, force: true }); }
}
