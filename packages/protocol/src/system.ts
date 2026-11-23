import type { NetlistFile } from "./fp-pcb";
import { atom, child, children, parseSexpr, property, type List } from "./system-kicad";

export const BLOCK_KINDS = ["power", "mcu", "io", "sensors", "motor", "rf", "other", "passives"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export type DesignPart = {
  ref: string;
  value: string;
  footprint?: string;
  libId?: string;
  sheet?: string;
};

export type DesignNode = { ref: string; pin?: string };
export type DesignNet = { name: string; nodes: DesignNode[] };
export type DesignSheet = { name: string; file?: string };
export type DesignGraph = { parts: DesignPart[]; nets: DesignNet[]; sheets: DesignSheet[] };

export type SystemPart = {
  ref: string;
  value: string;
  role: "key" | "passive" | "clock" | "ignored";
  kind: BlockKind;
};

export type SystemBlock = {
  id: string;
  name: string;
  kind: BlockKind;
  source: "sheet" | "heuristic";
  parts: SystemPart[];
  keyParts: SystemPart[];
  passiveSummary: string;
};

export type SystemEdge = {
  from: string;
  to: string;
  kind: "power" | "bus" | "net";
  labels: string[];
};

export type LaidOutBlock = SystemBlock & { x: number; y: number; w: number; h: number };
export type LaidOutEdge = SystemEdge & { path: string; labelX: number; labelY: number };
export type SystemDiagram = { blocks: LaidOutBlock[]; edges: LaidOutEdge[]; width: number; height: number };

export type DesignSources = {
  netlist?: NetlistFile;
  pcbText?: string;
  schematics?: Array<{ name: string; text: string }>;
};

const ROOT_SHEETS = new Set(["", "/", "root", "racine"]);
const IGNORED_PREFIX = /^(#|LOGO|H|MH|FID|TP)/i;
const PASSIVE_PREFIX = /^(R|C|L|FB|BEAD|RN|RT)$/i;
const CONNECTOR_PREFIX = /^(J|CON|CONN|USB|HDMI|P)$/i;
const MCU_PREFIX = /^(U|IC|MCU|ESP|STM)$/i;

export function refPrefix(ref: string): string {
  return ref.replace(/[^A-Za-z].*$/, "").toUpperCase();
}

export function normalizeSheet(name: string | undefined): string {
  const trimmed = (name ?? "").replace(/^\/+|\/+$/g, "").trim();
  return trimmed;
}

export function isRootSheet(name: string | undefined): boolean {
  return ROOT_SHEETS.has(normalizeSheet(name).toLowerCase());
}

function blobOf(part: Pick<DesignPart, "ref" | "value" | "footprint" | "libId">): string {
  return `${part.ref} ${part.value} ${part.footprint ?? ""} ${part.libId ?? ""}`.toLowerCase();
}

export function classifyPart(part: DesignPart): SystemPart {
  const prefix = refPrefix(part.ref);
  const blob = blobOf(part);
  const base = { ref: part.ref, value: part.value };
  if (!part.ref || IGNORED_PREFIX.test(part.ref) || /logo/.test(blob)) {
    return { ...base, role: "ignored", kind: "other" };
  }
  if (prefix === "Y" || prefix === "XTAL" || (prefix === "X" && /crystal|oscillator|resonator|xtal/.test(blob)) || (/crystal|resonator|oscillator/.test(blob) && prefix !== "J")) {
    return { ...base, role: "clock", kind: "mcu" };
  }
  if (/(ldo|regulator|vreg|buck|boost|dcdc|dc-dc|7805|7803|1117|ams1117|ap2112|tps\d|mp23|lt137|xl6009|mic5205|load.?switch|slg5)/.test(blob)) {
    return { ...base, role: "key", kind: "power" };
  }
  if (prefix === "F" || prefix === "RV" || /fuse|polyfuse|tvs|esd.?diod/.test(blob)) {
    return { ...base, role: "key", kind: "power" };
  }
  if (/(drv88|drv83|a4950|tmc220|tmc2|l298|tb66|stepper|h-bridge|motor.?driver)/.test(blob)) {
    return { ...base, role: "key", kind: "motor" };
  }
  if (/(nrf24|nrf52|cc110|cc135|sx127|sx126|lora|rfm9|antenna)/.test(blob) || prefix === "ANT") {
    return { ...base, role: "key", kind: "rf" };
  }
  if (/(bme280|bmp280|mpu605|imu|sht3|sht4|lis3|lsm6|vl53|ina219|ads111|accelerometer|gyroscope|thermistor|sensor)/.test(blob)) {
    return { ...base, role: "key", kind: "sensors" };
  }
  if (/(stm32|rp2040|esp32|esp8266|nrf52|pic1|pic2|atmega|attiny|samd|gd32|ch32|ra4m|imxrt|zynq|fpga|microcontroller|\bmcu\b|\bsoc\b)/.test(blob)) {
    return { ...base, role: "key", kind: "mcu" };
  }
  if (/(usb.?hub|xr224|fe1\.1|gl850|usb251|usb3300|hub.?controller)/.test(blob)) {
    return { ...base, role: "key", kind: "mcu" };
  }
  if (CONNECTOR_PREFIX.test(prefix) || /connector|header|socket|jack|jst|usb|db9|de-9/.test(blob)) {
    return { ...base, role: "key", kind: "io" };
  }
  if (prefix === "SW" || prefix === "BTN" || prefix === "K" || /switch|button|relay/.test(blob) && prefix !== "R") {
    return { ...base, role: "key", kind: "io" };
  }
  if (PASSIVE_PREFIX.test(prefix) || prefix === "D" || prefix === "LED" || prefix === "Q") {
    const kind: BlockKind = prefix === "D" && /led/.test(blob) ? "io" : prefix === "Q" ? "other" : "passives";
    const role = prefix === "Q" || (prefix === "D" && /led/.test(blob)) ? "key" : "passive";
    return { ...base, role, kind };
  }
  if (MCU_PREFIX.test(prefix)) return { ...base, role: "key", kind: "other" };
  return { ...base, role: "key", kind: "other" };
}

function decodeKiCadNet(name: string): string {
  return name.replace(/\{slash\}/gi, "/").replace(/\{backslash\}/gi, "\\");
}

function netLeaf(name: string): string {
  const decoded = decodeKiCadNet(name).replace(/^\/+/, "");
  const sheet = decoded.match(/^([A-Za-z][\w.-]*)\/(.+)$/);
  const prefix = sheet?.[1];
  const rest = sheet?.[2];
  if (prefix && rest && !/^(VPP|VCC|VDD|VIN|USB|I2C|SPI|UART|CAN|SWD)$/i.test(prefix)) return rest;
  return decoded;
}

export function notableNet(name: string): { kind: "power" | "bus" | "net"; label: string } | null {
  const raw = name.trim();
  if (!raw || raw === '""' || /^unconnected/i.test(raw)) return null;
  const leaf = netLeaf(raw);
  const n = leaf.toUpperCase();
  if (/^(GND|AGND|DGND|PGND|VSS|VSSA|GNDA|GNDD)$/.test(n)) return null;
  if (/^(VIN|VCC|VDD|VBAT|VBUS|VPP|VSYS)(_[A-Z0-9]+)?$/.test(n) || /^(3V3|3\.3V|5V|1V8|1\.8V|\+3V3|\+5V|\+1V8|\+3\.3V)$/.test(n) || /^\+?\d+(?:\.\d+)?V/.test(n) || /\b(3V3|5V|1V8|3\.3V|1\.8V)\b/.test(n)) {
    return { kind: "power", label: prettyRail(leaf) };
  }
  if (/SDA|SCL|I2C/.test(n)) return { kind: "bus", label: "I2C" };
  if (/\bMOSI\b|\bMISO\b|\bSCK\b|\bSCLK\b|\bSPI\b|\bCS#?\b|\bNSS\b/.test(n)) return { kind: "bus", label: "SPI" };
  if (/\bTX\b|\bRX\b|UART|USART/.test(n)) return { kind: "bus", label: "UART" };
  if (/\bD\+|\bD-|\bDP\b|\bDM\b|USB|U\d+D[+-]/.test(n) || /U\d+D[+-]$/.test(n)) return { kind: "bus", label: "USB" };
  if (/CAN_H|CAN_L|CANH|CANL/.test(n)) return { kind: "bus", label: "CAN" };
  if (/SWDIO|SWCLK|\bSWD\b/.test(n)) return { kind: "bus", label: "SWD" };
  if (/^NET[-(]|\/NET-|N\d+$/.test(n)) return null;
  if (leaf.length < 2) return null;
  return { kind: "net", label: leaf };
}

export function prettyRail(name: string): string {
  const n = netLeaf(name);
  if (/\+?3V3|3\.3V/i.test(n)) return "3.3V";
  if (/\+?1V8|1\.8V/i.test(n)) return "1.8V";
  if (/\+?5V(?:\b|$)/i.test(n)) return "5V";
  const m = n.match(/(\d+(?:\.\d+)?)\s*V\b/i);
  if (m) return `${m[1]}V`;
  return n;
}

export function designGraphFromNetlist(file: NetlistFile): DesignGraph {
  return {
    parts: file.netlist.components.map((c) => ({
      ref: c.ref,
      value: c.value,
      ...(c.footprint ? { footprint: c.footprint } : {}),
      ...(c.libSource ? { libId: `${c.libSource.lib}:${c.libSource.part}` } : {}),
    })),
    nets: file.netlist.nets.map((net) => ({
      name: net.name,
      nodes: net.nodes.map((node) => ({ ref: node.ref, ...(node.pin ? { pin: node.pin } : {}) })),
    })),
    sheets: [],
  };
}

export function designGraphFromPcb(text: string): DesignGraph {
  const root = parseSexpr(text, "kicad_pcb");
  const parts: DesignPart[] = [];
  const nodesByNet = new Map<string, DesignNode[]>();
  for (const fp of [...children(root, "footprint"), ...children(root, "module")]) {
    const ref = property(fp, "Reference") || String(children(fp, "fp_text").find((n) => n[1] === "reference")?.[2] ?? "");
    if (!ref) continue;
    const value = property(fp, "Value");
    const sheet = atom(fp, "sheetname");
    const libId = typeof fp[1] === "string" ? fp[1] : "";
    parts.push({
      ref,
      value,
      ...(libId ? { footprint: libId, libId } : {}),
      ...(!isRootSheet(sheet) && sheet ? { sheet: normalizeSheet(sheet) } : {}),
    });
    for (const pad of children(fp, "pad")) {
      const name = padNetName(child(pad, "net"));
      if (!name) continue;
      const pin = typeof pad[1] === "string" ? pad[1] : undefined;
      const list = nodesByNet.get(name) ?? [];
      list.push({ ref, ...(pin ? { pin } : {}) });
      nodesByNet.set(name, list);
    }
  }
  return {
    parts,
    nets: [...nodesByNet.entries()].map(([name, nodes]) => ({ name, nodes })),
    sheets: uniqueSheets(parts),
  };
}

export function designGraphFromSchematic(text: string, sheetName = "root"): DesignGraph {
  const root = parseSexpr(text, "kicad_sch");
  const parts: DesignPart[] = [];
  const sheets: DesignSheet[] = [];
  for (const sym of children(root, "symbol")) {
    const ref = property(sym, "Reference");
    if (!ref) continue;
    const value = property(sym, "Value");
    const footprint = property(sym, "Footprint");
    const libId = atom(sym, "lib_id");
    parts.push({
      ref,
      value,
      ...(footprint ? { footprint } : {}),
      ...(libId ? { libId } : {}),
      ...(!isRootSheet(sheetName) ? { sheet: normalizeSheet(sheetName) } : {}),
    });
  }
  for (const sheet of children(root, "sheet")) {
    const name = property(sheet, "Sheetname") || property(sheet, "Sheet name");
    const file = property(sheet, "Sheetfile") || property(sheet, "Sheet file");
    if (!name && !file) continue;
    sheets.push({ name: name || file, ...(file ? { file } : {}) });
  }
  return { parts, nets: [], sheets };
}

export function mergeDesignGraphs(graphs: DesignGraph[]): DesignGraph {
  const parts = new Map<string, DesignPart>();
  const nets = new Map<string, Map<string, DesignNode>>();
  const sheets = new Map<string, DesignSheet>();
  for (const graph of graphs) {
    for (const part of graph.parts) {
      const prev = parts.get(part.ref);
      parts.set(part.ref, prev ? { ...prev, ...part, ...(prev.sheet && !part.sheet ? { sheet: prev.sheet } : {}) } : part);
    }
    for (const net of graph.nets) {
      const nodes = nets.get(net.name) ?? new Map<string, DesignNode>();
      for (const node of net.nodes) nodes.set(`${node.ref}/${node.pin ?? ""}`, node);
      nets.set(net.name, nodes);
    }
    for (const sheet of graph.sheets) sheets.set(normalizeSheet(sheet.name).toLowerCase() || sheet.file || sheet.name, sheet);
  }
  return {
    parts: [...parts.values()],
    nets: [...nets.entries()].map(([name, nodes]) => ({ name, nodes: [...nodes.values()] })),
    sheets: [...sheets.values()],
  };
}

function sheetFileStem(file: string | undefined): string {
  return normalizeSheet((file ?? "").replace(/\.kicad_sch$/i, "")).toLowerCase();
}

export function designGraphFromSources(sources: DesignSources): DesignGraph {
  const graphs: DesignGraph[] = [];
  if (sources.netlist) graphs.push(designGraphFromNetlist(sources.netlist));
  if (sources.pcbText) graphs.push(designGraphFromPcb(sources.pcbText));
  const schematics = sources.schematics ?? [];
  const childNames = new Set<string>();
  for (const sch of schematics) {
    const parsed = designGraphFromSchematic(sch.text, "root");
    for (const sheet of parsed.sheets) {
      childNames.add(normalizeSheet(sheet.name).toLowerCase());
      const stem = sheetFileStem(sheet.file);
      if (stem) childNames.add(stem);
    }
  }
  for (const sch of schematics) {
    const isChild = childNames.has(normalizeSheet(sch.name).toLowerCase()) || childNames.has(sheetFileStem(sch.name));
    graphs.push(designGraphFromSchematic(sch.text, isChild ? sch.name : "root"));
  }
  if (graphs.length === 0) return { parts: [], nets: [], sheets: [] };
  return mergeDesignGraphs(graphs);
}

/** KiCad 6+ uses `(net 4 "VCC")`; later boards omit the numeric id: `(net "VCC")`. */
export function padNetName(net: List | undefined): string {
  if (!net) return "";
  if (typeof net[2] === "string" && net[2]) return net[2];
  if (typeof net[1] === "string" && net[1] && !/^\d+$/.test(net[1])) return net[1];
  return "";
}

function uniqueSheets(parts: DesignPart[]): DesignSheet[] {
  const names = new Set<string>();
  for (const part of parts) {
    const sheet = normalizeSheet(part.sheet);
    if (sheet && !isRootSheet(sheet)) names.add(sheet);
  }
  return [...names].map((name) => ({ name }));
}

function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return s || "block";
}

function uniqueId(used: Set<string>, base: string): string {
  let id = slug(base);
  let n = 2;
  while (used.has(id)) id = `${slug(base)}-${n++}`;
  used.add(id);
  return id;
}

function prettySheetName(name: string): string {
  const cleaned = normalizeSheet(name).replace(/[_-]+/g, " ").trim();
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase()) || "Sheet";
}

function kindLabel(kind: BlockKind): string {
  return {
    power: "Power",
    mcu: "MCU / processor",
    io: "Connectors / IO",
    sensors: "Sensors",
    motor: "Motor drivers",
    rf: "RF",
    other: "Logic",
    passives: "Passives",
  }[kind];
}

function passiveSummary(parts: SystemPart[]): string {
  const counts = new Map<string, number>();
  for (const part of parts.filter((p) => p.role === "passive")) {
    const prefix = refPrefix(part.ref) || "?";
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([prefix, n]) => `${n}× ${prefix}`)
    .join(" · ");
}

function blockName(kind: BlockKind, keys: SystemPart[], source: SystemBlock["source"], sheet?: string): string {
  if (source === "sheet" && sheet) return prettySheetName(sheet);
  if (keys.length === 1) return keys[0]!.value || keys[0]!.ref;
  if (kind === "mcu" && keys.length <= 3) return keys.map((p) => p.value || p.ref).join(" / ");
  return kindLabel(kind);
}

function keyRank(part: SystemPart): number {
  const prefix = refPrefix(part.ref);
  if (/^(U|IC|MCU|ESP|STM)$/.test(prefix)) return 0;
  if (CONNECTOR_PREFIX.test(prefix) || prefix === "Q") return 1;
  if (part.role === "clock") return 2;
  return 3;
}

function makeBlock(id: string, kind: BlockKind, source: SystemBlock["source"], members: SystemPart[], sheet?: string): SystemBlock {
  const keys = members.filter((p) => p.role === "key" || p.role === "clock").sort((a, b) => keyRank(a) - keyRank(b) || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  const parts = [...members].sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  return {
    id,
    name: blockName(kind, keys, source, sheet),
    kind,
    source,
    parts,
    keyParts: keys.slice(0, 8),
    passiveSummary: passiveSummary(parts),
  };
}

function isPowerOrGnd(name: string): boolean {
  const n = name.replace(/^\/+/, "").toUpperCase();
  return /^(GND|AGND|DGND|PGND|VSS|VSSA)$/.test(n) || notableNet(name)?.kind === "power";
}

export function groupSystemBlocks(graph: DesignGraph): SystemBlock[] {
  const classified = graph.parts.map(classifyPart).filter((p) => p.role !== "ignored");
  const byRef = new Map(classified.map((p) => [p.ref, p]));
  const assigned = new Set<string>();
  const used = new Set<string>();
  const blocks: SystemBlock[] = [];
  const sheetMembers = new Map<string, SystemPart[]>();

  for (const part of graph.parts) {
    const classifiedPart = byRef.get(part.ref);
    const sheet = normalizeSheet(part.sheet);
    if (!classifiedPart || !sheet || isRootSheet(sheet)) continue;
    const list = sheetMembers.get(sheet) ?? [];
    list.push(classifiedPart);
    sheetMembers.set(sheet, list);
  }
  for (const [sheet, members] of [...sheetMembers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const unique = [...new Map(members.map((p) => [p.ref, p])).values()];
    if (unique.length < 2) continue;
    const kinds = unique.filter((p) => p.role === "key").map((p) => p.kind);
    const kind = kinds.sort((a, b) => kinds.filter((k) => k === b).length - kinds.filter((k) => k === a).length)[0] ?? "other";
    blocks.push(makeBlock(uniqueId(used, sheet), kind, "sheet", unique, sheet));
    for (const part of unique) assigned.add(part.ref);
  }

  const rest = classified.filter((p) => !assigned.has(p.ref));
  const keys = rest.filter((p) => p.role === "key");
  const clocks = rest.filter((p) => p.role === "clock");
  const passives = rest.filter((p) => p.role === "passive");
  const byKind = new Map<BlockKind, SystemPart[]>();
  for (const part of keys) {
    const list = byKind.get(part.kind) ?? [];
    list.push(part);
    byKind.set(part.kind, list);
  }
  for (const kind of BLOCK_KINDS) {
    const members = byKind.get(kind);
    if (!members?.length) continue;
    blocks.push(makeBlock(uniqueId(used, kindLabel(kind)), kind, "heuristic", members));
  }

  const netsOf = new Map<string, string[]>();
  for (const net of graph.nets) {
    for (const node of net.nodes) {
      const list = netsOf.get(node.ref) ?? [];
      list.push(net.name);
      netsOf.set(node.ref, list);
    }
  }
  const blockOf = new Map<string, SystemBlock>();
  for (const block of blocks) for (const part of block.parts) blockOf.set(part.ref, block);

  const attach = (part: SystemPart, preferNonPower = true) => {
    const names = netsOf.get(part.ref) ?? [];
    const signal = names.filter((n) => !isPowerOrGnd(n));
    const neighborRefs = new Set<string>();
    for (const net of graph.nets) {
      if (!(signal.length ? signal : names).includes(net.name)) continue;
      if (signal.length === 0 && isPowerOrGnd(net.name) === false) continue;
      for (const node of net.nodes) if (node.ref !== part.ref) neighborRefs.add(node.ref);
    }
    const neighborBlocks = [...new Set([...neighborRefs].map((ref) => blockOf.get(ref)).filter((b): b is SystemBlock => !!b))];
    let target = neighborBlocks.length === 1 ? neighborBlocks[0] : undefined;
    if (!target && preferNonPower) {
      const nonPower = neighborBlocks.filter((b) => b.kind !== "power");
      if (nonPower.length === 1) target = nonPower[0];
    }
    if (!target && names.every((n) => isPowerOrGnd(n))) target = blocks.find((b) => b.kind === "power");
    if (!target) return false;
    target.parts.push(part);
    target.parts.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
    if (part.role === "clock" || part.role === "key") {
      target.keyParts = [...target.keyParts, part].sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true })).slice(0, 8);
    }
    target.passiveSummary = passiveSummary(target.parts);
    blockOf.set(part.ref, target);
    return true;
  };

  const leftover: SystemPart[] = [];
  for (const clock of clocks) if (!attach(clock)) {
    const mcu = blocks.find((b) => b.kind === "mcu");
    if (mcu) {
      mcu.parts.push(clock);
      mcu.keyParts = [...mcu.keyParts, clock].slice(0, 8);
      mcu.passiveSummary = passiveSummary(mcu.parts);
      blockOf.set(clock.ref, mcu);
    } else leftover.push(clock);
  }
  for (const passive of passives) if (!attach(passive)) leftover.push(passive);
  if (leftover.length) blocks.push(makeBlock(uniqueId(used, "passives"), "passives", "heuristic", leftover));

  return blocks.filter((b) => b.parts.length > 0);
}

export function systemEdges(graph: DesignGraph, blocks: SystemBlock[]): SystemEdge[] {
  const blockOf = new Map<string, string>();
  for (const block of blocks) for (const part of block.parts) blockOf.set(part.ref, block.id);
  const grouped = new Map<string, SystemEdge>();
  for (const net of graph.nets) {
    const notable = notableNet(net.name);
    if (!notable) continue;
    const blockIds = [...new Set(net.nodes.map((n) => blockOf.get(n.ref)).filter((id): id is string => !!id))];
    if (blockIds.length < 2) continue;
    for (let i = 0; i < blockIds.length; i++) {
      for (let j = i + 1; j < blockIds.length; j++) {
        const a = blockIds[i]!;
        const b = blockIds[j]!;
        const [from, to] = a < b ? [a, b] : [b, a];
        const key = `${from}|${to}|${notable.kind}`;
        const edge = grouped.get(key) ?? { from, to, kind: notable.kind, labels: [] };
        if (!edge.labels.includes(notable.label)) edge.labels.push(notable.label);
        grouped.set(key, edge);
      }
    }
  }
  return [...grouped.values()].map((edge) => ({
    ...edge,
    labels: edge.labels.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 4),
  }));
}

const COL_FOR: Record<BlockKind, number> = {
  power: 0,
  mcu: 1,
  sensors: 2,
  motor: 2,
  rf: 2,
  other: 2,
  passives: 2,
  io: 3,
};

const BOX_W = 220;
const COL_GAP = 88;
const ROW_GAP = 28;
const PAD = 14;
const TITLE = 22;
const LINE = 16;

export function layoutSystemDiagram(blocks: SystemBlock[], edges: SystemEdge[]): SystemDiagram {
  const columns = new Map<number, SystemBlock[]>();
  for (const block of [...blocks].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
    const col = COL_FOR[block.kind];
    const list = columns.get(col) ?? [];
    list.push(block);
    columns.set(col, list);
  }
  const usedCols = [...columns.keys()].sort((a, b) => a - b);
  const colIndex = new Map(usedCols.map((col, i) => [col, i]));
  const laid: LaidOutBlock[] = [];
  let height = 48;
  for (const col of usedCols) {
    const list = columns.get(col) ?? [];
    let y = 36;
    const x = 36 + (colIndex.get(col) ?? 0) * (BOX_W + COL_GAP);
    for (const block of list) {
      const lines = Math.max(1, block.keyParts.length) + (block.passiveSummary ? 1 : 0);
      const h = PAD * 2 + TITLE + lines * LINE + 8;
      laid.push({ ...block, x, y, w: BOX_W, h });
      y += h + ROW_GAP;
    }
    height = Math.max(height, y);
  }
  const width = 36 + usedCols.length * (BOX_W + COL_GAP) - COL_GAP + 36;
  const byId = new Map(laid.map((b) => [b.id, b]));
  const laidEdges: LaidOutEdge[] = [];
  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const a = { x: from.x + from.w, y: from.y + from.h / 2 };
    const b = { x: to.x, y: to.y + to.h / 2 };
    if (from.x > to.x) {
      a.x = from.x;
      b.x = to.x + to.w;
    }
    const mid = (a.x + b.x) / 2;
    const path = `M ${a.x} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}`;
    laidEdges.push({ ...edge, path, labelX: (a.x + b.x) / 2, labelY: (a.y + b.y) / 2 - 6 });
  }
  return { blocks: laid, edges: laidEdges, width: Math.max(width, 320), height: Math.max(height, 180) };
}

export function buildSystemDiagram(graph: DesignGraph): SystemDiagram {
  const blocks = groupSystemBlocks(graph);
  return layoutSystemDiagram(blocks, systemEdges(graph, blocks));
}

export function formatSystemSummary(diagram: SystemDiagram): string {
  if (diagram.blocks.length === 0) return "No system blocks yet.";
  const lines = ["System blocks:"];
  for (const block of diagram.blocks) {
    const keys = block.keyParts.map((p) => `${p.ref}${p.value ? ` ${p.value}` : ""}`).join(", ");
    const extra = block.passiveSummary ? `; ${block.passiveSummary}` : "";
    lines.push(`- ${block.name} (${kindLabel(block.kind)}${block.source === "sheet" ? ", sheet" : ""}): ${keys || `${block.parts.length} parts`}${extra}`);
  }
  if (diagram.edges.length) {
    lines.push("Connections:");
    for (const edge of diagram.edges) {
      const from = diagram.blocks.find((b) => b.id === edge.from)?.name ?? edge.from;
      const to = diagram.blocks.find((b) => b.id === edge.to)?.name ?? edge.to;
      lines.push(`- ${from} — ${edge.labels.join(", ") || edge.kind} → ${to}`);
    }
  }
  return lines.join("\n");
}

export function buildSystemDiagramFromSources(sources: DesignSources): SystemDiagram {
  return buildSystemDiagram(designGraphFromSources(sources));
}
