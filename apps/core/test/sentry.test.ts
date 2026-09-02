import { describe, expect, test } from "bun:test";
import { getClient, isInitialized } from "@sentry/bun";
import {
  applyErrorReporting,
  captureCoreException,
  initSentry,
  scrubBreadcrumb,
  scrubEvent,
  sentryActive,
  sentryDsn,
  sentryEnvironment,
} from "../src/sentry";

describe("initSentry", () => {
  test("is a no-op without a DSN", async () => {
    const env = { ...process.env };
    delete env["FABDESK_SENTRY_DSN"];
    expect(initSentry({ env })).toBe(false);
    expect(sentryActive()).toBe(false);
    expect(isInitialized()).toBe(false);
    expect(getClient()).toBeUndefined();
    // Capture and the opt-out are harmless while inactive.
    captureCoreException(new Error("ignored"), { "job.kind": "test" });
    await applyErrorReporting(false);
    expect(sentryActive()).toBe(false);
  });

  test("an empty runtime DSN disables reporting", () => {
    expect(initSentry({ env: { FABDESK_SENTRY_DSN: "   " } })).toBe(false);
    expect(isInitialized()).toBe(false);
  });
});

describe("sentry config", () => {
  test("dsn comes from FABDESK_SENTRY_DSN; blank means off", () => {
    expect(sentryDsn({ FABDESK_SENTRY_DSN: "https://key@o1.ingest.sentry.io/1" })).toBe(
      "https://key@o1.ingest.sentry.io/1",
    );
    expect(sentryDsn({ FABDESK_SENTRY_DSN: "" })).toBeUndefined();
    expect(sentryDsn({})).toBeUndefined();
  });

  test("environment defaults to development outside a compiled binary", () => {
    expect(sentryEnvironment({})).toBe("development");
    expect(sentryEnvironment({ FABDESK_SENTRY_ENVIRONMENT: "staging" })).toBe("staging");
  });
});

describe("scrubbing", () => {
  test("strips bodies, cookies, auth headers and tokens", () => {
    const out = scrubEvent({
      message: "EventSource http://127.0.0.1:1/events?token=abc",
      request: {
        url: "http://127.0.0.1:1/threads/1/messages?token=abc",
        data: { prompt: "secret" },
        cookies: { a: "b" },
        headers: { Authorization: "Bearer x", Accept: "*/*" },
      },
      exception: { values: [{ value: "Bearer abc.def failed" }] },
      breadcrumbs: [
        { data: { url: "http://127.0.0.1:1/events?token=abc" } },
        { message: "ok", data: { url: "http://127.0.0.1:1/jobs?token=abc", headers: { a: "b" } } },
      ],
    });
    expect(out.message).toBe("EventSource http://127.0.0.1:1/events?token=[Filtered]");
    expect(out.request).toEqual({
      url: "http://127.0.0.1:1/threads/1/messages?token=[Filtered]",
      headers: { Accept: "*/*" },
    });
    expect(out.exception!.values![0]!.value).toBe("Bearer [Filtered] failed");
    expect(out.breadcrumbs).toEqual([
      { message: "ok", data: { url: "http://127.0.0.1:1/jobs?token=[Filtered]" } },
    ]);
  });

  test("drops token stream breadcrumbs", () => {
    expect(scrubBreadcrumb({ data: { url: "ws://127.0.0.1:1/ws?topics=*&token=abc" } })).toBeNull();
    expect(scrubBreadcrumb({ data: { url: "http://127.0.0.1:1/health" } })).toEqual({
      data: { url: "http://127.0.0.1:1/health" },
    });
  });
});
