import {
  emptySnapshot,
  type BoardSnapshot,
  type ComponentSnapshot,
  type NetSnapshot,
  type TrackSnapshot,
  type ViaSnapshot,
  type ZoneSnapshot,
} from "./types";

function pickDefined<T>(primary: T | undefined, fallback: T | undefined): T | undefined {
  return primary !== undefined ? primary : fallback;
}

function mergeComponent(base: ComponentSnapshot | undefined, next: ComponentSnapshot): ComponentSnapshot {
  const value = pickDefined(next.value, base?.value);
  const footprint = pickDefined(next.footprint, base?.footprint);
  const libId = pickDefined(next.libId, base?.libId);
  const x = pickDefined(next.x, base?.x);
  const y = pickDefined(next.y, base?.y);
  const rotation = pickDefined(next.rotation, base?.rotation);
  const layer = pickDefined(next.layer, base?.layer);
  const schX = pickDefined(next.schX, base?.schX);
  const schY = pickDefined(next.schY, base?.schY);
  const schRotation = pickDefined(next.schRotation, base?.schRotation);
  const pads = pickDefined(next.pads, base?.pads);
  return {
    ref: next.ref,
    ...(value !== undefined ? { value } : {}),
    ...(footprint !== undefined ? { footprint } : {}),
    ...(libId !== undefined ? { libId } : {}),
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(rotation !== undefined ? { rotation } : {}),
    ...(layer !== undefined ? { layer } : {}),
    ...(schX !== undefined ? { schX } : {}),
    ...(schY !== undefined ? { schY } : {}),
    ...(schRotation !== undefined ? { schRotation } : {}),
    ...(pads !== undefined ? { pads } : {}),
  };
}

function mergeNet(base: NetSnapshot | undefined, next: NetSnapshot): NetSnapshot {
  const nodes = new Map<string, { ref: string; pin: string }>();
  for (const node of [...(base?.nodes ?? []), ...next.nodes]) nodes.set(`${node.ref}.${node.pin}`, node);
  const code = pickDefined(next.code, base?.code);
  return {
    name: next.name,
    ...(code !== undefined ? { code } : {}),
    nodes: [...nodes.values()],
  };
}

/**
 * Overlay snapshots. Later arguments win for PCB coordinates; schematic coordinates and
 * netlist connectivity are filled in when the later source omits them.
 */
export function mergeSnapshots(...sources: BoardSnapshot[]): BoardSnapshot {
  const out = emptySnapshot();
  const components = new Map<string, ComponentSnapshot>();
  const nets = new Map<string, NetSnapshot>();
  const tracks = new Map<string, TrackSnapshot>();
  const vias = new Map<string, ViaSnapshot>();
  const zones = new Map<string, ZoneSnapshot>();
  let outline: BoardSnapshot["outline"] = [];

  for (const source of sources) {
    for (const component of source.components) {
      components.set(component.ref, mergeComponent(components.get(component.ref), component));
    }
    for (const net of source.nets) {
      nets.set(net.name, mergeNet(nets.get(net.name), net));
    }
    for (const track of source.tracks) tracks.set(track.id, track);
    for (const via of source.vias ?? []) vias.set(via.id, via);
    for (const zone of source.zones ?? []) zones.set(zone.id, zone);
    if (source.outline.length > 0) outline = source.outline;
  }

  out.components = [...components.values()].sort((a, b) => a.ref.localeCompare(b.ref));
  out.nets = [...nets.values()].sort((a, b) => a.name.localeCompare(b.name));
  out.tracks = [...tracks.values()];
  out.vias = [...vias.values()];
  out.zones = [...zones.values()];
  out.outline = outline;
  return out;
}

/**
 * When a PCB source exists it is the authority for component presence and net
 * membership. Schematic coords/fields and omitted netlist fields are merged onto
 * PCB refs only — netlist-only or schematic-only refs are dropped. Copper
 * (tracks/vias/zones) stays PCB-owned; schematic wires are kept on the
 * `schematic` layer.
 */
function overlayOntoPcb(pcb: BoardSnapshot, extras: BoardSnapshot[]): BoardSnapshot {
  const extraByRef = extras.flatMap((source) => source.components);
  const fieldsByRef = new Map<string, ComponentSnapshot>();
  for (const component of extraByRef) {
    fieldsByRef.set(component.ref, mergeComponent(fieldsByRef.get(component.ref), component));
  }

  const components = pcb.components
    .map((component) => mergeComponent(fieldsByRef.get(component.ref), component))
    .sort((a, b) => a.ref.localeCompare(b.ref));

  const schTracks = extras.flatMap((source) => source.tracks.filter((t) => t.layer === "schematic"));
  return {
    components,
    nets: pcb.nets,
    tracks: [...pcb.tracks, ...schTracks],
    vias: pcb.vias ?? [],
    zones: pcb.zones ?? [],
    outline: pcb.outline,
  };
}

/** Build a snapshot from whichever sources a revision actually has. */
export function snapshotFromSources(input: {
  netlistJson?: unknown;
  kicadPcb?: string;
  kicadSch?: string;
  fromNetlist: (json: unknown) => BoardSnapshot;
  fromPcb: (text: string) => BoardSnapshot;
  fromSch: (text: string) => BoardSnapshot;
}): BoardSnapshot {
  const netlist = input.netlistJson !== undefined ? input.fromNetlist(input.netlistJson) : undefined;
  const sch = input.kicadSch ? input.fromSch(input.kicadSch) : undefined;
  const pcb = input.kicadPcb ? input.fromPcb(input.kicadPcb) : undefined;
  if (pcb) {
    return overlayOntoPcb(pcb, [netlist, sch].filter((s): s is BoardSnapshot => s !== undefined));
  }
  return mergeSnapshots(...[netlist, sch].filter((s): s is BoardSnapshot => s !== undefined));
}
