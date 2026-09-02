/**
 * Canonical net names for imported boards.
 *
 * KiCad names nets hierarchically (`/CM5/DPHY0_P.D0_N`, `Net-(R1-Pad1)`, `+3V3`); tscircuit and
 * the routers want plain identifiers. One mapping is used for every net reference on the board
 * (pads, segments, vias, zones) so a net's copper and its connection carry the same name. Two
 * different KiCad names that canonicalize to one identifier are a collision and fail the import:
 * silently merging them would join two nets.
 */

export interface NetNameEntry {
  /** The KiCad name the canonical form was derived from. */
  original: string;
  /** Every KiCad spelling that mapped here (the original first). */
  aliases: string[];
}

export interface NetNameMap {
  /** canonical -> original + aliases */
  canonical: Record<string, NetNameEntry>;
  /** KiCad name -> canonical */
  byOriginal: Record<string, string>;
  /** Canonical names claimed by more than one distinct KiCad name. */
  collisions: Array<{ canonical: string; originals: string[] }>;
}

/** `/CM5/DPHY0_P.D0_N` -> `CM5_DPHY0_P_D0_N`, `+3V3` -> `P3V3`, `Net-(R1-Pad1)` -> `Net_R1_Pad1`. */
export function canonicalNetName(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^\/+/, "");
  if (s.startsWith("+")) s = `P${s.slice(1)}`;
  else if (s.startsWith("-")) s = `N${s.slice(1)}`;
  s = s
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s;
}

/**
 * Builds the map for a set of KiCad net names. Names that are aliases of one another by KiCad's
 * own convention (identical after canonicalization AND one is the other with the leading `/`
 * or hierarchical prefix stripped) are accepted as aliases; anything else is a collision.
 */
export function buildNetNameMap(originals: Iterable<string>): NetNameMap {
  const canonical: Record<string, NetNameEntry> = {};
  const byOriginal: Record<string, string> = {};
  const collisions: Array<{ canonical: string; originals: string[] }> = [];
  for (const original of new Set(originals)) {
    if (original === "") continue;
    const key = canonicalNetName(original);
    if (key === "") continue;
    byOriginal[original] = key;
    const entry = canonical[key];
    if (!entry) {
      canonical[key] = { original, aliases: [original] };
      continue;
    }
    entry.aliases.push(original);
    if (!isKicadAlias(entry.original, original)) {
      const existing = collisions.find((c) => c.canonical === key);
      if (existing) existing.originals.push(original);
      else collisions.push({ canonical: key, originals: [entry.original, original] });
    }
  }
  return { canonical, byOriginal, collisions };
}

/** `/CM5/X` and `X`, or `/X` and `X`: the same net written with and without its sheet path. */
function isKicadAlias(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/^\/+/, "").replace(/^.*\//, "");
  return strip(a) === strip(b);
}
