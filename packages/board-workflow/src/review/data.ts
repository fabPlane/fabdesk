/** The review's data files (rule cards, interface profiles, oracle errata, escapes, seeds), shipped with the package. */
import bq25798 from "../../data/review/cards/bq25798.json";
import bq28z610 from "../../data/review/cards/bq28z610.json";
import sh10 from "../../data/review/cards/sh10-carrier-link.json";
import sony from "../../data/review/cards/sony-pack-40.json";
import tps568230 from "../../data/review/cards/tps568230.json";
import tps62822 from "../../data/review/cards/tps62822.json";
import profiles from "../../data/review/interface-profiles.json";
import errata from "../../data/review/oracle-errata.json";
import escapes from "../../data/review/escapes.json";
import seeds from "../../data/review/seeds.json";

export interface RuleCardRule {
  pin?: string;
  pad?: string;
  path?: string[];
  arrives_pin?: string;
  not_arrives_pin?: string;
  arrives_ground?: boolean;
  net_matches?: string;
  why?: string;
}
export interface RuleCard {
  match: string;
  boards?: string[];
  source_kind?: string;
  source?: string;
  checked_against_datasheet?: boolean;
  rules: RuleCardRule[];
  _file: string;
}

export const BUILTIN_CARDS: RuleCard[] = (
  [
    ["bq25798.json", bq25798],
    ["bq28z610.json", bq28z610],
    ["sh10-carrier-link.json", sh10],
    ["sony-pack-40.json", sony],
    ["tps568230.json", tps568230],
    ["tps62822.json", tps62822],
  ] as Array<[string, unknown]>
).map(([f, c]) => ({ ...(c as object), _file: f }) as RuleCard);

export interface InterfaceProfile {
  match: string;
  zdiff: number;
  tol_pct: number;
  max_vias_per_net?: number;
  basis?: string;
}
export const INTERFACE_PROFILES = profiles.profiles as Record<string, InterfaceProfile>;

export interface Erratum {
  match: string;
  lcsc?: string[];
  pins: string[];
}
export const ORACLE_ERRATA = errata.errata as Erratum[];

export const ESCAPES = escapes;
export const SEEDS = seeds;
