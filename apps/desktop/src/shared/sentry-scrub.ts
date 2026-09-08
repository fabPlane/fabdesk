/**
 * Scrubbing for Sentry events and breadcrumbs, shared by the Electron main and renderer processes.
 *
 * The daemon is reached with a bearer token that also travels as `?token=` on the SSE (`/events`) and
 * WebSocket (`/ws`) URLs, so anything Sentry records about those requests must lose the token. Request
 * bodies, cookies and auth headers are dropped outright; they are never useful for a bug report.
 *
 * The shapes below are the subset of Sentry's `Event` / `Breadcrumb` these helpers touch, so the module
 * has no dependency on the SDK and can be unit-tested with bun.
 */

export interface ScrubbableBreadcrumb {
  type?: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ScrubbableRequest {
  url?: string;
  data?: unknown;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  query_string?: unknown;
}

export interface ScrubbableEvent {
  message?: string;
  extra?: Record<string, unknown>;
  request?: ScrubbableRequest;
  breadcrumbs?: ScrubbableBreadcrumb[];
  exception?: { values?: Array<{ value?: string }> };
}

export const FILTERED = "[Filtered]";

/** Query-string keys whose values are replaced. */
const SECRET_QUERY_KEYS = [
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "api_key",
  "apikey",
];
/** Header names (case-insensitive) that are removed from captured requests. */
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);
/** Object keys (case-insensitive) whose values are replaced wherever they appear in breadcrumb data. */
const SECRET_DATA_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "password",
  "secret",
  "cookie",
  "api_key",
  "apikey",
]);

const QUERY_SECRET_RE = new RegExp(`([?&#](?:${SECRET_QUERY_KEYS.join("|")})=)[^&#\\s"']*`, "gi");
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;
/** Absolute paths to project files (they sit under the user's home): keep only the file name. */
const PROJECT_FILE_RE =
  /(?<![\w:./\\-])(?:[A-Za-z]:)?[\\/](?:[^\s"'`<>]*[\\/])?(fabdesk\.json|circuit(?:\.netlist|\.routed)?\.(?:tsx|json))\b/g;
/** `extra` keys that could carry prompts, file contents or credentials are removed outright. */
const SECRET_EXTRA_KEY_RE =
  /prompt|circuit|source|content|file|path|body|token|secret|password|cookie|auth|env/i;

/** Replaces secret query-string values and bearer tokens in any text (URLs, messages, exception values). */
export function scrubText(text: string): string {
  return text
    .replace(QUERY_SECRET_RE, `$1${FILTERED}`)
    .replace(BEARER_RE, `$1${FILTERED}`)
    .replace(PROJECT_FILE_RE, "[project]/$1");
}

/** True for the daemon's token-bearing stream URLs (`/events?token=`, `/ws?token=`) whose breadcrumbs are dropped. */
export function isTokenStreamUrl(url: string): boolean {
  return /\/(?:events|ws)\?(?:.*&)?token=/i.test(url);
}

function scrubUnknown(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (!value || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => scrubUnknown(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_DATA_KEYS.has(k.toLowerCase()) ? FILTERED : scrubUnknown(v, depth + 1);
  }
  return out;
}

/**
 * `beforeBreadcrumb`: returns `null` (drop) for the token-bearing stream URLs, otherwise the breadcrumb
 * with URLs, messages and secret-looking data keys filtered.
 */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T | null {
  const data = breadcrumb.data;
  const url = typeof data?.["url"] === "string" ? data["url"] : undefined;
  if (url && isTokenStreamUrl(url)) return null;
  if (breadcrumb.message && isTokenStreamUrl(breadcrumb.message)) return null;
  const out: T = { ...breadcrumb };
  if (typeof out.message === "string") out.message = scrubText(out.message);
  if (data) {
    const scrubbed = scrubUnknown(data) as Record<string, unknown>;
    // Request/response headers on fetch breadcrumbs are never worth keeping.
    delete scrubbed["headers"];
    delete scrubbed["request_headers"];
    delete scrubbed["response_headers"];
    out.data = scrubbed;
  }
  return out;
}

/**
 * `beforeSend`: strips request bodies, cookies and auth headers, filters tokens out of URLs, messages and
 * exception values, and applies `scrubBreadcrumb` to the attached breadcrumb trail.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    const req: ScrubbableRequest = { ...event.request };
    delete req.data;
    delete req.cookies;
    delete req.query_string;
    if (req.url) req.url = scrubText(req.url);
    if (req.headers) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        if (!SECRET_HEADERS.has(k.toLowerCase())) headers[k] = scrubText(v);
      req.headers = headers;
    }
    event.request = req;
  }
  if (typeof event.message === "string") event.message = scrubText(event.message);
  if (event.extra) {
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event.extra))
      if (!SECRET_EXTRA_KEY_RE.test(k)) extra[k] = scrubUnknown(v);
    event.extra = extra;
  }
  if (event.exception?.values) {
    event.exception = {
      ...event.exception,
      values: event.exception.values.map((v) =>
        typeof v.value === "string" ? { ...v, value: scrubText(v.value) } : v,
      ),
    };
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map((b) => scrubBreadcrumb(b))
      .filter((b): b is ScrubbableBreadcrumb => b !== null);
  }
  return event;
}
