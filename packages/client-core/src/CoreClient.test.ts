import { describe, expect, test } from "bun:test";
import { CoreClient } from "./CoreClient";

describe("CoreClient open-source preview URL", () => {
  test("openSourcePreviewUrl is a loopback img src with the query token", () => {
    const client = new CoreClient({
      baseUrl: "http://127.0.0.1:47831",
      token: "tok",
      fetch: async () => new Response("x"),
    });
    expect(client.openSourcePreviewUrl("tensorfleet/koyomi-lvds-hat")).toBe(
      "http://127.0.0.1:47831/opensource/preview/tensorfleet/koyomi-lvds-hat?token=tok",
    );
    expect(client.openSourcePreviewUrl("tensorfleet/koyomi-lvds-hat", "hero")).toBe(
      "http://127.0.0.1:47831/opensource/preview/tensorfleet/koyomi-lvds-hat?token=tok&role=hero",
    );
    expect(client.openSourcePreviewUrl("bad")).toBe("");
  });
});

describe("CoreClient board comments", () => {
  test("pins and lists comments on encoded project ids", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const client = new CoreClient({
      baseUrl: "http://127.0.0.1:47831",
      token: "tok",
      fetch: async (input, init) => {
        calls.push({ url: input, method: init?.method });
        return Response.json({
          contract: { name: "fabplane.board-comments", version: "1.0.0" },
          comments: [],
        });
      },
    });
    await client.listComments("project/one");
    await client.pinComment("project/one", {
      question: "What is this?",
      anchor: { view: "pcb", ref: "U1" },
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:47831/projects/project%2Fone/comments");
    expect(calls[1]?.method).toBe("POST");
  });
});

describe("CoreClient finish-it", () => {
  test("encodes the project id on start/stop/get", async () => {
    const requested: string[] = [];
    const session = {
      id: "fin_1",
      projectId: "project/one",
      threadId: "th_1",
      runId: null,
      status: "running",
      currentMilestone: "schematic",
      milestones: [],
      commits: [],
      error: null,
      startedAt: "2026-10-08T00:00:00.000Z",
      endedAt: null,
    };
    const client = new CoreClient({
      baseUrl: "http://127.0.0.1:47831",
      token: "tok",
      fetch: async (input, init) => {
        requested.push(`${init?.method ?? "GET"} ${input}`);
        return Response.json({ session });
      },
    });
    expect((await client.getFinishIt("project/one")).session?.id).toBe("fin_1");
    await client.startFinishIt("project/one", { agentId: "claude" });
    await client.stopFinishIt("project/one");
    expect(requested).toEqual([
      "GET http://127.0.0.1:47831/projects/project%2Fone/finish-it",
      "POST http://127.0.0.1:47831/projects/project%2Fone/finish-it",
      "POST http://127.0.0.1:47831/projects/project%2Fone/finish-it/stop",
    ]);
  });
});

describe("CoreClient route runs", () => {
  test("lists persisted runs for an encoded project id", async () => {
    let requested = "";
    const client = new CoreClient({
      baseUrl: "http://127.0.0.1:47831",
      token: "tok",
      fetch: async (input) => {
        requested = input;
        return Response.json([]);
      },
    });

    expect(await client.listRouteRuns("project/one")).toEqual([]);
    expect(requested).toBe("http://127.0.0.1:47831/projects/project%2Fone/route-runs");
  });
});

describe("CoreClient push registration (docs/mobile-notifications.md §4.1)", () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new CoreClient({
    baseUrl: "http://127.0.0.1:47831/",
    token: "dev-tok",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  test("registerPush PUTs the registration with the device bearer", async () => {
    calls.length = 0;
    await client.registerPush({
      pushToken: "a".repeat(64),
      platform: "ios",
      prefs: { onDone: true, onFailed: true, onNeedsInput: true, onJobs: false },
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:47831/v1/devices/me/push");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer dev-tok",
    );
    expect(JSON.parse(calls[0]?.init?.body as string)).toMatchObject({
      pushToken: "a".repeat(64),
      platform: "ios",
    });
  });

  test("transcribeSpeech posts multipart without a JSON content-type", async () => {
    calls.length = 0;
    await client.transcribeSpeech({
      audio: new Blob([new Uint8Array([1])], { type: "audio/webm" }),
      filename: "clip.webm",
      language: "en",
    });
    expect(calls.at(-1)?.url).toBe("http://127.0.0.1:47831/v1/speech/transcribe");
    expect(calls.at(-1)?.init?.method).toBe("POST");
    expect(calls.at(-1)?.init?.body).toBeInstanceOf(FormData);
    expect((calls.at(-1)?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer dev-tok",
    );
    expect((calls.at(-1)?.init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  test("unregisterPush DELETEs, deviceMe GETs", async () => {
    calls.length = 0;
    await client.unregisterPush();
    await client.deviceMe();
    expect(calls.map((c) => [c.init?.method ?? "GET", c.url])).toEqual([
      ["DELETE", "http://127.0.0.1:47831/v1/devices/me/push"],
      ["GET", "http://127.0.0.1:47831/v1/devices/me"],
    ]);
  });
});

test("assembly inspection encodes project identity and returns the read-only response", async () => {
  let requested = "";
  const result = { projectId: "project/one", mode: "single" as const, assembly: null, manifestSha256: null, sources: [], observedAt: new Date().toISOString(), editing: "single-board-only" as const };
  const client = new CoreClient({ baseUrl: "http://127.0.0.1:47831", token: "tok", fetch: async (input) => { requested = input; return Response.json(result); } });
  expect(await client.inspectBoardSources("project/one")).toEqual(result);
  expect(requested).toBe("http://127.0.0.1:47831/projects/project%2Fone/board-sources");
});
