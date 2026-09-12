/**
 * The relay's wire protocol. All frames are JSON text on one WebSocket per daemon; every frame
 * carries a `sid` naming the client request or socket it belongs to, so many phones multiplex
 * over the single daemon connection.
 *
 * The daemon side (`apps/core/src/relay.ts`) mirrors these shapes rather than importing them:
 * this package is meant to be ported to whatever hosts the production relay and stays free of
 * fabdesk's other packages.
 */
import { z } from "zod/v4";

export const Sid = z.string().min(1).max(64);
export const BodyEncoding = z.enum(["utf8", "base64"]);
export type BodyEncoding = z.infer<typeof BodyEncoding>;
const HeaderMap = z.record(z.string(), z.string());

/** Relay → daemon. */
export const RelayToDaemon = z.discriminatedUnion("t", [
  /** One HTTP request to answer with exactly one `resp` frame. `body` is absent for GET and friends. */
  z.object({
    t: z.literal("open"),
    sid: Sid,
    method: z.string().min(1).max(16),
    /** Path and query as the client sent them, without the `/c/<coreId>` prefix. */
    path: z.string().min(1),
    headers: HeaderMap,
    body: z.string().optional(),
    bodyEncoding: BodyEncoding.optional(),
  }),
  /** A client opened `/c/<coreId>/ws?…`; `headers` carries its Authorization when it sent one. */
  z.object({
    t: z.literal("ws-open"),
    sid: Sid,
    path: z.string().min(1),
    headers: HeaderMap.optional(),
  }),
  z.object({ t: z.literal("ws-msg"), sid: Sid, data: z.string() }),
  /** The client socket went away. */
  z.object({
    t: z.literal("close"),
    sid: Sid,
    code: z.number().int().optional(),
    reason: z.string().optional(),
  }),
]);
export type RelayToDaemon = z.infer<typeof RelayToDaemon>;

/** Daemon → relay. */
export const DaemonToRelay = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("resp"),
    sid: Sid,
    status: z.number().int().min(100).max(599),
    headers: HeaderMap,
    body: z.string(),
    bodyEncoding: BodyEncoding,
  }),
  z.object({ t: z.literal("ws-msg"), sid: Sid, data: z.string() }),
  /** The daemon refused or dropped a proxied socket; the relay closes the client with `code`. */
  z.object({
    t: z.literal("close"),
    sid: Sid,
    code: z.number().int().optional(),
    reason: z.string().optional(),
  }),
]);
export type DaemonToRelay = z.infer<typeof DaemonToRelay>;

/** `coreId`s are minted by the daemon as `core_<12 base64url chars>`; anything wider is refused early. */
export const CORE_ID_RE = /^core_[A-Za-z0-9_-]{4,64}$/;

/** Bodies over this are refused with 413 before anything reaches the daemon. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Text-ish payloads travel as UTF-8 so frames stay readable in logs; everything else is base64. */
export function encodingFor(contentType: string | null | undefined): BodyEncoding {
  const ct = (contentType ?? "").toLowerCase();
  return ct.startsWith("text/") ||
    ct.includes("json") ||
    ct.includes("xml") ||
    ct.includes("urlencoded")
    ? "utf8"
    : "base64";
}

export function encodeBody(bytes: Uint8Array, encoding: BodyEncoding): string {
  return encoding === "utf8"
    ? new TextDecoder().decode(bytes)
    : Buffer.from(bytes).toString("base64");
}

export function decodeBody(body: string, encoding: BodyEncoding): Uint8Array<ArrayBuffer> {
  return encoding === "utf8"
    ? new TextEncoder().encode(body)
    : new Uint8Array(Buffer.from(body, "base64"));
}

/** Hop-by-hop headers and the ones the receiving side computes itself. */
const DROP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "sec-websocket-accept",
]);

export function forwardableHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!DROP_HEADERS.has(name.toLowerCase())) out[name.toLowerCase()] = value;
  });
  return out;
}
