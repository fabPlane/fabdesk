import { createHash, randomUUID } from "node:crypto";
import { relative, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { SchematicFocus, SchematicFocusChoices } from "@fabdesk/protocol";
import { inspectProjectBoardSources } from "./assembly";
import { exists, jailPath, writeAtomic } from "./fs";
import { ToolError, type ToolContext } from "./registry";
import { ok, requireKicad } from "./tools/common";

type Node = string | Node[];
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
/** Bounded native S-expression reader; symbol anchors must be direct document children. */
export function schematicFocusAnchors(text: string, reference: string, instancePath?: string) {
  if (text.length > 10_000_000) throw new Error("Schematic exceeds the navigation inspection limit.");
  const stack: Node[][] = [[]];
  const pattern = /\s*("(?:\\.|[^"\\])*"|[()]|[^\s()"]+)\s*/gy;
  let offset = 0;
  while (offset < text.length) {
    pattern.lastIndex = offset; const match = pattern.exec(text);
    if (!match) throw new Error("Malformed native schematic token.");
    offset = pattern.lastIndex; const token = match[1]!;
    if (token === "(") { if (stack.length > 128) throw new Error("Schematic nesting exceeds the navigation limit."); const node: Node[] = []; stack.at(-1)!.push(node); stack.push(node); }
    else if (token === ")") { if (stack.length === 1) throw new Error("Malformed native schematic."); stack.pop(); }
    else stack.at(-1)!.push(token.startsWith('"') ? token.slice(1, -1).replace(/\\(["\\])/g, "$1") : token);
  }
  if (stack.length !== 1 || stack[0]!.length !== 1) throw new Error("Malformed native schematic.");
  const root = stack[0]![0]; if (!Array.isArray(root) || root[0] !== "kicad_sch") throw new Error("Not a native KiCad schematic.");
  const children = (node: Node[], key: string): Node[][] => node.filter((child): child is Node[] => Array.isArray(child) && child[0] === key);
  const paper = children(root, "paper")[0];
  const sizes: Record<string, [number, number]> = { A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210], A5: [210, 148], A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6] };
  const dimensions = paper?.[1] === "User" ? [Number(paper[2]), Number(paper[3])] : sizes[String(paper?.[1])];
  if (!dimensions || dimensions.some(n => !Number.isFinite(n) || n <= 0)) throw new Error("This schematic page size is not supported for verified navigation.");
  const [width, height] = paper?.includes("portrait") ? [dimensions[1]!, dimensions[0]!] : [dimensions[0]!, dimensions[1]!];
  const annotations = (node: Node[]) => children(node, "instances").flatMap(group => children(group, "project").flatMap(project => children(project, "path")));
  const matches = children(root, "symbol").filter(node => instancePath
    ? annotations(node).filter(path => path[1] === instancePath).some(path => children(path, "reference")[0]?.[1] === reference)
    : children(node, "property").some(p => p[1] === "Reference" && p[2] === reference));
  if (!matches.length) throw new Error(`Reference ${reference} was not found on the saved root sheet.`);
  if (matches.length > 32) throw new Error("Too many symbol units to focus safely.");
  const values = matches.map(node => children(node, "property").find(p => p[1] === "Value")?.[2] ?? "");
  if (new Set(values).size !== 1) throw new Error("Ambiguous component reference; its saved units disagree.");
  const points = matches.map(node => {
    const at = children(node, "at")[0], unit = Number(children(node, "unit")[0]?.[1] ?? 1);
    const x = Number(at?.[1]), y = Number(at?.[2]);
    if (instancePath && annotations(node).filter(path => path[1] === instancePath).length !== 1) throw new Error("Duplicate annotation paths make this native sheet instance ambiguous.");
    const instanceRefs = children(node, "instances").flatMap(n => JSON.stringify(n).match(/"reference","([^"\\]+)"/g) ?? []);
    if (!instancePath && instanceRefs.some(ref => ref !== `"reference","${reference}"`)) throw new Error("Instance-specific annotation is ambiguous; inspect this sheet in KiCad.");
    if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x > width || y > height || !Number.isInteger(unit) || unit < 1) throw new Error("Saved symbol anchor lies outside the verified page.");
    return { x, y, unit };
  });
  if (new Set(points.map(p => p.unit)).size !== points.length) throw new Error("Duplicate symbol units make this reference ambiguous.");
  return { value: String(values[0]), points, page: { width, height } };
}

export function verifySchematicFocusFrame(svg: string, page: { width: number; height: number }) {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const width = Number(/\bwidth="([\d.]+)mm"/.exec(root)?.[1]), height = Number(/\bheight="([\d.]+)mm"/.exec(root)?.[1]);
  const box = /\bviewBox="([^"<>]+)"/.exec(root)?.[1]?.trim().split(/\s+/).map(Number);
  if (!svg.includes("Image generated by Eeschema-SVG") || !box || box.length !== 4 || box[0] !== 0 || box[1] !== 0 || ![width, height, ...box].every(Number.isFinite) || Math.abs(width - page.width) > .05 || Math.abs(height - page.height) > .05 || Math.abs(box[2]! - width) > .001 || Math.abs(box[3]! - height) > .001) throw new Error("The native SVG does not preserve the inspected sheet's millimetre frame. No focus was requested.");
}

export async function focusSavedSchematic(reference: string, ctx: ToolContext, sheetIdentity?: string, expectedHierarchyRevision?: string) {
  const project = ctx.requireProject();
  if (!ctx.board && (await inspectProjectBoardSources(project)).mode !== "single") throw new ToolError("Choose a member board source before focusing its schematic.", "precondition");
  const cli = await requireKicad(ctx), sourcePath = await jailPath(project.dir, "board.kicad_sch"), projectFile = await jailPath(project.dir, "board.kicad_pro");
  const hierarchy = await ctx.services.kicad.inspectSchematicHierarchy(cli, { projectDir: project.dir, rootSchematic: sourcePath, ownedFilesOnly: true, ...(await exists(projectFile) ? { projectFile } : {}), signal: ctx.signal });
  if (!hierarchy.complete || !hierarchy.sheets.length || hierarchy.sheets.length > 256) throw new ToolError("Focus needs a complete bounded native schematic hierarchy. Inspect and resolve its missing sheets first.", "precondition");
  if (expectedHierarchyRevision && hierarchy.aggregateRevision !== expectedHierarchyRevision) throw new ToolError("The schematic hierarchy changed after these choices were shown. Locate the component again.", "precondition");
  if (sheetIdentity && !hierarchy.sheets.some(sheet => sheet.identity === sheetIdentity)) throw new ToolError("The selected sheet instance is not in this inspected hierarchy.", "precondition");
  const candidates: Array<{ sheet: typeof hierarchy.sheets[number]; anchors: ReturnType<typeof schematicFocusAnchors> }> = [];
  for (const sheet of hierarchy.sheets.filter(sheet => !sheetIdentity || sheet.identity === sheetIdentity)) {
    const bytes = await readFile(await jailPath(project.dir, sheet.nativePath));
    if (hash(bytes) !== sheet.sha256) throw new ToolError("Schematic changed after inspection. Inspect it again.", "precondition");
    try { candidates.push({ sheet, anchors: schematicFocusAnchors(bytes.toString("utf8"), reference, sheet.symbolInstancePath) }); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("was not found")) throw error; }
  }
  const candidate = candidates[0];
  if (candidates.length > 1) {
    if (ctx.board) await ctx.runInScope!(async () => {});
    const focusChoices = SchematicFocusChoices.parse({ projectId: project.id, reference, ...(ctx.board ? { board: { ...ctx.board } } : {}), expectedHierarchyRevision: hierarchy.aggregateRevision,
      sheets: candidates.map(row => ({ identity: row.sheet.identity, hierarchyPath: row.sheet.hierarchyPath, sourcePath: row.sheet.nativePath })) });
    return ok(`Reference ${reference} appears in ${candidates.length} saved sheet instances. Choose the intended sheet; no canvas navigation was requested.`, { focusChoices });
  }
  if (!candidate) throw new ToolError(`Reference ${reference} was not found in this source’s saved schematic instances.`, "precondition");
  const { sheet, anchors } = candidate;
  ctx.progress(.2, "rendering the exact saved sheet instance");
  const exported = sheet.pageNumber
    ? await ctx.services.kicad.exportOwnedSchematicPage(cli, { projectDir: project.dir, hierarchy, sheetIdentity: sheet.identity, signal: ctx.signal })
    : hierarchy.sheets.length === 1 && !ctx.board
      ? await ctx.services.kicad.exportOwnedSchematicSvg(cli, { projectDir: project.dir, hierarchy, signal: ctx.signal })
      : null;
  if (!exported) throw new ToolError("KiCad did not identify a unique page for this native sheet instance. No navigation was requested.", "precondition");
  if (exported.sourceRevision !== hierarchy.aggregateRevision || exported.sheets.length !== 1) throw new ToolError("Schematic changed during focus rendering. No navigation was requested.", "precondition");
  const expectedFiles = new Set([...hierarchy.referencedFiles, ...(hierarchy.projectFile ? [hierarchy.projectFile] : [])]);
  if (exported.sourceFiles.length !== expectedFiles.size || exported.sourceFiles.some(file => !expectedFiles.delete(file.path)) || expectedFiles.size) throw new ToolError("Focus rendering did not bind every native source file.", "precondition");
  for (const file of exported.sourceFiles) if (hash(await readFile(await jailPath(project.dir, file.path))) !== file.sha256) throw new ToolError("Schematic changed during focus rendering. No navigation was requested.", "precondition");
  const svg = exported.sheets[0]!.svg; verifySchematicFocusFrame(new TextDecoder().decode(svg), anchors.page);
  const svgSha256 = hash(svg), svgPath = `.fabdesk/canvas-focus/${svgSha256}.svg`;
  const prefix = ctx.board && ctx.boardRoot ? relative(ctx.boardRoot.dir, project.dir).split(sep).join("/") : "";
  if (ctx.board && (!ctx.boardRoot || prefix === ".." || prefix.startsWith("../") || prefix.startsWith("/"))) throw new ToolError("The member schematic is not owned by this project.", "precondition");
  const qualify = (path: string) => prefix ? `${prefix}/${path}` : path;
  if (ctx.board) await ctx.runInScope!(async () => {});
  ctx.signal.throwIfAborted(); await writeAtomic(await jailPath(project.dir, svgPath), svg);
  const focus = SchematicFocus.parse({ id: randomUUID(), projectId: project.id, requestedAt: Date.now(), reference,
    sourcePath: qualify(sheet.nativePath), sourceSha256: sheet.sha256, svgPath: qualify(svgPath), svgSha256, ...anchors,
    ...(ctx.board ? { board: { ...ctx.board } } : {}),
    sheet: { identity: sheet.identity, hierarchyPath: sheet.hierarchyPath, ...(sheet.pageNumber ? { pageNumber: sheet.pageNumber } : {}) },
    sourceFiles: exported.sourceFiles.map(file => ({ ...file, path: qualify(file.path) })),
  });
  if (ctx.board) await ctx.runInScope!(async () => {});
  ctx.services.bus.emit({ topic: "project.schematic_focus", ts: Date.now(), focus }); ctx.progress(1, "navigation requested");
  return ok(`Located ${reference} (${anchors.value}) on ${sheet.hierarchyPath} and requested canvas focus. Display is not confirmed: a connected client must verify the board, source hierarchy and preview bytes. This does not run ERC or PCB parity.`, { focus, display: "requested-not-confirmed" });
}
