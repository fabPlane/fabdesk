/** Load and save git-native `fabplane.connections.json`, and resolve links against current boards. */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ASSEMBLY_MANIFEST_PATH,
  MECHANICAL_DESIGN_PATH,
  MechanicalDesignSchema,
  PART_LINKS_FILE,
  PartLinksFile,
  ProjectAssembly,
  emptyPartLinksFile,
  type DeclaredConnection,
  type PartBaseline,
  type PartEndpoint,
  type PartLink,
  type PartLinkList,
  type PartLinkState,
  type PartLinkSuggestion,
  type ResolvedPartLink,
  type SharedNet,
} from "@fabdesk/protocol";
import { normalizeBoardOrigin, type BoardSnapshot, type ComponentSnapshot } from "@fabdesk/board-diff";
import { BOARD_WORKTREE_REF, parseBoard, readBoardRevision } from "./board-history";
import { exists, jailPath, writeJson } from "./fs";
import { ToolError, type ProjectHandle } from "./registry";

const POSITION_TOLERANCE_MM = 0.05;
const ROTATION_TOLERANCE_DEG = 0.5;
const CONNECTOR_REF = /^(?:J|P|CN|CON|X|FPC|USB|HDMI)\d/i;
/** KiCad's generated names repeat one board's own reference, so they say nothing across boards. */
const GENERATED_NET = /^(?:Net-\(|unconnected-|N\$|\/?$)/;
const POWER_NET = /^\/?(?:GND\w*|AGND|DGND|VSS\w*|VDD\w*|VCC\w*|\+?\d+V\d*\w*|VBUS\w*)$/i;

export async function partLinksPath(project: ProjectHandle): Promise<string> {
  return jailPath(project.dir, PART_LINKS_FILE);
}

export async function loadPartLinks(project: ProjectHandle): Promise<PartLinksFile> {
  const path = await partLinksPath(project);
  if (!(await exists(path))) return emptyPartLinksFile();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new ToolError(`${PART_LINKS_FILE} is not valid JSON`, "precondition");
  }
  const parsed = PartLinksFile.safeParse(raw);
  if (!parsed.success) {
    throw new ToolError(`${PART_LINKS_FILE} does not match its contract: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "precondition");
  }
  return parsed.data;
}

const locks = new Map<string, Promise<unknown>>();

/** HTTP and MCP writers share one daemon, so one lock per file prevents lost updates. */
export async function updatePartLinks<T>(project: ProjectHandle, mutate: (file: PartLinksFile) => Promise<{ file: PartLinksFile; result: T }>): Promise<T> {
  const key = await partLinksPath(project);
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const { file, result } = await mutate(await loadPartLinks(project));
    await writeJson(key, PartLinksFile.parse(file));
    return result;
  });
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

export const newPartLinkId = () => `lnk_${randomBytes(6).toString("hex")}`;

export function samePartLink(link: { a: PartEndpoint; b: PartEndpoint }, a: PartEndpoint, b: PartEndpoint): boolean {
  const same = (x: PartEndpoint, y: PartEndpoint) => x.boardPath === y.boardPath && x.ref === y.ref;
  return (same(link.a, a) && same(link.b, b)) || (same(link.a, b) && same(link.b, a));
}

export function partBaseline(component: ComponentSnapshot): PartBaseline {
  return {
    ...(component.footprint ? { footprint: component.footprint } : {}),
    ...(component.layer ? { layer: component.layer } : {}),
    ...(component.x !== undefined ? { x: component.x } : {}),
    ...(component.y !== undefined ? { y: component.y } : {}),
    ...(component.rotation !== undefined ? { rotation: component.rotation } : {}),
    pads: (component.pads ?? []).map((pad) => `${pad.pin}:${pad.net ?? ""}`).sort(),
  };
}

/** Only changes to the linked part need review; unrelated edits on the same board do not. */
export function baselineChanges(baseline: PartBaseline, current: ComponentSnapshot): string[] {
  const now = partBaseline(current), reasons: string[] = [];
  if (baseline.footprint !== now.footprint) reasons.push("footprint changed");
  if (baseline.layer !== now.layer) reasons.push("moved to another side");
  if (JSON.stringify(baseline.pads) !== JSON.stringify(now.pads)) reasons.push("pins or nets changed");
  if (baseline.x !== undefined && now.x !== undefined && baseline.y !== undefined && now.y !== undefined && Math.hypot(now.x - baseline.x, now.y - baseline.y) > POSITION_TOLERANCE_MM) reasons.push("moved on the board");
  if (Math.abs((baseline.rotation ?? 0) - (now.rotation ?? 0)) > ROTATION_TOLERANCE_DEG) reasons.push("rotated");
  return reasons;
}

/** Shared by name only. A match suggests a relationship; it does not verify a pin mapping. */
export function sharedNets(a: ComponentSnapshot, b: ComponentSnapshot): SharedNet[] {
  const byNet = new Map<string, string>();
  for (const pad of b.pads ?? []) if (pad.net && !GENERATED_NET.test(pad.net) && !byNet.has(pad.net)) byNet.set(pad.net, pad.pin);
  const seen = new Set<string>(), out: SharedNet[] = [];
  for (const pad of a.pads ?? []) {
    const bPin = pad.net ? byNet.get(pad.net) : undefined;
    if (!pad.net || bPin === undefined || seen.has(pad.net)) continue;
    seen.add(pad.net);
    out.push({ net: pad.net, aPin: pad.pin, bPin });
  }
  return out;
}

export async function currentBoard(project: ProjectHandle, boardPath: string, signal?: AbortSignal): Promise<BoardSnapshot | null> {
  try {
    const revision = await readBoardRevision(project, boardPath, BOARD_WORKTREE_REF, signal);
    return normalizeBoardOrigin(parseBoard(revision.text, revision.sha256));
  } catch (error) {
    if (error instanceof ToolError && error.code === "not_found") return null;
    throw error;
  }
}

export async function resolvePartLinks(project: ProjectHandle, links: PartLink[], signal?: AbortSignal): Promise<ResolvedPartLink[]> {
  const boards = new Map<string, BoardSnapshot | null>();
  const board = async (path: string) => {
    if (!boards.has(path)) boards.set(path, await currentBoard(project, path, signal));
    return boards.get(path)!;
  };
  return Promise.all(links.map(async (link) => {
    const [boardA, boardB] = [await board(link.a.boardPath), await board(link.b.boardPath)];
    const partA = boardA?.components.find((c) => c.ref === link.a.ref), partB = boardB?.components.find((c) => c.ref === link.b.ref);
    const reasons: string[] = [];
    if (!boardA) reasons.push(`${link.a.boardPath} is missing`);
    else if (!partA) reasons.push(`${link.a.ref} is no longer on its board`);
    if (!boardB) reasons.push(`${link.b.boardPath} is missing`);
    else if (!partB) reasons.push(`${link.b.ref} is no longer on its board`);
    const missing = reasons.length > 0;
    if (partA) reasons.push(...baselineChanges(link.baseline.a, partA).map((reason) => `${link.a.ref}: ${reason}`));
    if (partB) reasons.push(...baselineChanges(link.baseline.b, partB).map((reason) => `${link.b.ref}: ${reason}`));
    const state: PartLinkState = missing ? "missing" : reasons.length ? "needs-review" : "current";
    return { ...link, state, reasons, sharedNets: partA && partB ? sharedNets(partA, partB) : [] };
  }));
}

/** Connections other features already declare stay owned by them and appear here read-only. */
export async function declaredConnections(project: ProjectHandle): Promise<DeclaredConnection[]> {
  const out: DeclaredConnection[] = [];
  const read = async (name: string): Promise<unknown> => {
    const path = await jailPath(project.dir, name);
    if (!(await exists(path))) return null;
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      return null;
    }
  };
  const design = MechanicalDesignSchema.safeParse(await read(MECHANICAL_DESIGN_PATH));
  if (design.success) {
    for (const connection of design.data.connections ?? []) {
      out.push({ id: `mechanical:${connection.id}`, source: "mechanical", a: connection.from, b: connection.to });
    }
  }
  const assembly = ProjectAssembly.safeParse(await read(ASSEMBLY_MANIFEST_PATH));
  if (assembly.success) {
    const pathFor = (instanceId: string) => {
      const sourceId = assembly.data.instances.find((instance) => instance.id === instanceId)?.sourceId;
      const source = assembly.data.sources.find((row) => row.id === sourceId);
      if (source?.location !== "project") return null;
      return source.directory === "." ? "board.kicad_pcb" : `${source.directory}/board.kicad_pcb`;
    };
    for (const connection of assembly.data.connections) {
      const boardA = pathFor(connection.a.instanceId), boardB = pathFor(connection.b.instanceId);
      if (boardA && boardB) out.push({ id: `assembly:${connection.id}`, source: "assembly", name: connection.name, a: { boardPath: boardA, ref: connection.a.connector }, b: { boardPath: boardB, ref: connection.b.connector } });
    }
  }
  return out;
}

export async function listPartLinks(project: ProjectHandle, signal?: AbortSignal): Promise<PartLinkList> {
  const file = await loadPartLinks(project);
  return { links: await resolvePartLinks(project, file.links, signal), declared: await declaredConnections(project) };
}

/** Rank part pairs by named nets in common, connectors and signal nets first. */
export function suggestPartLinks(boardAPath: string, boardA: BoardSnapshot, boardBPath: string, boardB: BoardSnapshot, limit: number): PartLinkSuggestion[] {
  const rows: Array<PartLinkSuggestion & { score: number }> = [];
  for (const a of boardA.components) {
    for (const b of boardB.components) {
      const nets = sharedNets(a, b);
      if (!nets.length) continue;
      const connectors = CONNECTOR_REF.test(a.ref) && CONNECTOR_REF.test(b.ref);
      const signal = nets.filter((net) => !POWER_NET.test(net.net)).length;
      // A rail like GND reaches most parts on both boards, so one alone suggests nothing. Two or
      // more rails between connectors can still be a real power cable.
      if (!signal && !(connectors && nets.length > 1)) continue;
      rows.push({ a: { boardPath: boardAPath, ref: a.ref }, b: { boardPath: boardBPath, ref: b.ref }, sharedNets: nets, connectors, score: (connectors ? 1000 : 0) + signal * 10 + nets.length });
    }
  }
  return rows.sort((x, y) => y.score - x.score).slice(0, limit).map(({ score: _score, ...row }) => row);
}
