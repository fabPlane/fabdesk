/**
 * Datasheet rule cards: typed topology rules per part, written from the datasheet, checked on the netlist.
 *
 * A card matches parts by value/MPN regex and lists rules. Each rule walks from one pin of the part through a sequence of
 * two-terminal parts and asserts where it arrives:
 *
 *   {"pin": "SRP", "path": ["R"], "arrives_pin": "VSS"}        SRP -> one resistor -> the net of the part's VSS pin
 *   {"pin": "FB",  "path": ["R"], "arrives_ground": true}      lower divider resistor to ground
 *   {"pin": "BST", "path": ["C"], "arrives_pin": "SW"}         bootstrap capacitor
 *   {"pad": "1", "net_matches": "5V|VBUS"}                     a measured connector pin: its net must name that function
 *
 * `source_kind`: "datasheet" (default) | "measurement" | "reference". Only a datasheet card checked against the PDF raises
 * must-fix; the others ask. The agent writes cards (it reads the datasheet); this file only computes.
 */
import type { RuleCard } from "./data";
import { EDA_URL, edaPinNames, type Fetch } from "./fetch";
import { lcsc, type Comp } from "./netlist";
import { isGndNet, norm, numeric, stripNum } from "./pinsense";

const KIND: Record<string, RegExp> = { R: /(?:^|_)R[A-Z]*\d+$/, C: /(?:^|_)C\d+$/, L: /(?:^|_)L\d+$/, FB: /(?:^|_)FB\d+$/ };

export interface CardFinding {
  ref: string;
  value: string;
  card: string;
  why: string;
  source: string;
  pins_from: string;
  pad: string;
  severity: "must-fix" | "question";
  message: string;
}

function netsOf(comps: Map<string, Comp>): Map<string, Array<[string, string]>> {
  const by = new Map<string, Array<[string, string]>>();
  for (const [ref, c] of comps)
    for (const [pad, v] of c.pins)
      if (v.net && !v.net.startsWith("unconnected-")) (by.get(v.net) ?? by.set(v.net, []).get(v.net)!).push([ref, pad]);
  return by;
}

async function pinMap(c: Comp, fx: Fetch | null): Promise<[Map<string, string>, string]> {
  const names = new Map<string, string>();
  for (const [pad, v] of c.pins) {
    const n = stripNum(norm(v.name));
    if (n && !numeric(v.name)) for (const alt of n.split("/")) if (!names.has(alt)) names.set(alt, pad);
  }
  let src = "our symbol";
  if (!names.size && fx && lcsc(c)) {
    const rec = await fx.get(`eda-${lcsc(c)}`, EDA_URL(lcsc(c)));
    for (const [pad, n] of Object.entries(rec ? edaPinNames(rec) : {})) {
      const k = stripNum(norm(n));
      if (!names.has(k)) names.set(k, pad);
    }
    src = `JLC symbol ${lcsc(c)}`;
  }
  return [names, src];
}

/** Nets reached from `startNet` through the given sequence of part kinds (all branches). */
function walk(startNet: string, path: string[], comps: Map<string, Comp>, nets: Map<string, Array<[string, string]>>, skipRef: string): Set<string> {
  let frontier = new Set([startNet]);
  for (const kind of path) {
    const nxt = new Set<string>();
    for (const net of frontier)
      for (const [ref, pad] of nets.get(net) ?? []) {
        if (ref === skipRef || !KIND[kind]!.test(ref)) continue;
        const pins = comps.get(ref)!.pins;
        if (pins.size !== 2) continue;
        const other = [...pins].filter(([p]) => p !== pad).map(([, v]) => v.net);
        if (other[0] && !other[0].startsWith("unconnected-")) nxt.add(other[0]);
      }
    frontier = nxt;
  }
  return frontier;
}

const pyList = (xs: string[]) => `[${xs.map((x) => `'${x}'`).join(", ")}]`;

export async function applyCards(
  comps: Map<string, Comp>,
  cards: RuleCard[],
  fx: Fetch | null,
  board?: string,
): Promise<{ findings: CardFinding[]; evaluated: number; matched: Map<string, Array<[string, string]>> }> {
  const nets = netsOf(comps);
  const out: CardFinding[] = [];
  let evaluated = 0;
  const matched = new Map<string, Array<[string, string]>>();
  for (const [ref, c] of comps) {
    const hay = [c.value, c.fields["MPN"] ?? "", c.fields["Manufacturer Part Number"] ?? ""].join(" ");
    for (const card of cards) {
      if (!new RegExp(card.match, "i").test(hay) || (card.boards && !(board && card.boards.includes(board)))) continue;
      (matched.get(ref) ?? matched.set(ref, []).get(ref)!).push([card._file, card.source_kind ?? "datasheet"]);
      const [names, src] = await pinMap(c, fx);
      const ownGnd = new Set<string>();
      for (const [n, p] of names) if (/^(GND|VSS|AGND|PGND|EP|DAP)$/.test(n)) ownGnd.add(c.pins.get(p)!.net);
      for (const rule of card.rules) {
        evaluated++;
        const pad = rule.pad !== undefined ? String(rule.pad) : names.get(rule.pin ?? "");
        const kind = card.source_kind ?? "datasheet";
        // only a datasheet card checked against the PDF can raise must-fix; measurements and references ask
        const sev: CardFinding["severity"] = kind === "datasheet" && card.checked_against_datasheet ? "must-fix" : "question";
        const base = { ref, value: c.value, card: card._file, why: rule.why ?? "", source: card.source ?? "", pins_from: src };
        const label = rule.pin || `pad ${rule.pad}`;
        if (pad === undefined || !c.pins.has(pad)) {
          out.push({ ...base, pad: "", severity: "question", message: `${ref} (${c.value}): card ${card._file} names ${label}, not found (${src})` });
          continue;
        }
        const start = c.pins.get(pad)!.net;
        if (rule.net_matches !== undefined) {
          // a measured/known function: the pad's net must say so
          if (!new RegExp(rule.net_matches, "i").test(start || ""))
            out.push({ ...base, pad, severity: sev, message: `${ref} (${c.value}) ${label}: net ${start} does not match the ${kind} (${rule.net_matches}). ${rule.why ?? ""}` });
          continue;
        }
        const got = walk(start, rule.path ?? [], comps, nets, ref);
        let ok = true, want = "";
        if (rule.arrives_pin !== undefined || rule.not_arrives_pin !== undefined) {
          const tname = rule.arrives_pin || rule.not_arrives_pin!;
          const tpad = names.get(tname);
          const target = tpad !== undefined && c.pins.has(tpad) ? c.pins.get(tpad)!.net : null;
          const hit = target !== null && got.has(target);
          ok = rule.arrives_pin !== undefined ? hit : !hit;
          want = `${rule.arrives_pin !== undefined ? "" : "not "}${tname} (${target === null ? "None" : target})`;
        }
        if (rule.arrives_ground) {
          const hit = [...got].some((n) => isGndNet(n) || ownGnd.has(n));
          ok = ok && hit;
          want = (want ? want + " and " : "") + "ground";
        }
        if (!ok)
          out.push({ ...base, pad, severity: sev, message: `${ref} (${c.value}) ${rule.pin} (pad ${pad}, net ${start}) via ${(rule.path ?? []).join("-")} should reach ${want}; reaches ${got.size ? pyList([...got].sort()) : "nothing"}. ${rule.why ?? ""}` });
      }
    }
  }
  return { findings: out, evaluated, matched };
}
