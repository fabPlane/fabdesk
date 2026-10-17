/** Conservative saved-netlist LED checks. No simulation or active-device traversal. */
type Sexp = string | Sexp[];
function parse(text: string): Sexp[] {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g) ?? [];
  let i = 0;
  function item(): Sexp {
    const token = tokens[i++];
    if (!token || token === ")") throw new Error("invalid s-expression");
    if (token !== "(") return token.startsWith('"') ? (JSON.parse(token) as string) : token;
    const result: Sexp[] = [];
    while (tokens[i] !== ")") {
      if (i >= tokens.length) throw new Error("unclosed s-expression");
      result.push(item());
    }
    i++;
    return result;
  }
  const root = item();
  if (i !== tokens.length || !Array.isArray(root)) throw new Error("invalid root");
  return root;
}
const children = (s: Sexp[], key: string) =>
  s.filter((x): x is Sexp[] => Array.isArray(x) && x[0] === key);
const child = (s: Sexp[], key: string) => children(s, key)[0] ?? [];
const val = (s: Sexp[], key: string) => String(child(s, key)[1] ?? "");
const fn = (name: string) => name.replace(/_\w+$/, "").toUpperCase();
const groundFunction = (name: string) => /^(?:GND|GNDA|GNDD|AGND|DGND|PGND|VSS)$/.test(fn(name));
const supplyFunction = (name: string) =>
  /^(?:VCC|VDD|VDDA|VDDD|AVCC|AVDD|DVCC|DVDD|VBUS)$/.test(fn(name));
const positiveSymbol = (name: string) =>
  /^(?:\+\d+(?:V\d*)?|VCC|VDD|VDDA|VDDD|AVCC|AVDD|DVCC|DVDD|VBUS)$/.test(name);
interface Component {
  reference: string;
  value: string;
  lib: string;
  part: string;
}
interface Node {
  reference: string;
  pin: string;
  function: string;
  type: string;
  net: string;
}
interface Saved {
  components: Component[];
  nodes: Node[];
  grounds: Set<string>;
  supplies: Set<string>;
  railEvidence: { net: string; source: string }[];
}
function saved(text: string, schematics: string[]): Saved {
  const root = parse(text);
  if (
    root[0] !== "export" ||
    !children(root, "components").length ||
    !children(root, "nets").length
  )
    throw new Error("missing netlist components or nets");
  const components = children(child(root, "components"), "comp").map((c) => ({
    reference: val(c, "ref"),
    value: val(c, "value"),
    lib: val(child(c, "libsource"), "lib"),
    part: val(child(c, "libsource"), "part"),
  }));
  const nodes = children(child(root, "nets"), "net").flatMap((n) =>
    children(n, "node").map((p) => ({
      reference: val(p, "ref"),
      pin: val(p, "pin"),
      function: val(p, "pinfunction"),
      type: val(p, "pintype"),
      net: val(n, "name"),
    })),
  );
  const grounds = new Set<string>(),
    supplies = new Set<string>(),
    railEvidence: Saved["railEvidence"] = [];
  // Power symbols define global net labels. Match only instantiated standard power symbols,
  // never arbitrary net names or PWR_FLAG (which does not establish voltage or polarity).
  for (const text of schematics) {
    const sch = parse(text);
    for (const symbol of children(sch, "symbol")) {
      const id = val(symbol, "lib_id");
      if (!id.startsWith("power:")) continue;
      const part = id.slice(6);
      const net = String(children(symbol, "property").find((p) => p[1] === "Value")?.[2] ?? part);
      const target = groundFunction(part) ? grounds : positiveSymbol(part) ? supplies : null;
      if (target && nodes.some((n) => n.net === net)) {
        target.add(net);
        railEvidence.push({ net, source: `power symbol ${id}` });
      }
    }
  }
  // Some saved designs have no rail symbols at all. Explicit power-input pin functions
  // still provide artifact evidence; a label named GND or +5V alone never does.
  for (const node of nodes) {
    if (node.type !== "power_in" && node.type !== "power_out") continue;
    const target = groundFunction(node.function)
      ? grounds
      : supplyFunction(node.function)
        ? supplies
        : null;
    if (target) {
      target.add(node.net);
      railEvidence.push({
        net: node.net,
        source: `${node.reference}.${node.pin} ${node.function} (${node.type})`,
      });
    }
  }
  return { components, nodes, grounds, supplies, railEvidence };
}
function resistance(value: string): number | null {
  const clean = value.trim().replace(/\s*(?:ohms?|Ω)$/i, "");
  const plain = /^(\d+(?:\.\d+)?)\s*([RrKkMm]?)$/.exec(clean);
  const embedded = /^(\d+)([RrKkMm])(\d+)$/.exec(clean);
  const m = plain ?? embedded;
  if (!m) return null;
  const multiplier = /[Kk]/.test(m[2]!) ? 1000 : /[Mm]/.test(m[2]!) ? 1e6 : 1;
  const result = Number(embedded ? `${m[1]}.${m[3]}` : m[1]) * multiplier;
  return result > 0 ? result : null;
}
function resistors(s: Saved) {
  return s.components
    .filter((c) => c.lib === "Device" && /^(R|R_Small|R_US)$/.test(c.part))
    .flatMap((c) => {
      const pins = s.nodes.filter((n) => n.reference === c.reference);
      return pins.length === 2 && pins[0]!.net !== pins[1]!.net
        ? [{ ...c, nets: [pins[0]!.net, pins[1]!.net], ohms: resistance(c.value) }]
        : [];
    });
}
function paths(s: Saved, start: string | null, end: (net: string) => boolean) {
  if (!start) return [];
  const paths: { net: string; resistor: ReturnType<typeof resistors>[number] | null }[] = [];
  if (end(start)) paths.push({ net: start, resistor: null });
  for (const r of resistors(s)) {
    if (!r.nets.includes(start)) continue;
    const other = r.nets.find((n) => n !== start)!;
    if (end(other)) paths.push({ net: other, resistor: r });
  }
  return paths;
}
function leds(s: Saved) {
  return s.components.flatMap((c) => {
    const pins = s.nodes.filter((n) => n.reference === c.reference);
    const anodes = pins.filter((p) => fn(p.function) === "A"),
      cathodes = pins.filter((p) => fn(p.function) === "K");
    const fallback = c.lib === "Device" && /^(LED|LED_Small|LED_ALT)$/.test(c.part);
    const libraryLed = /^LED(?:_|$)/.test(c.part);
    if (!(anodes.length && cathodes.length) && !libraryLed) return [];
    const a =
      anodes.length === 1 ? anodes[0] : fallback ? pins.find((p) => p.pin === "2") : undefined;
    const k =
      cathodes.length === 1 ? cathodes[0] : fallback ? pins.find((p) => p.pin === "1") : undefined;
    const anodeNet = a?.net ?? null,
      cathodeNet = k?.net ?? null;
    const reasons: string[] = [];
    if (anodeNet && s.grounds.has(anodeNet)) reasons.push("anode tied to ground");
    if (cathodeNet && s.supplies.has(cathodeNet)) reasons.push("cathode tied to positive supply");
    if (anodeNet && anodeNet === cathodeNet) reasons.push("anode and cathode on the same net");
    const source = paths(s, cathodeNet, (n) => s.grounds.has(n)).length > 0;
    const sink = paths(s, anodeNet, (n) => s.supplies.has(n)).length > 0;
    const mode = source && !sink ? "source" : sink && !source ? "sink" : "unknown";
    const status = reasons.length
      ? "fail"
      : anodeNet && cathodeNet && mode !== "unknown"
        ? "pass"
        : "unknown";
    if (status === "unknown")
      reasons.push(
        !anodeNet || !cathodeNet
          ? "forward path not decided: anode or cathode net not resolved"
          : source && sink
            ? "forward path not decided: both source and sink rail paths found"
            : !s.grounds.size && !s.supplies.size
              ? "forward path not decided: no recognized ground or positive-supply rail evidence"
              : "forward path not decided: no supported direct or single-resistor path to a recognized rail",
      );
    return [
      {
        reference: c.reference,
        anodeNet,
        cathodeNet,
        pinEvidence: anodes.length && cathodes.length ? "pin-functions" : "library-fallback",
        status,
        mode,
        reasons,
      },
    ];
  });
}
export function inspectLedDirections(netlist: string, schematics: string[] = []) {
  try {
    const s = saved(netlist, schematics),
      results = leds(s);
    return {
      evidenceLevel: "computed",
      source: "saved-kicad-netlist",
      status: results.some((l) => l.status === "fail")
        ? "fail"
        : results.some((l) => l.status === "unknown")
          ? "unknown"
          : "pass",
      leds: results,
      railEvidence: s.railEvidence,
      reasons: [] as string[],
    };
  } catch (e) {
    return {
      evidenceLevel: "missing",
      source: "saved-kicad-netlist",
      status: "unknown",
      leds: [],
      railEvidence: [],
      reasons: [String(e)],
    };
  }
}
interface LedCheck {
  led?: string | undefined;
  driveNet?: string | undefined;
  supplyVolts: number;
  forwardVolts: number;
  resistanceOhms: number;
  minMa: number;
  maxMa: number;
}
export function evaluateLedCurrent(check: LedCheck, netlist: string, schematics: string[] = []) {
  const assumptions = { forwardVolts: check.forwardVolts, supplyVolts: check.supplyVolts };
  const arithmetic = (ohms: number) => ({
    currentMa: (Math.max(0, check.supplyVolts - check.forwardVolts) / ohms) * 1000,
  });
  if (!check.led) {
    const measured = arithmetic(check.resistanceOhms);
    return {
      evidenceLevel: "declared",
      status:
        measured.currentMa >= check.minMa && measured.currentMa <= check.maxMa ? "pass" : "fail",
      measured,
      assumptions,
      reasons: ["arithmetic from supplied numbers; saved design not checked"],
    };
  }
  try {
    const s = saved(netlist, schematics),
      led = leds(s).find((l) => l.reference === check.led);
    if (!led || !check.driveNet)
      return {
        evidenceLevel: "missing",
        status: "unknown",
        assumptions,
        reasons: [
          !led ? "LED reference not resolved" : "driveNet required for design-bound current",
        ],
      };
    const source = paths(s, led.anodeNet, (n) => n === check.driveNet).flatMap((a) =>
      paths(s, led.cathodeNet, (n) => s.grounds.has(n)).map((k) => ({ mode: "source", a, k })),
    );
    const sink = paths(s, led.cathodeNet, (n) => n === check.driveNet).flatMap((k) =>
      paths(s, led.anodeNet, (n) => s.supplies.has(n)).map((a) => ({ mode: "sink", a, k })),
    );
    const candidates = [...source, ...sink].filter(
      (p) => Number(!!p.a.resistor) + Number(!!p.k.resistor) === 1,
    );
    if (led.status === "fail")
      return { evidenceLevel: "computed", status: "fail", led, assumptions, reasons: led.reasons };
    if (candidates.length !== 1)
      return {
        evidenceLevel: "missing",
        status: "unknown",
        led,
        assumptions,
        reasons: ["unique forward source/sink path with one series resistor not decided"],
      };
    const path = candidates[0]!,
      r = (path.a.resistor ?? path.k.resistor)!;
    // A shared intermediate net is not proof that this resistor limits LED current.
    const intermediate = path.a.resistor ? led.anodeNet : led.cathodeNet;
    if (
      s.nodes
        .filter((n) => n.net === intermediate)
        .some((n) => n.reference !== check.led && n.reference !== r.reference) ||
      r.ohms === null
    )
      return {
        evidenceLevel: "missing",
        status: "unknown",
        led,
        assumptions,
        reasons: ["branched series path or unsupported resistor value"],
      };
    const measured = arithmetic(r.ohms);
    const reasons: string[] = [];
    if (Math.abs(r.ohms - check.resistanceOhms) > 1e-9)
      reasons.push(
        `resistanceOhms ${check.resistanceOhms} differs from saved ${r.reference} value ${r.ohms}`,
      );
    if (measured.currentMa < check.minMa || measured.currentMa > check.maxMa)
      reasons.push("current outside declared limits");
    return {
      evidenceLevel: "computed",
      status: reasons.length ? "fail" : "pass",
      led,
      mode: path.mode,
      driveNet: check.driveNet,
      resistor: { reference: r.reference, value: r.value, resistanceOhms: r.ohms },
      measured,
      assumptions,
      reasons,
    };
  } catch (e) {
    return { evidenceLevel: "missing", status: "unknown", assumptions, reasons: [String(e)] };
  }
}
