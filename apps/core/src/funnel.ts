/**
 * Onboarding funnel: first-of-step events locally, optional PostHog `/capture/` (no SDK).
 * Capture is a complete no-op when POSTHOG_KEY is unset. Events never include prompts,
 * board files, tokens, emails, project names or paths.
 */
import { randomUUID } from "node:crypto";
import {
  appendFunnelHandoffToUrl,
  productAnalyticsAllowed,
  collectFunnelHandoff,
  FunnelHandoff,
  FunnelSnapshot,
  isEmptyFunnelHandoff,
  mergeFunnelHandoff,
  type FunnelEventName,
  type FunnelEventRecord,
} from "@fabdesk/protocol";
import { VERSION } from "./config";
import type { Store } from "./db";
import type { DesignService } from "@fabdesk/tools";
import { logger, errMsg } from "./log";

declare const FABDESK_POSTHOG_KEY: string | undefined;
declare const FABDESK_POSTHOG_HOST: string | undefined;

const ANON_KEY = "funnel_anon_distinct_id";
const HANDOFF_KEY = "funnel_handoff";
const SUBJECT_KEY = "funnel_identified_subject";
const DEFAULT_HOST = "https://us.i.posthog.com";

/** First defined runtime value wins; an explicitly empty runtime value disables the compiled-in fallback. */
export function pick(
  runtime: Array<string | undefined>,
  compiled: Array<string | undefined>,
): string | undefined {
  const rt = runtime.find((v) => v !== undefined);
  if (rt !== undefined) return rt.trim() || undefined;
  return compiled.find((v) => v !== undefined && v.trim() !== "")?.trim();
}

const compiledKey = (): string | undefined =>
  typeof FABDESK_POSTHOG_KEY === "string" ? FABDESK_POSTHOG_KEY : undefined;
const compiledHost = (): string | undefined =>
  typeof FABDESK_POSTHOG_HOST === "string" ? FABDESK_POSTHOG_HOST : undefined;

export function posthogKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return pick(
    [env["POSTHOG_KEY"], env["POSTHOG_PROJECT_API_KEY"], env["FABDESK_POSTHOG_KEY"]],
    [compiledKey()],
  );
}

export function posthogHost(env: NodeJS.ProcessEnv = process.env): string {
  return (
    pick([env["POSTHOG_HOST"], env["FABDESK_POSTHOG_HOST"]], [compiledHost()]) ?? DEFAULT_HOST
  );
}

function toolName(raw: string): string {
  return raw.replace(/^mcp__.+?__/, "").replace(/^functions\./, "");
}

const TOOL_EVENTS: Record<string, FunnelEventName[]> = {
  project_import_kicad: ["onboarding_first_project", "onboarding_first_kicad_import"],
  route_run: ["onboarding_first_route"],
  board_review: ["onboarding_first_review_viewed"],
  pcb_inspect: ["onboarding_first_board_viewed"],
  board_viewer: ["onboarding_first_board_viewed"],
};

export type FunnelCapture = {
  event: string;
  distinct_id: string;
  properties?: Record<string, unknown>;
};

const FAILURE_KINDS = ["build_failed", "empty_board", "exception", "failed", "tool_error"] as const;
type FailureKind = (typeof FAILURE_KINDS)[number];
const TOOL_GROUPS = ["build", "route", "review", "import", "other"] as const;
type ToolGroup = (typeof TOOL_GROUPS)[number];
const ERROR_EVENTS = {
  board_build: "onboarding_first_board_build_error",
  ai_run: "onboarding_first_ai_run_error",
  tool: "onboarding_first_tool_error",
} as const satisfies Record<string, FunnelEventName>;

/** Observe the actual build, including calls made over external MCP/HTTP clients.
 * Agent tool_result messages alone are not evidence that a board was built.
 * This is a generated non-empty board, not a DRC pass or manufacturing approval.
 */
export function trackBoardBuilds(design: Pick<DesignService, "build">, funnel: Funnel): void {
  const build = design.build.bind(design);
  design.build = async (options) => {
    let result;
    try {
      result = await build(options);
    } catch (error) {
      // User cancellation is not a product failure. Never send exception text.
      const cancelled = options.signal?.aborted ||
        (error instanceof Error && (error.name === "AbortError" || "code" in error && error.code === "cancelled"));
      if (!cancelled) funnel.noteError("board_build", "exception");
      throw error;
    }
    if (!result.ok && !options.signal?.aborted) funnel.noteError("board_build", "build_failed");
    else if (result.ok && result.counts.components <= 0) funnel.noteError("board_build", "empty_board");
    if (result.ok && result.counts.components > 0) {
      try {
        funnel.record("onboarding_first_board_built");
      } catch (error) {
        // Analytics must not turn a successfully generated board into a tool failure.
        logger.warn("board activation recording failed", { error: errMsg(error) });
      }
    }
    return result;
  };
}

export class Funnel {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private consentRevision = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: {
      store: Store;
      fetch?: typeof fetch;
      now?: () => Date;
      env?: NodeJS.ProcessEnv;
    },
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.env = opts.env ?? process.env;
  }

  /** Invalidate work queued during a previous consent period. */
  consentChanged(): void {
    this.consentRevision++;
  }

  captureEnabled(): boolean {
    return Boolean(posthogKey(this.env));
  }

  optedIn(): boolean {
    return productAnalyticsAllowed(this.opts.store.settings.get());
  }

  handoff(): FunnelHandoff {
    const raw = this.opts.store.settings.readRaw(HANDOFF_KEY);
    const parsed = FunnelHandoff.safeParse(raw);
    return parsed.success ? parsed.data : {};
  }

  identifiedSubject(): string | null {
    const raw = this.opts.store.settings.readRaw(SUBJECT_KEY);
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  }

  distinctId(): string {
    return this.identifiedSubject() ?? this.anonDistinctId();
  }

  decorateLoginUrl(url: string): string {
    return appendFunnelHandoffToUrl(url, this.handoff());
  }

  adoptFromProcess(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = this.env): FunnelHandoff {
    return this.adopt(collectFunnelHandoff({ argv, env }));
  }

  adopt(incoming: FunnelHandoff): FunnelHandoff {
    if (isEmptyFunnelHandoff(incoming)) return this.handoff();
    const merged = mergeFunnelHandoff(this.handoff(), incoming);
    this.opts.store.settings.writeRaw(HANDOFF_KEY, merged);
    const phId = merged.phId?.trim();
    if (phId) this.adoptAnonymousId(phId);
    return merged;
  }

  record(event: FunnelEventName, extra?: Record<string, string>): boolean {
    if (!this.optedIn()) return false;
    const distinctId = this.distinctId();
    if (!this.opts.store.funnel.insert(distinctId, event, this.now().toISOString())) return false;
    const properties = this.eventProperties(extra);
    this.enqueue(() => this.capture({ event, distinct_id: distinctId, properties }));
    return true;
  }

  /** Drop the signed-in subject and mint a new anon id. First-touch handoff stays install-level. */
  resetIdentity(): void {
    this.opts.store.settings.deleteRaw(SUBJECT_KEY);
    this.opts.store.settings.writeRaw(ANON_KEY, `anon_${randomUUID()}`);
  }

  identify(subject: string): void {
    const id = subject.trim();
    if (!id || !this.optedIn()) return;
    if (this.identifiedSubject() === id) return;
    const anon = this.adoptedOrMintedAnon();
    this.opts.store.settings.writeRaw(SUBJECT_KEY, id);
    const once = this.setOnceProperties();
    this.enqueue(() =>
      this.capture({
        event: "$identify",
        distinct_id: id,
        properties: {
          $anon_distinct_id: anon,
          ...(Object.keys(once).length > 0 ? { $set_once: once } : {}),
        },
      }),
    );
    this.record("onboarding_signed_in");
  }

  noteTool(name: string): void {
    const events = TOOL_EVENTS[toolName(name)];
    if (!events) return;
    for (const event of events) this.record(event);
  }

  /** First error at each stage, on the same attributed person as activation.
   * Counts affected people, not total errors; detailed diagnostics stay in Sentry.
   */
  noteError(stage: keyof typeof ERROR_EVENTS, kind: FailureKind, tool?: string): boolean {
    const name = toolName(tool ?? "");
    const group: ToolGroup = name === "circuit_build" ? "build"
      : name.startsWith("route_") || name === "board_route" ? "route"
      : name === "board_review" ? "review"
      : name === "project_import_kicad" ? "import" : "other";
    try {
      return this.record(ERROR_EVENTS[stage], {
        failure_kind: kind,
        ...(stage === "tool" ? { tool_group: group } : {}),
      });
    } catch (error) {
      logger.warn("onboarding error recording failed", { error: errMsg(error) });
      return false;
    }
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  snapshot(): FunnelSnapshot {
    const distinctId = this.distinctId();
    return FunnelSnapshot.parse({
      captureEnabled: this.captureEnabled(),
      optedIn: this.optedIn(),
      distinctId,
      identifiedSubject: this.identifiedSubject(),
      handoff: this.handoff(),
      events: this.opts.store.funnel.list(),
    });
  }

  renderHtml(snap: FunnelSnapshot = this.snapshot()): string {
    const rows = snap.events
      .map(
        (e) =>
          `<tr><td>${escapeHtml(e.event)}</td><td>${escapeHtml(e.distinctId)}</td><td>${escapeHtml(e.recordedAt)}</td></tr>`,
      )
      .join("");
    const handoff = Object.entries(snap.handoff)
      .map(([k, v]) => `<li><code>${escapeHtml(k)}</code> ${escapeHtml(String(v))}</li>`)
      .join("");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Onboarding funnel</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#111}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}code{font-size:12px}</style>
</head><body>
<h1>Onboarding funnel</h1>
<p>capture ${snap.captureEnabled ? "on" : "off"} · opted ${snap.optedIn ? "in" : "out"} · distinct_id <code>${escapeHtml(snap.distinctId)}</code></p>
<h2>First-touch</h2>
${handoff ? `<ul>${handoff}</ul>` : "<p>none</p>"}
<h2>Events</h2>
<table><thead><tr><th>event</th><th>distinct_id</th><th>recorded_at</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
  }

  private anonDistinctId(): string {
    const existing = this.readAnon();
    if (existing) return existing;
    const minted = `anon_${randomUUID()}`;
    this.opts.store.settings.writeRaw(ANON_KEY, minted);
    return minted;
  }

  private adoptedOrMintedAnon(): string {
    return this.readAnon() ?? this.anonDistinctId();
  }

  private readAnon(): string | null {
    const raw = this.opts.store.settings.readRaw(ANON_KEY);
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  }

  private adoptAnonymousId(phId: string): void {
    const existing = this.readAnon();
    if (!existing) {
      this.opts.store.settings.writeRaw(ANON_KEY, phId);
      return;
    }
    if (existing === phId) return;
    if (this.optedIn()) {
      this.enqueue(() =>
        this.capture({
          event: "$create_alias",
          distinct_id: existing,
          properties: { alias: phId },
        }),
      );
    }
    this.opts.store.settings.writeRaw(ANON_KEY, phId);
  }

  private eventProperties(extra?: Record<string, string>): Record<string, string> {
    const handoff = this.handoff();
    const props: Record<string, string> = { $lib: "fabdesk-core", $lib_version: VERSION };
    if (handoff.utmSource) props.utm_source = handoff.utmSource;
    if (handoff.utmMedium) props.utm_medium = handoff.utmMedium;
    if (handoff.utmCampaign) props.utm_campaign = handoff.utmCampaign;
    if (handoff.utmContent) props.utm_content = handoff.utmContent;
    if (handoff.utmTerm) props.utm_term = handoff.utmTerm;
    if (handoff.gclid) props.gclid = handoff.gclid;
    if (handoff.referrer) props.referrer = handoff.referrer;
    const source = extra?.["source"];
    if (source === "review" || source === "check" || source === "pcb") props.source = source;
    const failureKind = extra?.["failure_kind"];
    if (FAILURE_KINDS.includes(failureKind as FailureKind)) props.failure_kind = failureKind!;
    const toolGroup = extra?.["tool_group"];
    if (TOOL_GROUPS.includes(toolGroup as ToolGroup)) props.tool_group = toolGroup!;
    return props;
  }

  private setOnceProperties(): Record<string, string> {
    const handoff = this.handoff();
    const once: Record<string, string> = {};
    if (handoff.utmSource) once.utm_source = handoff.utmSource;
    if (handoff.utmMedium) once.utm_medium = handoff.utmMedium;
    if (handoff.utmCampaign) once.utm_campaign = handoff.utmCampaign;
    if (handoff.utmContent) once.utm_content = handoff.utmContent;
    if (handoff.utmTerm) once.utm_term = handoff.utmTerm;
    if (handoff.gclid) once.gclid = handoff.gclid;
    if (handoff.referrer) once.referrer = handoff.referrer;
    return once;
  }

  private enqueue(work: () => Promise<void>): void {
    const revision = this.consentRevision;
    this.queue = this.queue.then(() => {
      if (revision === this.consentRevision && this.optedIn()) return work();
    }).catch((e) => {
      logger.warn("funnel capture failed", { error: errMsg(e) });
    });
  }

  private async capture(body: FunnelCapture): Promise<void> {
    const revision = this.consentRevision;
    const key = posthogKey(this.env);
    if (!key || !this.optedIn()) return;
    const host = posthogHost(this.env).replace(/\/$/, "");
    const properties: Record<string, unknown> = {
      $lib: "fabdesk-core",
      $lib_version: VERSION,
      ...(body.properties ?? {}),
      distinct_id: body.distinct_id,
    };
    const payload = JSON.stringify({
      api_key: key,
      event: body.event,
      properties,
      timestamp: this.now().toISOString(),
    });
    const url = `${host}/capture/`;
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // A queued event or retry must not outlive consent withdrawal.
      if (!this.optedIn() || revision !== this.consentRevision) return;
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        });
        if (res.ok) return;
        lastError = `HTTP ${res.status}`;
        if (res.status < 500) break;
      } catch (e) {
        lastError = errMsg(e);
      }
    }
    logger.warn("funnel capture failed", { error: lastError ?? "unknown" });
  }
}

export function formatFunnelSnapshot(snap: FunnelSnapshot): string {
  const lines = [
    `capture ${snap.captureEnabled ? "on" : "off"}  opted ${snap.optedIn ? "in" : "out"}`,
    `distinct_id  ${snap.distinctId}`,
    snap.identifiedSubject ? `subject      ${snap.identifiedSubject}` : "subject      (anonymous)",
  ];
  const handoff = snap.handoff;
  if (!isEmptyFunnelHandoff(handoff)) {
    lines.push("first-touch");
    for (const [k, v] of Object.entries(handoff)) if (v) lines.push(`  ${k}  ${v}`);
  }
  lines.push("events");
  if (snap.events.length === 0) lines.push("  (none)");
  else for (const e of snap.events) lines.push(`  ${e.recordedAt}  ${e.event}  ${e.distinctId}`);
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type { FunnelEventRecord };
