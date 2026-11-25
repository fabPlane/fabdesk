/** First-touch attribution copied from fabplane.com `/try` into fabdesk. */
import { z } from "zod/v4";

export const FUNNEL_UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;
export type FunnelUtmKey = (typeof FUNNEL_UTM_KEYS)[number];

export const FUNNEL_QUERY_KEYS = ["ph_id", ...FUNNEL_UTM_KEYS, "gclid", "referrer"] as const;

const REFERRER_ALIASES = ["referrer", "fp_referrer", "ref"] as const;

const TEXT = z.string().trim().min(1).max(512);

export const FunnelHandoff = z
  .object({
    phId: TEXT.optional(),
    utmSource: TEXT.optional(),
    utmMedium: TEXT.optional(),
    utmCampaign: TEXT.optional(),
    utmContent: TEXT.optional(),
    utmTerm: TEXT.optional(),
    gclid: TEXT.optional(),
    referrer: TEXT.optional(),
  });
export type FunnelHandoff = z.infer<typeof FunnelHandoff>;

const QUERY_TO_FIELD = {
  ph_id: "phId",
  utm_source: "utmSource",
  utm_medium: "utmMedium",
  utm_campaign: "utmCampaign",
  utm_content: "utmContent",
  utm_term: "utmTerm",
  gclid: "gclid",
  referrer: "referrer",
} as const satisfies Record<(typeof FUNNEL_QUERY_KEYS)[number], keyof FunnelHandoff>;

const FIELD_TO_QUERY: Record<keyof FunnelHandoff, (typeof FUNNEL_QUERY_KEYS)[number]> = {
  phId: "ph_id",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmContent: "utm_content",
  utmTerm: "utm_term",
  gclid: "gclid",
  referrer: "referrer",
};

const ENV_TO_FIELD = {
  FABDESK_PH_ID: "phId",
  FABDESK_UTM_SOURCE: "utmSource",
  FABDESK_UTM_MEDIUM: "utmMedium",
  FABDESK_UTM_CAMPAIGN: "utmCampaign",
  FABDESK_UTM_CONTENT: "utmContent",
  FABDESK_UTM_TERM: "utmTerm",
  FABDESK_GCLID: "gclid",
  FABDESK_REFERRER: "referrer",
} as const;

/** Strip credentials and query/hash so a document.referrer cannot leak tokens. */
export function sanitizeFunnelReferrer(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const parsed = TEXT.safeParse(value.split(/[?#]/, 1)[0] ?? "");
    return parsed.success ? parsed.data : undefined;
  }
}

function setField(out: FunnelHandoff, field: keyof FunnelHandoff, raw: string | null | undefined): void {
  if (raw == null) return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  const value = field === "referrer" ? sanitizeFunnelReferrer(trimmed) : TEXT.safeParse(trimmed).data;
  if (!value || out[field]) return;
  out[field] = value;
}

export function isEmptyFunnelHandoff(handoff: FunnelHandoff): boolean {
  return Object.keys(handoff).length === 0;
}

const MAX_RETURN_TO_DEPTH = 3;

export function mergeFunnelHandoff(...parts: Array<FunnelHandoff | undefined>): FunnelHandoff {
  const out: FunnelHandoff = {};
  for (const part of parts) {
    if (!part) continue;
    for (const field of Object.keys(FIELD_TO_QUERY) as Array<keyof FunnelHandoff>) {
      const value = part[field];
      if (value && !out[field]) out[field] = value;
    }
  }
  return out;
}

export function funnelHandoffFromSearchParams(params: URLSearchParams, depth = 0): FunnelHandoff {
  const out: FunnelHandoff = {};
  setField(out, "phId", params.get("ph_id"));
  for (const key of FUNNEL_UTM_KEYS) setField(out, QUERY_TO_FIELD[key], params.get(key));
  setField(out, "gclid", params.get("gclid"));
  for (const alias of REFERRER_ALIASES) {
    setField(out, "referrer", params.get(alias));
    if (out.referrer) break;
  }
  if (depth >= MAX_RETURN_TO_DEPTH) return out;
  const returnTo = params.get("return_to");
  if (!returnTo) return out;
  return mergeFunnelHandoff(out, handoffFromHref(returnTo, depth + 1));
}

export function funnelHandoffFromRecord(record: Record<string, unknown>): FunnelHandoff {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") params.set(key, value);
  }
  const parsed = FunnelHandoff.safeParse(record);
  return mergeFunnelHandoff(parsed.success ? parsed.data : {}, funnelHandoffFromSearchParams(params));
}

export type FunnelProcessEnv = Record<string, string | undefined>;

export function funnelHandoffFromEnv(env: FunnelProcessEnv): FunnelHandoff {
  const out: FunnelHandoff = {};
  for (const [envKey, field] of Object.entries(ENV_TO_FIELD) as Array<
    [keyof typeof ENV_TO_FIELD, keyof FunnelHandoff]
  >) {
    setField(out, field, env[envKey]);
  }
  return out;
}

/** Map first-touch fields onto FABDESK_* env so the desktop can pass them to the core sidecar. */
export function funnelHandoffToEnv(handoff: FunnelHandoff): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [envKey, field] of Object.entries(ENV_TO_FIELD) as Array<
    [keyof typeof ENV_TO_FIELD, keyof FunnelHandoff]
  >) {
    const value = handoff[field];
    if (value) out[envKey] = value;
  }
  return out;
}

function handoffFromHref(raw: string, depth = 0): FunnelHandoff {
  const value = raw.trim();
  if (!value) return {};
  try {
    const url = value.includes("://") ? new URL(value) : new URL(value, "https://fabplane.com");
    return funnelHandoffFromSearchParams(url.searchParams, depth);
  } catch {
    return {};
  }
}

export function funnelHandoffFromArgv(argv: readonly string[]): FunnelHandoff {
  let out: FunnelHandoff = {};
  for (const arg of argv) out = mergeFunnelHandoff(out, handoffFromHref(arg));
  return out;
}

export function collectFunnelHandoff(opts: {
  argv?: readonly string[];
  env?: FunnelProcessEnv;
  urls?: readonly string[];
  record?: Record<string, unknown>;
}): FunnelHandoff {
  const fromUrls = (opts.urls ?? []).reduce<FunnelHandoff>(
    (acc, url) => mergeFunnelHandoff(acc, handoffFromHref(url)),
    {},
  );
  return mergeFunnelHandoff(
    funnelHandoffFromArgv(opts.argv ?? []),
    fromUrls,
    opts.record ? funnelHandoffFromRecord(opts.record) : undefined,
    opts.env ? funnelHandoffFromEnv(opts.env) : {},
  );
}

function parseMaybeRelative(raw: string): { url: URL; relative: boolean } | null {
  try {
    return { url: new URL(raw), relative: false };
  } catch {
    try {
      return { url: new URL(raw, "https://fabplane.com"), relative: true };
    } catch {
      return null;
    }
  }
}

function hrefOf(parsed: { url: URL; relative: boolean }): string {
  if (!parsed.relative) return parsed.url.toString();
  return `${parsed.url.pathname}${parsed.url.search}${parsed.url.hash}`;
}

/** Append missing first-touch keys; never overwrite keys the site already set. */
export function appendFunnelHandoffToUrl(rawUrl: string, handoff: FunnelHandoff): string {
  if (isEmptyFunnelHandoff(handoff)) return rawUrl;
  const parsed = parseMaybeRelative(rawUrl);
  if (!parsed) return rawUrl;
  for (const field of Object.keys(FIELD_TO_QUERY) as Array<keyof FunnelHandoff>) {
    const value = handoff[field];
    if (!value) continue;
    const key = FIELD_TO_QUERY[field];
    if (!parsed.url.searchParams.get(key)) parsed.url.searchParams.set(key, value);
  }
  const returnTo = parsed.url.searchParams.get("return_to");
  if (returnTo) parsed.url.searchParams.set("return_to", appendFunnelHandoffToUrl(returnTo, handoff));
  return hrefOf(parsed);
}

export function funnelHandoffQuery(handoff: FunnelHandoff): URLSearchParams {
  const params = new URLSearchParams();
  for (const field of Object.keys(FIELD_TO_QUERY) as Array<keyof FunnelHandoff>) {
    const value = handoff[field];
    if (value) params.set(FIELD_TO_QUERY[field], value);
  }
  return params;
}

export const FUNNEL_EVENTS = [
  "onboarding_landing",
  "onboarding_app_launched",
  "onboarding_sign_in_started",
  "onboarding_signed_in",
  "onboarding_first_project",
  "onboarding_first_ai_run",
  "onboarding_first_review_viewed",
  "onboarding_first_kicad_import",
  "onboarding_first_board_built",
  "onboarding_first_route",
  "onboarding_first_board_viewed",
  "onboarding_first_board_build_error",
  "onboarding_first_ai_run_error",
  "onboarding_first_tool_error",
] as const;
export type FunnelEventName = (typeof FUNNEL_EVENTS)[number];

/** Client-reported activation events (`POST /funnel/events`). */
export const CLIENT_FUNNEL_EVENTS = [
  "onboarding_first_review_viewed",
  "onboarding_first_board_viewed",
] as const satisfies ReadonlyArray<FunnelEventName>;
export type ClientFunnelEvent = (typeof CLIENT_FUNNEL_EVENTS)[number];

export const FunnelEventRecord = z.object({
  distinctId: z.string().min(1),
  event: z.string().min(1),
  recordedAt: z.string().min(1),
});
export type FunnelEventRecord = z.infer<typeof FunnelEventRecord>;

export const FunnelSnapshot = z.object({
  captureEnabled: z.boolean(),
  optedIn: z.boolean(),
  distinctId: z.string().min(1),
  identifiedSubject: z.string().nullable(),
  handoff: FunnelHandoff,
  events: z.array(FunnelEventRecord),
});
export type FunnelSnapshot = z.infer<typeof FunnelSnapshot>;
