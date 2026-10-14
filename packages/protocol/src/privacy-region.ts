/**
 * Offline guess at whether this installation is likely used from the EU/EEA, the UK or
 * Switzerland, where usage-data backup asks for consent first. Uses only the system time zone and
 * OS locale regions, never the network, so it is a heuristic: a VPN does not change it, a
 * traveller keeps their home settings, and a user can set any zone or locale. When either signal
 * points into the region the answer is yes.
 */

/** EU member states, the other EEA states, the UK and Switzerland, plus territories in scope. */
export const CONSENT_REGION_COUNTRIES: ReadonlySet<string> = new Set([
  // EU
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
  "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // EU outermost regions and Åland, which have their own ISO codes
  "AX", "GF", "GP", "MF", "MQ", "RE", "YT",
  // EEA
  "IS", "LI", "NO",
  // UK, and the Crown Dependencies and Gibraltar, which mirror UK data-protection law
  "GB", "GG", "IM", "JE", "GI",
  // Switzerland
  "CH",
]);

/**
 * IANA zones (including the legacy aliases some systems still report) whose territory is in
 * `CONSENT_REGION_COUNTRIES`. Zones shared with countries outside the region (Europe/Kyiv,
 * Europe/Belgrade, Europe/Istanbul, Europe/Moscow, ...) are deliberately absent. The generic
 * `CET`/`MET`/`WET`/`EET` zones map to `null`: no single country, but most users are in the EU.
 */
export const CONSENT_REGION_TIME_ZONES: Readonly<Record<string, string | null>> = {
  "Europe/Amsterdam": "NL",
  "Europe/Athens": "GR",
  "Europe/Belfast": "GB",
  "Europe/Berlin": "DE",
  "Europe/Bratislava": "SK",
  "Europe/Brussels": "BE",
  "Europe/Bucharest": "RO",
  "Europe/Budapest": "HU",
  "Europe/Busingen": "DE",
  "Europe/Copenhagen": "DK",
  "Europe/Dublin": "IE",
  "Europe/Gibraltar": "GI",
  "Europe/Guernsey": "GG",
  "Europe/Helsinki": "FI",
  "Europe/Isle_of_Man": "IM",
  "Europe/Jersey": "JE",
  "Europe/Lisbon": "PT",
  "Europe/Ljubljana": "SI",
  "Europe/London": "GB",
  "Europe/Luxembourg": "LU",
  "Europe/Madrid": "ES",
  "Europe/Malta": "MT",
  "Europe/Mariehamn": "AX",
  "Europe/Nicosia": "CY",
  "Europe/Oslo": "NO",
  "Europe/Paris": "FR",
  "Europe/Prague": "CZ",
  "Europe/Riga": "LV",
  "Europe/Rome": "IT",
  "Europe/Sofia": "BG",
  "Europe/Stockholm": "SE",
  "Europe/Tallinn": "EE",
  "Europe/Vaduz": "LI",
  "Europe/Vienna": "AT",
  "Europe/Vilnius": "LT",
  "Europe/Warsaw": "PL",
  "Europe/Zagreb": "HR",
  "Europe/Zurich": "CH",
  "Africa/Ceuta": "ES",
  "America/Cayenne": "GF",
  "America/Guadeloupe": "GP",
  "America/Marigot": "MF",
  "America/Martinique": "MQ",
  "Arctic/Longyearbyen": "NO",
  "Asia/Famagusta": "CY",
  "Asia/Nicosia": "CY",
  "Atlantic/Azores": "PT",
  "Atlantic/Canary": "ES",
  "Atlantic/Jan_Mayen": "NO",
  "Atlantic/Madeira": "PT",
  "Atlantic/Reykjavik": "IS",
  "Indian/Mayotte": "YT",
  "Indian/Reunion": "RE",
  Eire: "IE",
  GB: "GB",
  "GB-Eire": "GB",
  Iceland: "IS",
  Poland: "PL",
  Portugal: "PT",
  CET: null,
  EET: null,
  MET: null,
  WET: null,
};

/**
 * ISO country region of a BCP 47 tag or POSIX locale (`de-DE`, `de_DE.UTF-8`, `sr-Latn-RS`,
 * `en_GB@euro`), upper-cased; null for language-only tags, numeric regions (`es-419`),
 * `C`/`POSIX` and garbage.
 */
export function localeRegion(locale: string): string | null {
  const tag = locale.trim().split(/[.@]/)[0]!.replace(/_/g, "-");
  if (!tag || tag === "C" || tag === "POSIX") return null;
  try {
    const region = new Intl.Locale(tag).region;
    if (region) return /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : null;
  } catch {
    /* not a valid BCP 47 tag; fall through to the subtag scan */
  }
  const subtag = tag.split("-").slice(1).find((part) => /^[A-Za-z]{2}$/.test(part));
  return subtag ? subtag.toUpperCase() : null;
}

export type ConsentRegionSignal = "time-zone" | "locale";

export type ConsentRegionDetection = {
  likelyInRegion: boolean;
  /** Which signal matched first; null when neither did. */
  signal: ConsentRegionSignal | null;
  /** The matching country, when the signal names one. */
  country: string | null;
};

/** Whether the time zone or any locale region points into `CONSENT_REGION_COUNTRIES`. */
export function detectConsentRegion(input: {
  timeZone?: string | null | undefined;
  locales?: readonly (string | null | undefined)[] | undefined;
}): ConsentRegionDetection {
  const zone = input.timeZone?.trim();
  if (zone && Object.hasOwn(CONSENT_REGION_TIME_ZONES, zone))
    return { likelyInRegion: true, signal: "time-zone", country: CONSENT_REGION_TIME_ZONES[zone] ?? null };
  for (const locale of input.locales ?? []) {
    const region = locale ? localeRegion(locale) : null;
    if (region && CONSENT_REGION_COUNTRIES.has(region))
      return { likelyInRegion: true, signal: "locale", country: region };
  }
  return { likelyInRegion: false, signal: null, country: null };
}
