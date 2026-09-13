import { describe, expect, test } from "bun:test";
import type { CloudSettings } from "@fabdesk/protocol";
import {
  fetchCloudSettings,
  mergeCloudSettings,
  overlayCloudSettings,
  putCloudSettings,
} from "./cloud-settings";

const ORIGIN = "https://api.fabplane.test";
const TOKEN = "fpd_test";

const sample: CloudSettings = {
  schema: 1,
  updatedAt: 1_700_000_000_000,
  appearance: "dark",
  haptics: false,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchOf = (fn: () => Promise<Response>): typeof fetch => fn as unknown as typeof fetch;

describe("fetchCloudSettings", () => {
  test("parses a stored document", async () => {
    const got = await fetchCloudSettings(fetchOf(async () => jsonResponse(200, sample)), ORIGIN, TOKEN);
    expect(got).toEqual({ ok: true, settings: sample });
  });

  test("404 is empty, not an error — older APIs and first-time accounts", async () => {
    const got = await fetchCloudSettings(fetchOf(async () => new Response("", { status: 404 })), ORIGIN, TOKEN);
    expect(got).toEqual({ ok: true, settings: null });
  });

  test("401 is ok:false so the caller can sign out", async () => {
    const got = await fetchCloudSettings(fetchOf(async () => new Response("", { status: 401 })), ORIGIN, TOKEN);
    expect(got).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  test("strips unknown keys rather than rejecting the document", async () => {
    const got = await fetchCloudSettings(
      fetchOf(async () => jsonResponse(200, { ...sample, extra: true, schema: 1 })),
      ORIGIN,
      TOKEN,
    );
    expect(got.ok && got.settings).toEqual(sample);
  });
});

describe("putCloudSettings", () => {
  test("returns the body the server stored", async () => {
    const got = await putCloudSettings(fetchOf(async () => jsonResponse(200, sample)), ORIGIN, TOKEN, sample);
    expect(got).toEqual({ ok: true, settings: sample });
  });

  test("404 means the route is not deployed yet", async () => {
    const got = await putCloudSettings(
      fetchOf(async () => new Response("", { status: 404 })),
      ORIGIN,
      TOKEN,
      sample,
    );
    expect(got).toEqual({ ok: false, status: 404, error: "not_found" });
  });
});

describe("mergeCloudSettings", () => {
  const older: CloudSettings = { schema: 1, updatedAt: 10, appearance: "light" };
  const newer: CloudSettings = { schema: 1, updatedAt: 20, appearance: "dark" };

  test("empty remote means push local", () => {
    expect(mergeCloudSettings(older, null)).toEqual({ next: older, push: true, apply: false });
  });

  test("newer remote wins", () => {
    expect(mergeCloudSettings(older, newer)).toEqual({ next: newer, push: false, apply: true });
  });

  test("newer local is pushed", () => {
    expect(mergeCloudSettings(newer, older)).toEqual({ next: newer, push: true, apply: false });
  });

  test("equal timestamps keep local and skip the network", () => {
    expect(mergeCloudSettings(older, { ...newer, updatedAt: 10 })).toEqual({
      next: older,
      push: false,
      apply: false,
    });
  });
});

describe("overlayCloudSettings", () => {
  test("keeps keys the patch omitted so a phone PUT cannot wipe daemon fields", () => {
    const base: CloudSettings = {
      schema: 1,
      updatedAt: 10,
      appearance: "dark",
      defaultAgent: "claude",
      errorReporting: true,
    };
    const phone: CloudSettings = { schema: 1, updatedAt: 20, appearance: "light", haptics: false };
    expect(overlayCloudSettings(base, phone)).toEqual({
      schema: 1,
      updatedAt: 20,
      appearance: "light",
      haptics: false,
      defaultAgent: "claude",
      errorReporting: true,
    });
  });

  test("a missing base is the patch unchanged", () => {
    const phone: CloudSettings = { schema: 1, updatedAt: 1, haptics: true };
    expect(overlayCloudSettings(null, phone)).toEqual(phone);
  });
});
