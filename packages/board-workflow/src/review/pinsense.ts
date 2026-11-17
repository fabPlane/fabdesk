/**
 * Pin-semantics rules: G generic symbol, F silent status output, R role contradiction, O outside oracle (the JLC/EasyEDA
 * symbol of the exact LCSC part). Names are normalised the way the toolkit's pinsense does.
 */
import { ORACLE_ERRATA } from "./data";
import { EDA_URL, edaPinNames, type Fetch } from "./fetch";
import { lcsc, type Comp } from "./netlist";

const ACTIVE_REF = /^(?:[A-Z]+\d*_)?(U|IC|Q|VR|PS)\d/i; // block-prefixed refs: A74_U6
const STATUS =
  /^(N|~|\/)?\{?(FAULT|FLT|FLAG|OC|OCB|PG|PGOOD|POK|PWRGD|INT|IRQ|ALERT|ALRT|STAT|STATUS|CHG|ACOK|ACPR|PPR|FAULTB|ERR|ERROR|OVP|OTP|TRIP)\}?(_?\d+)?$/i;
const OUT_TYPES = new Set(["output", "open_collector", "open_emitter", "bidirectional", "tri_state"]);
const GND_TOK = new Set(["GND", "VSS", "AGND", "PGND", "DGND", "SGND", "GNDA", "GNDD", "RTN", "RETURN", "MINUS", "0V", "EP", "EPAD", "PAD", "THERMAL", "TAB", "SHIELD", "CHASSIS"]);
const SUPPLY_PIN = /^(VCC|VDD|VIN|VBAT|VSYS|VBUS|AVDD|DVDD|IOVDD|VDDIO|PVIN|AVCC|VCCIO|VS|V\+)\d*$/;
const FET_ROLE: Record<string, string> = { G: "GATE", D: "DRAIN", S: "SOURCE" };
const BJT_ROLE: Record<string, string> = { B: "BASE", C: "COLLECTOR", E: "EMITTER" };
const EQUIV: Array<Set<string>> = [new Set([...GND_TOK, "GND1", "GND2", "VSS1", "VSS2"]), new Set(["VCC", "VDD", "VIN", "VI", "IN", "VS", "V+"]), new Set(["VOUT", "VO", "OUT"])];

/** Pin name without KiCad's decoration and case. */
export function norm(pin: string | undefined): string {
  return (pin ?? "").toUpperCase().trim().replace(/[{}~/#\s]/g, "");
}
export const stripNum = (s: string) => s.replace(/_\d+$/, "");
export function tokens(net: string): Set<string> {
  return new Set((net ?? "").toUpperCase().split(/[^A-Z0-9+]+/).filter(Boolean));
}
const powerish = (n: string) => /GND|VSS|VCC|VDD|VBUS|VIN|VSYS|VBAT|PVIN|VREG|VOUT|^V\d|^EP$|^DAP$|PAD/.test(n);
const gndish = (n: string) => /GND|VSS|^EP$|^EPAD$|^DAP$|THERMAL|^PAD$/.test(n);

export function isGndNet(net: string): boolean {
  const t = tokens(net);
  for (const x of ["GND", "VSS", "AGND", "PGND", "DGND", "SGND", "GNDA", "GNDD", "RTN"]) if (t.has(x)) return true;
  return /GND|VSS/.test(net.toUpperCase());
}

/** Generic pin names: '3', 'Pin_3', 'Pin_3_3', 'P3'. */
export function numeric(name: string): boolean {
  const s = norm(name) || "0";
  return /^(?:(?:PIN_?|P)?\d+(?:_\d+)?|PIN|P)$/.test(s);
}

function lev1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length > b.length) [a, b] = [b, a];
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] !== b[j]) {
      d++;
      if (d > 1) return false;
      if (a.length === b.length) i++;
      j++;
    } else {
      i++;
      j++;
    }
  }
  return d + (b.length - j) <= 1;
}

export function same(a: string, b: string): boolean {
  if (/[/()]/.test((a ?? "") + (b ?? ""))) {
    const alts = (n: string) => stripNum((n ?? "").toUpperCase()).split(/[/()]/).filter(Boolean);
    return alts(a).some((x) => alts(b).some((y) => same(x, y)));
  }
  a = stripNum(norm(a));
  b = stripNum(norm(b));
  if (!a || !b || a === b) return true;
  a = a.replaceAll(".", "");
  b = b.replaceAll(".", "");
  a = a.replaceAll("D+", "DP").replaceAll("D-", "DN");
  b = b.replaceAll("D+", "DP").replaceAll("D-", "DN");
  if (a === b || (gndish(a) && gndish(b))) return true;
  for (const [x, y] of [[a, b], [b, a]] as const) if (y.startsWith(x!) && y.length - x!.length <= 1) return true; // DN vs DN1, VD33 vs VD33F
  if (a.length >= 5 && b.length >= 5 && lev1(a, b)) return true;
  const a2 = a.replace(/^N+/, ""), b2 = b.replace(/^N+/, "");
  if (a2 === b2 || (a.length >= 3 && b.length >= 3 && (b.includes(a) || a.includes(b)))) return true;
  for (const cls of EQUIV) if (cls.has(a) && cls.has(b)) return true;
  return false;
}

export function active(c: Comp): boolean {
  return ACTIVE_REF.test(c.ref) && c.pins.size >= 3;
}

export interface RawPinFinding {
  rule: "G" | "F" | "R" | "O";
  severity: "warning" | "error";
  ref: string;
  value: string;
  pin: string;
  message: string;
  evidence: Record<string, unknown>;
}

export interface PinsenseResult {
  raw: RawPinFinding[];
  /** Refs whose pins the outside oracle could read. */
  checked: string[];
  /** `REF.PAD` of generic-symbol pins the oracle read without contradiction. */
  confirmed: string[];
  /** Pins the oracle stayed silent on because of an erratum. */
  skipped: string[];
}

export async function review(comps: Map<string, Comp>, fx: Fetch | null): Promise<PinsenseResult> {
  const out: RawPinFinding[] = [];
  const checked: string[] = [], confirmed: string[] = [], skipped: string[] = [];
  const add = (rule: RawPinFinding["rule"], severity: RawPinFinding["severity"], c: Comp, pin: string, message: string, evidence: Record<string, unknown>) =>
    out.push({ rule, severity, ref: c.ref, value: c.value, pin, message, evidence });

  for (const c of comps.values()) {
    const pins = c.pins;
    if (!pins.size) continue;
    const names = new Map<string, string>();
    for (const [p, v] of pins) names.set(p, stripNum(norm(v.name)));
    const nameSet = new Set(names.values());
    const allNumeric = [...pins.values()].every((v) => numeric(v.name));
    // G: generic symbol on an active part
    if (active(c) && (allNumeric || c.lib.startsWith("Connector")))
      add("G", "warning", c, "*", `${c.ref} (${c.value}) uses ${c.lib}:${c.part}: pin names are numbers, so ERC/parity cannot check what any pin is; verify against the datasheet pin table or use a real symbol`, { lib: `${c.lib}:${c.part}` });
    // F: silent status outputs
    for (const [p, v] of pins) {
      const nm = stripNum(norm(v.name));
      const ty = v.type.split("+")[0]!;
      if (STATUS.test(nm) && (OUT_TYPES.has(ty) || v.type.includes("open")) && v.nodes <= 1)
        add("F", "warning", c, p, `${c.ref}.${p} ${v.name} (${v.type}) is not connected: the part can report a fault nobody sees (bench symptom: a dead rail with no indication)`, { net: v.net });
    }
    // R: role contradictions
    const has = (...xs: string[]) => xs.every((x) => nameSet.has(x));
    const kind = has("G", "D", "S") ? "fet" : has("B", "C", "E") ? "bjt" : "";
    const roles = kind === "fet" ? FET_ROLE : kind === "bjt" ? BJT_ROLE : {};
    const hasRoles = Object.keys(roles).length > 0;
    for (const [p, v] of pins) {
      const nm = names.get(p)!;
      const t = tokens(v.net);
      if (v.nodes <= 1 || v.net.startsWith("unconnected-")) continue;
      if (hasRoles)
        for (const [r, word] of Object.entries(roles))
          if (t.has(word) && nm !== r) {
            const where = [...names].find(([, n]) => n === r)?.[0] ?? "?";
            add("R", "error", c, p, `net ${v.net} names a ${word.toLowerCase()} but lands on ${c.ref} pin ${p} (${v.name}); the ${word.toLowerCase()} is pin ${where}`, { net: v.net, pin_name: v.name });
          }
      if (!hasRoles && nm.length >= 3 && !numeric(nm)) {
        const others = new Set<string>();
        for (const [q, n] of names) if (q !== p && n.length >= 3 && !numeric(n) && n !== nm && !powerish(n)) others.add(n);
        const hit = [...others].filter((o) => t.has(o) && !t.has(nm) && ![...t].some((x) => x.includes(nm) || nm.includes(x))).sort();
        if (hit.length) {
          // a numbered GPIO name inside a longer net name is often the net's own numbering: asked, not ruled
          const gpio = /^(?:(GP)?IO\d+|P[A-K]\d{1,2}|GPIO\d+)$/.test(hit[0]!) && t.size > 1;
          add("R", gpio ? "warning" : "error", c, p, `net ${v.net} carries the name of ${c.ref}'s pin ${hit[0]} but lands on pin ${p} (${v.name})` + (gpio ? "; if the name is the net's own numbering, rename it or settle this finding" : ""), { net: v.net, pin_name: v.name, other_pin: hit[0] });
        }
      }
      if (GND_TOK.has(nm) && !["PAD", "TAB", "SHIELD", "CHASSIS", "MINUS"].includes(nm) && !isGndNet(v.net) && !(t.has("MINUS") || t.has("RTN") || t.has("NEG")))
        add("R", "warning", c, p, `ground pin ${c.ref}.${p} (${v.name}) on net ${v.net}`, { net: v.net });
      if (SUPPLY_PIN.test(nm) && isGndNet(v.net) && active(c)) add("R", "error", c, p, `supply pin ${c.ref}.${p} (${v.name}) on ground net ${v.net}`, { net: v.net });
    }
    // O: outside oracle (JLC/EasyEDA symbol of the LCSC part)
    const code = lcsc(c);
    if (fx === null || !code || pins.size < 3) continue;
    const hay = [c.value, c.fields["MPN"] ?? ""].join(" ");
    const knownBad = new Set<string>();
    for (const e of ORACLE_ERRATA) if ((e.lcsc ?? []).includes(code) || new RegExp(e.match, "i").test(hay)) for (const pn of e.pins) knownBad.add(pn);
    const rec = await fx.get(`eda-${code}`, EDA_URL(code));
    const enames = rec ? edaPinNames(rec) : {};
    if (!Object.keys(enames).length) continue;
    const enorm: Record<string, string> = {};
    for (const [k, v] of Object.entries(enames)) enorm[k] = stripNum(norm(v));
    checked.push(c.ref);
    for (const [p, v] of pins) {
      const e = enorm[p];
      if (e === undefined || v.net.startsWith("unconnected-") || v.nodes <= 1) continue;
      if (knownBad.has(p)) {
        skipped.push(`${c.ref}.${p}`); // oracle-errata.json: JLC's symbol is known wrong here
        continue;
      }
      const ours = names.get(p)!;
      if (!numeric(ours)) {
        if (!same(v.name, enames[p]!) && !numeric(e))
          add("O", "error", c, p, `${c.ref}.${p}: our symbol calls it ${v.name}, JLC's symbol for ${code} calls it ${enames[p]} (net ${v.net})`, { lcsc: code, ours: v.name, jlc: enames[p], net: v.net });
      } else {
        confirmed.push(`${c.ref}.${p}`);
        const t = tokens(v.net);
        const wrong = Object.entries(enorm).filter(([q, n]) => q !== p && n.length >= 3 && t.has(n) && n !== e && !powerish(n)).map(([, n]) => n).sort();
        if (wrong.length && !t.has(e)) add("O", "error", c, p, `${c.ref}.${p} (generic) is on net ${v.net}, which names JLC pin ${wrong[0]}; JLC's symbol for ${code} says pad ${p} is ${enames[p]}`, { lcsc: code, jlc: enames[p], net: v.net });
      }
    }
  }
  return { raw: out, checked, confirmed, skipped };
}
