import type { CircuitIntent, PhotoSighting, SightedItem } from "@fabdesk/protocol";

const EQUIVALENT =
  "This is a working functional equivalent drafted from the photos and your description — not a pixel-for-pixel copy of the original traces or artwork.";

/**
 * Turn a corrected "what I see" list plus the user's request into a block diagram and
 * netlist intent. Does not try to recover copper from the photo.
 */
export function inferCircuit(sighting: PhotoSighting, description: string): CircuitIntent {
  const items = sighting.items.filter((i) => i.kind !== "mounting_hole");
  const blocks = groupBlocks(items);
  const nets = proposeNets(items, blocks);
  const notes = [
    EQUIVALENT,
    description.trim() ? `Request: ${description.trim()}` : "No extra description — inferred from visible parts only.",
    sighting.openSourceNote?.suspected
      ? `The photos may show a known open-source design${sighting.openSourceNote.projectName ? ` (${sighting.openSourceNote.projectName})` : ""}. Attribute the original authors; this draft is not that design.`
      : "",
  ].filter(Boolean);
  return {
    equivalent: true,
    disclaimer: notes.join(" "),
    blocks,
    nets,
  };
}

function groupBlocks(items: readonly SightedItem[]): CircuitIntent["blocks"] {
  const byRole: Array<{ id: string; name: string; role: string; kinds: SightedItem["kind"][] }> = [
    { id: "power", name: "Power", role: "supply and regulation", kinds: ["battery", "connector"] },
    { id: "mcu", name: "Controller", role: "MCU or logic", kinds: ["ic"] },
    { id: "io", name: "Inputs", role: "switches, encoders, user input", kinds: ["switch", "encoder"] },
    { id: "out", name: "Outputs", role: "LEDs, displays, indicators", kinds: ["led", "display"] },
    { id: "passives", name: "Passives", role: "resistors, capacitors, inductors", kinds: ["passive"] },
  ];
  const blocks: CircuitIntent["blocks"] = [];
  const used = new Set<string>();
  for (const spec of byRole) {
    const ids = items.filter((i) => spec.kinds.includes(i.kind)).map((i) => i.id);
    if (ids.length === 0) continue;
    for (const id of ids) used.add(id);
    blocks.push({ id: spec.id, name: spec.name, role: spec.role, itemIds: ids });
  }
  const leftover = items.filter((i) => !used.has(i.id)).map((i) => i.id);
  if (leftover.length) blocks.push({ id: "other", name: "Other", role: "unclassified visible parts", itemIds: leftover });
  return blocks;
}

function proposeNets(
  items: readonly SightedItem[],
  blocks: CircuitIntent["blocks"],
): CircuitIntent["nets"] {
  const nets: CircuitIntent["nets"] = [];
  const power = items.filter((i) => i.kind === "battery" || (i.kind === "connector" && /usb|barrel|dc/i.test(i.label)));
  const leds = items.filter((i) => i.kind === "led");
  const ics = items.filter((i) => i.kind === "ic");
  const switches = items.filter((i) => i.kind === "switch" || i.kind === "encoder");
  const passives = items.filter((i) => i.kind === "passive");

  if (power.length) {
    nets.push({
      name: "VCC",
      purpose: "Power rail from the supply into the rest of the board",
      nodes: power.map((p) => ({ itemId: p.id, pin: "1" })),
    });
    nets.push({
      name: "GND",
      purpose: "Return",
      nodes: [...power, ...ics, ...leds].map((p) => ({ itemId: p.id, pin: p.kind === "led" ? "2" : "GND" })),
    });
  }
  for (const [i, led] of leds.entries()) {
    const series = passives[i];
    const mcu = ics[0];
    nets.push({
      name: `LED${i + 1}`,
      purpose: `Drive ${led.label} as a functional equivalent of the visible indicator`,
      nodes: [
        { itemId: led.id, pin: "1" },
        ...(series ? [{ itemId: series.id, pin: "2" }] : []),
        ...(mcu ? [{ itemId: mcu.id, pin: `IO${i + 1}` }] : []),
      ],
    });
  }
  for (const [i, sw] of switches.entries()) {
    const mcu = ics[0];
    nets.push({
      name: `SW${i + 1}`,
      purpose: `Read ${sw.label}`,
      nodes: [{ itemId: sw.id, pin: "1" }, ...(mcu ? [{ itemId: mcu.id, pin: `IO${leds.length + i + 1}` }] : [])],
    });
  }
  if (nets.length === 0 && items.length >= 2) {
    nets.push({
      name: "N1",
      purpose: "Placeholder net so the functional equivalent can be built and routed",
      nodes: items.slice(0, 2).map((i) => ({ itemId: i.id, pin: "1" })),
    });
  }
  void blocks;
  return nets;
}
