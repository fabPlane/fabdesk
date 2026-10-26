import { emptySnapshot, type BoardSnapshot, type ComponentSnapshot, type NetSnapshot } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read fabPlane `circuit.netlist.json` (or a bare `{ components, nets }` object) into a snapshot.
 * Board placements, when present, become PCB coordinates.
 */
export function snapshotFromNetlist(json: unknown): BoardSnapshot {
  const root = asRecord(json);
  if (!root) return emptySnapshot();
  const netlist = asRecord(root["netlist"]) ?? root;
  const componentsRaw = netlist["components"];
  const netsRaw = netlist["nets"];
  const snapshot = emptySnapshot();

  if (Array.isArray(componentsRaw)) {
    for (const item of componentsRaw) {
      const rec = asRecord(item);
      const ref = rec ? asString(rec["ref"]) : undefined;
      if (!ref) continue;
      const value = rec ? asString(rec["value"]) : undefined;
      const footprint = rec ? asString(rec["footprint"]) : undefined;
      const component: ComponentSnapshot = {
        ref,
        ...(value ? { value } : {}),
        ...(footprint ? { footprint } : {}),
      };
      snapshot.components.push(component);
    }
  }

  if (Array.isArray(netsRaw)) {
    for (const item of netsRaw) {
      const rec = asRecord(item);
      const name = rec ? asString(rec["name"]) : undefined;
      if (!name) continue;
      const code = rec ? asNumber(rec["code"]) : undefined;
      const nodes: NetSnapshot["nodes"] = [];
      const rawNodes = rec?.["nodes"];
      if (Array.isArray(rawNodes)) {
        for (const node of rawNodes) {
          const n = asRecord(node);
          const ref = n ? asString(n["ref"]) : undefined;
          const pin = n ? asString(n["pin"]) : undefined;
          if (ref && pin) nodes.push({ ref, pin });
        }
      }
      snapshot.nets.push({ name, ...(code !== undefined ? { code } : {}), nodes });
    }
  }

  const board = asRecord(root["board"]);
  const placements = board ? board["placements"] : undefined;
  if (Array.isArray(placements)) {
    const byRef = new Map(snapshot.components.map((c) => [c.ref, c]));
    for (const item of placements) {
      const rec = asRecord(item);
      const ref = rec ? asString(rec["ref"]) : undefined;
      const pos = rec ? asRecord(rec["position"]) : null;
      const x = pos ? asNumber(pos["x"]) : undefined;
      const y = pos ? asNumber(pos["y"]) : undefined;
      if (!ref || x === undefined || y === undefined) continue;
      const existing = byRef.get(ref);
      if (existing) {
        existing.x = x;
        existing.y = y;
      } else {
        const created: ComponentSnapshot = { ref, x, y };
        snapshot.components.push(created);
        byRef.set(ref, created);
      }
    }
  }

  return snapshot;
}
