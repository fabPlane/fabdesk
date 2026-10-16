import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MAX_UPLOAD_BYTES, UsageApiArchiveWriter, type UploadPacing } from "../src/usage-api";
import { ArchiveConsentRevokedError, ArchiveRecordTooLargeError } from "../src/usage-archive";

const installation = {
  installationId: "550e8400-e29b-41d4-a716-446655440000",
  token: "550e8400-e29b-41d4-a716-446655440000." + "a".repeat(64),
};

describe("usage API archive", () => {
  test("registers one installation and uploads without sign-in", async () => {
    const saved = new Map<string, unknown>();
    const requests: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return request.method === "POST"
        ? Response.json(installation, { status: 201 })
        : new Response(null, { status: 201 });
    };
    const credentials = {
      readRaw: (key: string) => saved.get(key),
      writeRaw: (key: string, value: unknown) => { saved.set(key, value); },
    };
    const writer = new UsageApiArchiveWriter("https://api.fabplane.com/", () => null, credentials, fetchImpl);
    await writer.write("run-dumps/run_1.json", '{"events":[]}\n');
    await writer.write("run-dumps/run_2.json", '{"events":[]}\n');
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["POST", "https://api.fabplane.com/v1/usage-archive/installation"],
      ["PUT", "https://api.fabplane.com/v1/usage-archive"],
      ["PUT", "https://api.fabplane.com/v1/usage-archive"],
    ]);
    expect(requests[1]!.headers.get("authorization")).toBeNull();
    expect(requests[1]!.headers.get("x-fabdesk-installation-token")).toBe(installation.token);
    expect(requests[1]!.headers.get("x-fabdesk-content-sha256")).toBe(createHash("sha256").update('{"events":[]}\n').digest("hex"));
    expect(await requests[1]!.text()).toBe('{"events":[]}\n');
    expect(saved.get("usage_archive_installation")).toEqual(installation);
  });

  test("adds account token when signed in", async () => {
    let request: Request | null = null;
    const writer = new UsageApiArchiveWriter(
      "https://api.fabplane.com", () => "user-token",
      { readRaw: () => installation, writeRaw: () => {} },
      async (input, init) => { request = new Request(input, init); return new Response(null, { status: 201 }); },
    );
    await writer.write("run-dumps/run_1.json", "{}");
    expect(request!.headers.get("authorization")).toBe("Bearer user-token");
  });

  describe("pacing and failures", () => {
    const registered = { readRaw: () => installation, writeRaw: () => {} };
    function harness(statuses: Array<number | Error | Response>, pacing: Partial<UploadPacing> = {}) {
      const sleeps: number[] = [];
      let puts = 0;
      const writer = new UsageApiArchiveWriter(
        "https://api.fabplane.com",
        () => null,
        registered,
        async () => {
          const next = statuses[Math.min(puts++, statuses.length - 1)]!;
          if (next instanceof Error) throw next;
          return next instanceof Response ? next : new Response(null, { status: next });
        },
        {
          minIntervalMs: 0,
          retryDelaysMs: [10, 20, 30],
          maxRetryAfterMs: 60_000,
          sleep: async (ms) => { sleeps.push(ms); },
          ...pacing,
        },
      );
      return { writer, sleeps, puts: () => puts };
    }

    test("retries rate limits, server errors and network failures, then succeeds", async () => {
      const h = harness([429, 503, new TypeError("fetch failed"), 201]);
      await h.writer.write("run-dumps/run_1.json", "{}");
      expect(h.puts()).toBe(4);
      expect(h.sleeps).toEqual([10, 20, 30]);
    });

    test("gives up after the configured retries", async () => {
      const h = harness([429]);
      await expect(h.writer.write("run-dumps/run_1.json", "{}")).rejects.toThrow("usage archive upload failed (429)");
      expect(h.puts()).toBe(4);
    });

    test("honours Retry-After, and fails at once when it is beyond the cap (a daily limit)", async () => {
      const short = harness([new Response(null, { status: 429, headers: { "retry-after": "2" } }), 201]);
      await short.writer.write("run-dumps/run_1.json", "{}");
      expect(short.sleeps).toEqual([2_000]);
      const daily = harness([new Response(null, { status: 429, headers: { "retry-after": "86400" } })]);
      await expect(daily.writer.write("run-dumps/run_1.json", "{}")).rejects.toThrow("(429)");
      expect(daily.puts()).toBe(1);
    });

    test("does not retry other client errors", async () => {
      const h = harness([401]);
      await expect(h.writer.write("run-dumps/run_1.json", "{}")).rejects.toThrow("(401)");
      expect(h.puts()).toBe(1);
    });

    test("rejects oversized records without sending them, and maps 413 the same way", async () => {
      const h = harness([413]);
      await expect(h.writer.write("run-dumps/big.json", "x".repeat(MAX_UPLOAD_BYTES + 1))).rejects.toBeInstanceOf(
        ArchiveRecordTooLargeError,
      );
      expect(h.puts()).toBe(0);
      await expect(h.writer.write("run-dumps/run_1.json", "{}")).rejects.toBeInstanceOf(ArchiveRecordTooLargeError);
      expect(h.puts()).toBe(1);
    });

    test("spaces consecutive uploads by the minimum interval", async () => {
      const h = harness([201], { minIntervalMs: 60_000 });
      await h.writer.write("run-dumps/run_1.json", "{}");
      await h.writer.write("run-dumps/run_2.json", "{}");
      expect(h.sleeps).toHaveLength(1);
      expect(h.sleeps[0]).toBeGreaterThan(59_000);
    });

    test("close cancels a pending retry wait", async () => {
      const writer = new UsageApiArchiveWriter(
        "https://api.fabplane.com",
        () => null,
        registered,
        async () => new Response(null, { status: 503 }),
        { minIntervalMs: 0, retryDelaysMs: [60_000] },
      );
      const pending = writer.write("run-dumps/run_1.json", "{}");
      await new Promise((r) => setTimeout(r, 10));
      writer.close();
      await expect(pending).rejects.toThrow("usage archive closed");
    });

    test("does not register or upload without current consent", async () => {
      let requests = 0;
      const writer = new UsageApiArchiveWriter(
        "https://api.fabplane.com", () => null,
        { readRaw: () => null, writeRaw() {} },
        async () => { requests++; return Response.json(installation); },
      );
      await expect(writer.write("run-dumps/private.json", "{}", () => false))
        .rejects.toBeInstanceOf(ArchiveConsentRevokedError);
      expect(requests).toBe(0);
    });

    test.each(["retry", "pacing"])("rechecks consent after a %s wait", async (mode) => {
      let allowed = true;
      const h = harness(mode === "retry" ? [429, 201] : [201], {
        minIntervalMs: mode === "pacing" ? 60_000 : 0,
        sleep: async () => { allowed = false; },
      });
      if (mode === "pacing") await h.writer.write("run-dumps/first.json", "{}");
      await expect(h.writer.write("run-dumps/private.json", "{}", () => allowed))
        .rejects.toBeInstanceOf(ArchiveConsentRevokedError);
      expect(h.puts()).toBe(1);
    });

    test("opt-out cancels the old retry even if sharing is immediately enabled again", async () => {
      let waiting!: () => void;
      const waitStarted = new Promise<void>((resolve) => { waiting = resolve; });
      const h = harness([503, 201], {
        sleep: async (_ms, signal) => {
          waiting();
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      });
      const cancelled = h.writer.write("run-dumps/old.json", "{}").catch((error: unknown) => error);
      await waitStarted;
      h.writer.cancelPending();
      // The same writer remains usable, but writes started before opt-out cannot resume.
      await h.writer.write("run-dumps/new-consent.json", "{}");
      expect(await cancelled).toBeInstanceOf(ArchiveConsentRevokedError);
      expect(h.puts()).toBe(2);
    });

    test("opt-out aborts a request already in flight", async () => {
      let started!: () => void;
      const requestStarted = new Promise<void>((resolve) => { started = resolve; });
      const writer = new UsageApiArchiveWriter(
        "https://api.fabplane.com", () => null, registered,
        async (_input, init) => {
          started();
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
          });
        },
      );
      const pending = writer.write("run-dumps/in-flight.json", "{}").catch((error: unknown) => error);
      await requestStarted;
      writer.cancelPending();
      expect(await pending).toBeInstanceOf(ArchiveConsentRevokedError);
    });

    test("a cancelled registration cannot clear or replace the next consent period's registration", async () => {
      const responses: Array<(response: Response) => void> = [];
      const saved = new Map<string, unknown>();
      let registrations = 0;
      let uploads = 0;
      const writer = new UsageApiArchiveWriter(
        "https://api.fabplane.com", () => null,
        { readRaw: (key) => saved.get(key), writeRaw: (key, value) => { saved.set(key, value); } },
        async (_input, init) => {
          if (init?.method === "POST") {
            registrations++;
            return new Promise<Response>((resolve) => { responses.push(resolve); });
          }
          uploads++;
          return new Response(null, { status: 201 });
        },
        { minIntervalMs: 0 },
      );
      const old = writer.write("run-dumps/old.json", "{}").catch((error: unknown) => error);
      expect(registrations).toBe(1);
      writer.cancelPending();
      const current = writer.write("run-dumps/current.json", "{}");
      expect(registrations).toBe(2);
      responses[0]!(Response.json(installation));
      expect(await old).toBeInstanceOf(ArchiveConsentRevokedError);
      // A third write must join the still-pending current registration, not create another one.
      const concurrent = writer.write("run-dumps/concurrent.json", "{}");
      expect(registrations).toBe(2);
      responses[1]!(Response.json(installation));
      await Promise.all([current, concurrent]);
      expect(uploads).toBe(2);
      expect(saved.get("usage_archive_installation")).toEqual(installation);
    });
  });
});
