import { describe, expect, test } from "bun:test";
import { FILTERED, isTokenStreamUrl, scrubBreadcrumb, scrubEvent, scrubText } from "./sentry-scrub";

describe("scrubText", () => {
  test("filters token-like query values and bearer tokens", () => {
    expect(scrubText("http://127.0.0.1:4321/events?token=abc123&topics=*")).toBe(
      `http://127.0.0.1:4321/events?token=${FILTERED}&topics=*`,
    );
    expect(scrubText("ws://127.0.0.1:4321/ws?topics=job.*&token=abc")).toBe(
      `ws://127.0.0.1:4321/ws?topics=job.*&token=${FILTERED}`,
    );
    expect(scrubText("failed: Authorization: Bearer eyJhbGciOi.abc-def")).toBe(
      `failed: Authorization: Bearer ${FILTERED}`,
    );
    expect(scrubText("http://127.0.0.1:4321/projects/p1?access_token=x#token=y")).toBe(
      `http://127.0.0.1:4321/projects/p1?access_token=${FILTERED}#token=${FILTERED}`,
    );
  });

  test("keeps only the file name of project files", () => {
    expect(scrubText("ENOENT: open '/Users/me/Fabdesk/blinky/fabdesk.json'")).toBe(
      "ENOENT: open '[project]/fabdesk.json'",
    );
    expect(scrubText("parse C:\\Users\\me\\Fabdesk\\blinky\\circuit.tsx failed")).toBe(
      "parse [project]/circuit.tsx failed",
    );
    expect(scrubText("a /x/circuit.routed.json and /y/z/circuit.tsx")).toBe(
      "a [project]/circuit.routed.json and [project]/circuit.tsx",
    );
    // API URLs carry only the project id and a project-relative name; they stay intact.
    expect(scrubText("GET http://127.0.0.1:4321/projects/p1/files/circuit.tsx 404")).toBe(
      "GET http://127.0.0.1:4321/projects/p1/files/circuit.tsx 404",
    );
  });

  test("leaves ordinary text alone", () => {
    expect(scrubText("http://127.0.0.1:4321/projects/p1/files/circuit.tsx")).toBe(
      "http://127.0.0.1:4321/projects/p1/files/circuit.tsx",
    );
    expect(scrubText("tokenizer failed")).toBe("tokenizer failed");
  });
});

describe("isTokenStreamUrl", () => {
  test("matches the SSE and WebSocket stream URLs only", () => {
    expect(isTokenStreamUrl("http://127.0.0.1:1/events?token=t")).toBe(true);
    expect(isTokenStreamUrl("http://127.0.0.1:1/events?topics=*&token=t")).toBe(true);
    expect(isTokenStreamUrl("ws://127.0.0.1:1/ws?token=t")).toBe(true);
    expect(isTokenStreamUrl("http://127.0.0.1:1/projects?token=t")).toBe(false);
    expect(isTokenStreamUrl("http://127.0.0.1:1/events")).toBe(false);
  });
});

describe("scrubBreadcrumb", () => {
  test("drops breadcrumbs for token stream URLs", () => {
    expect(
      scrubBreadcrumb({
        category: "fetch",
        data: { url: "http://127.0.0.1:1/events?token=t", method: "GET" },
      }),
    ).toBeNull();
    expect(
      scrubBreadcrumb({ category: "xhr", data: { url: "ws://127.0.0.1:1/ws?token=t" } }),
    ).toBeNull();
    expect(
      scrubBreadcrumb({ category: "console", message: "opened http://127.0.0.1:1/events?token=t" }),
    ).toBeNull();
  });

  test("scrubs urls, headers and secret keys on kept breadcrumbs", () => {
    const out = scrubBreadcrumb({
      category: "fetch",
      message: "GET http://127.0.0.1:1/jobs?token=t",
      data: {
        url: "http://127.0.0.1:1/jobs?token=t",
        method: "GET",
        headers: { Authorization: "Bearer x" },
        nested: { token: "t", ok: 1 },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.message).toBe(`GET http://127.0.0.1:1/jobs?token=${FILTERED}`);
    expect(out!.data).toEqual({
      url: `http://127.0.0.1:1/jobs?token=${FILTERED}`,
      method: "GET",
      nested: { token: FILTERED, ok: 1 },
    });
  });

  test("does not mutate its input", () => {
    const input = { category: "fetch", data: { url: "http://127.0.0.1:1/jobs?token=t" } };
    scrubBreadcrumb(input);
    expect(input.data.url).toBe("http://127.0.0.1:1/jobs?token=t");
  });
});

describe("scrubEvent", () => {
  test("drops request bodies, cookies and auth headers", () => {
    const out = scrubEvent({
      request: {
        url: "http://127.0.0.1:1/threads/1/messages?token=t",
        data: { prompt: "design a board" },
        cookies: { session: "s" },
        query_string: "token=t",
        headers: {
          Authorization: "Bearer x",
          Cookie: "a=b",
          "Content-Type": "application/json",
          "X-Trace": "Bearer y",
        },
      },
    });
    expect(out.request).toEqual({
      url: `http://127.0.0.1:1/threads/1/messages?token=${FILTERED}`,
      headers: { "Content-Type": "application/json", "X-Trace": `Bearer ${FILTERED}` },
    });
  });

  test("scrubs messages, exception values and the breadcrumb trail", () => {
    const out = scrubEvent({
      message: "EventSource failed for http://127.0.0.1:1/events?token=t",
      exception: {
        values: [{ value: "fetch failed: http://127.0.0.1:1/ws?token=t" }, { value: undefined }],
      },
      breadcrumbs: [
        { category: "fetch", data: { url: "http://127.0.0.1:1/events?token=t" } },
        { category: "fetch", data: { url: "http://127.0.0.1:1/health?token=t" } },
        { category: "ui.click", message: "button" },
      ],
    });
    expect(out.message).toBe(`EventSource failed for http://127.0.0.1:1/events?token=${FILTERED}`);
    expect(out.exception!.values![0]!.value).toBe(
      `fetch failed: http://127.0.0.1:1/ws?token=${FILTERED}`,
    );
    expect(out.exception!.values![1]!.value).toBeUndefined();
    expect(out.breadcrumbs).toEqual([
      { category: "fetch", data: { url: `http://127.0.0.1:1/health?token=${FILTERED}` } },
      { category: "ui.click", message: "button" },
    ]);
  });

  test("removes extra keys that could carry prompts, files or credentials", () => {
    const out = scrubEvent({
      extra: {
        prompt: "design",
        circuitTsx: "<board/>",
        filePath: "/a/b",
        authorization: "x",
        retries: 2,
        note: "see /home/u/p/fabdesk.json",
      },
    });
    expect(out.extra).toEqual({ retries: 2, note: "see [project]/fabdesk.json" });
  });

  test("passes through events without request or breadcrumbs", () => {
    const event = { exception: { values: [{ value: "boom" }] } };
    expect(scrubEvent(event)).toEqual({ exception: { values: [{ value: "boom" }] } });
  });
});
