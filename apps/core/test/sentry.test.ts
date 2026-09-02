import { describe, expect, test } from "bun:test";
import { getClient, isInitialized } from "@sentry/bun";
import {
  applyErrorReporting,
  captureCoreException,
  initSentry,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  sentryActive,
  sentryDsn,
  sentryEnvironment,
  sentryRelease,
  sentryUserFromAuth,
} from "../src/sentry";

describe("initSentry", () => {
  test("is a no-op without a DSN", async () => {
    const env = { ...process.env };
    delete env["SENTRY_DESKTOP_DSN"];
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
    expect(initSentry({ env: { SENTRY_DESKTOP_DSN: "   " } })).toBe(false);
    expect(isInitialized()).toBe(false);
  });
});

describe("sentry config", () => {
  test("dsn: SENTRY_DESKTOP_DSN first, FABDESK_SENTRY_DSN as fallback; blank means off", () => {
    expect(
      sentryDsn({
        SENTRY_DESKTOP_DSN: "https://key@o1.ingest.sentry.io/1",
        FABDESK_SENTRY_DSN: "https://old@o1.ingest.sentry.io/2",
      }),
    ).toBe("https://key@o1.ingest.sentry.io/1");
    expect(sentryDsn({ FABDESK_SENTRY_DSN: "https://old@o1.ingest.sentry.io/2" })).toBe(
      "https://old@o1.ingest.sentry.io/2",
    );
    expect(sentryDsn({ SENTRY_DESKTOP_DSN: "" })).toBeUndefined();
    expect(sentryDsn({})).toBeUndefined();
  });

  test("environment and release fall back to development / +dev outside a compiled binary", () => {
    expect(sentryEnvironment({})).toBe("development");
    expect(sentryEnvironment({ SENTRY_ENVIRONMENT: "staging" })).toBe("staging");
    expect(sentryEnvironment({ FABDESK_SENTRY_ENVIRONMENT: "legacy" })).toBe("legacy");
    expect(sentryRelease({})).toMatch(/^fabdesk-core@\d+\.\d+\.\d+\+dev$/);
    expect(sentryRelease({ SENTRY_RELEASE: "fabdesk-core@1.2.3+abc1234" })).toBe(
      "fabdesk-core@1.2.3+abc1234",
    );
  });
});

describe("sentryUserFromAuth", () => {
  test("id + handle only, never email; local:dev in local mode; null unless signed in", () => {
    expect(
      sentryUserFromAuth({
        mode: "fabplane",
        status: "signed_in",
        principal: { subject: "usr_1", handle: "ada", email: "ada@example.com" },
      }),
    ).toEqual({ id: "usr_1", username: "ada" });
    expect(
      sentryUserFromAuth({
        mode: "local",
        status: "signed_in",
        principal: { subject: "local:dev", handle: "local" },
      }),
    ).toEqual({ id: "local:dev", username: "local" });
    expect(sentryUserFromAuth({ mode: "fabplane", status: "signed_out" })).toBeNull();
    expect(sentryUserFromAuth(null)).toBeNull();
  });
});

describe("scrubbing", () => {
  test("strips bodies, cookies, auth headers, tokens and project paths", () => {
    const out = scrubEvent({
      message: "EventSource http://127.0.0.1:1/events?token=abc",
      extra: { prompt: "design a board", circuitTsx: "<board/>", retries: 1 },
      request: {
        url: "http://127.0.0.1:1/threads/1/messages?token=abc",
        data: { prompt: "secret" },
        cookies: { a: "b" },
        headers: { Authorization: "Bearer x", Accept: "*/*" },
      },
      exception: {
        values: [{ value: "Bearer abc.def failed: /Users/me/Fabdesk/blinky/circuit.tsx" }],
      },
      breadcrumbs: [
        { data: { url: "http://127.0.0.1:1/events?token=abc" } },
        { message: "ok", data: { url: "http://127.0.0.1:1/jobs?token=abc", headers: { a: "b" } } },
      ],
    });
    expect(out.message).toBe("EventSource http://127.0.0.1:1/events?token=[Filtered]");
    expect(out.extra).toEqual({ retries: 1 });
    expect(out.request).toEqual({
      url: "http://127.0.0.1:1/threads/1/messages?token=[Filtered]",
      headers: { Accept: "*/*" },
    });
    expect(out.exception!.values![0]!.value).toBe(
      "Bearer [Filtered] failed: [project]/circuit.tsx",
    );
    expect(out.breadcrumbs).toEqual([
      { message: "ok", data: { url: "http://127.0.0.1:1/jobs?token=[Filtered]" } },
    ]);
  });

  test("project file paths keep only the file name", () => {
    expect(scrubText("ENOENT: '/Users/me/Fabdesk/blinky/fabdesk.json'")).toBe(
      "ENOENT: '[project]/fabdesk.json'",
    );
    expect(scrubText("C:\\Users\\me\\Fabdesk\\b\\circuit.routed.json")).toBe(
      "[project]/circuit.routed.json",
    );
  });

  test("drops token stream breadcrumbs", () => {
    expect(scrubBreadcrumb({ data: { url: "ws://127.0.0.1:1/ws?topics=*&token=abc" } })).toBeNull();
    expect(scrubBreadcrumb({ data: { url: "http://127.0.0.1:1/health" } })).toEqual({
      data: { url: "http://127.0.0.1:1/health" },
    });
  });
});
