import { describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARCHIVE_PART_BYTES, type ArchiveRecord } from "../src/usage-parts";
import { restoreUsageRecord } from "../src/restore-usage-record";
import { fileDumpReference } from "../src/run-dump-file";
import { MAX_UPLOAD_BYTES, UsageApiArchiveWriter, type UploadPacing } from "../src/usage-api";
import { ArchiveConsentRevokedError, ArchiveRecordTooLargeError, ArchiveUnavailableError } from "../src/usage-archive";

// Synthetic credentials are generated locally and accepted only by the mock fetch.
const installationId = randomUUID();
const installation = {
  installationId,
  token: `${installationId}.${randomBytes(32).toString("hex")}`,
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
      deleteRaw: (key: string) => { saved.delete(key); },
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
      { readRaw: () => installation, writeRaw: () => {}, deleteRaw: () => {} },
      async (input, init) => { request = new Request(input, init); return new Response(null, { status: 201 }); },
    );
    await writer.write("run-dumps/run_1.json", "{}");
    expect(request!.headers.get("authorization")).toBe("Bearer user-token");
  });

  test("uploads >40 MiB as checked pieces, resumes after restart and commits only at the end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-upload-parts-"));
    const saved = new Map<string, unknown>([["usage_archive_installation", installation]]);
    const objects = new Map<string,string>();
    const accepted: string[]=[];
    let fail = true;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const key = headers.get("x-fabdesk-archive-key")!;
      const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
      expect(bytes.length).toBeLessThan(MAX_UPLOAD_BYTES);
      expect(headers.get("x-fabdesk-content-sha256")).toBe(createHash("sha256").update(bytes).digest("hex"));
      if (fail && accepted.length === 2) return new Response(null,{status:503});
      accepted.push(key);objects.set(key,bytes.toString());return new Response(null,{status:201});
    };
    const credentials = {readRaw:(k:string)=>saved.get(k),writeRaw:(k:string,v:unknown)=>{saved.set(k,v);},deleteRaw:(k:string)=>{saved.delete(k);}};
    const options = {minIntervalMs:0,retryDelaysMs:[]};
    const path = join(dir,"full.json");
    // Different segments exercise multiple receipts rather than identical-content deduplication.
    const body = JSON.stringify({schema:"synthetic",events:Array.from({length:15},(_,i)=>({id:i,output:String(i).repeat(3*1024*1024)}))});
    await writeFile(path,body);
    try {
      const expected = JSON.parse(await fileDumpReference(path));
      expect(expected.bytes).toBeGreaterThan(MAX_UPLOAD_BYTES);
      const first = new UsageApiArchiveWriter("https://api.fabplane.com",()=>null,credentials,fetchImpl,options);
      await expect(first.writeFile("run-dumps/large.json",path,()=>true,expected)).rejects.toThrow("503");
      first.close();
      expect(objects.has("run-dumps/large.json")).toBe(false);
      const completed = accepted.slice();
      fail = false;
      const second = new UsageApiArchiveWriter("https://api.fabplane.com",()=>null,credentials,fetchImpl,options);
      await second.writeFile("run-dumps/large.json",path,()=>true,expected);
      second.close();
      for (const key of completed) expect(accepted.filter(k=>k===key)).toHaveLength(1);
      expect(accepted.at(-1)).toBe("run-dumps/large.json");
      expect([...saved.keys()].filter(key => key.startsWith("usage_archive_part_"))).toEqual([]);
      const third = new UsageApiArchiveWriter("https://api.fabplane.com",()=>null,credentials,fetchImpl,options);
      await third.writeFile("run-dumps/later.json",path,()=>true,expected);
      third.close();
      expect(accepted.filter(key => key === completed[0])).toHaveLength(2);
      expect([...saved.keys()].filter(key => key.startsWith("usage_archive_part_"))).toEqual([]);
      const manifest=JSON.parse(objects.get("run-dumps/large.json")!) as ArchiveRecord;
      const output=join(dir,"restored.json");
      await restoreUsageRecord(manifest,async key=>objects.get(key)!,output);
      expect(await readFile(output,"utf8")).toBe(body);
      const firstPart=manifest.parts[0]!;
      const corrupt=JSON.parse(objects.get(firstPart.key)!);corrupt.content="AAAA";
      objects.set(firstPart.key,JSON.stringify(corrupt));
      await expect(restoreUsageRecord(manifest,async key=>objects.get(key)!,output)).rejects.toThrow("checksum");
      expect(await readFile(output,"utf8")).toBe(body); // corrupt retry cannot replace a good result
    } finally {await rm(dir,{recursive:true,force:true});}
  });

  test("opt-out during a multi-part upload leaves no completion manifest", async () => {
    const saved = new Map<string,unknown>([["usage_archive_installation",installation]]);
    let allowed=true;
    const keys:string[]=[];
    const writer = new UsageApiArchiveWriter("https://api.fabplane.com",()=>null,
      {readRaw:k=>saved.get(k),writeRaw:(k,v)=>{saved.set(k,v);},deleteRaw:k=>{saved.delete(k);}},
      async (_input,init)=>{keys.push(new Headers(init?.headers).get("x-fabdesk-archive-key")!);allowed=false;return new Response(null,{status:201});},
      {minIntervalMs:0});
    await expect(writer.write("run-dumps/private.json","x".repeat(ARCHIVE_PART_BYTES+1),()=>allowed)).rejects.toBeInstanceOf(ArchiveConsentRevokedError);
    expect(keys).toHaveLength(1);
    expect(keys).not.toContain("run-dumps/private.json");
    writer.close();
  });

  describe("pacing and failures", () => {
    const registered = { readRaw: () => installation, writeRaw: () => {}, deleteRaw: () => {} };
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

    test("503 and offline failures throw ArchiveUnavailableError", async () => {
      const unavailable = harness([503]);
      await expect(unavailable.writer.write("run-dumps/run_1.json", "{}")).rejects.toBeInstanceOf(
        ArchiveUnavailableError,
      );
      expect(unavailable.puts()).toBe(4);
      const offline = harness([new TypeError("fetch failed")]);
      await expect(offline.writer.write("run-dumps/run_1.json", "{}")).rejects.toBeInstanceOf(
        ArchiveUnavailableError,
      );
      const registration = new UsageApiArchiveWriter(
        "https://api.fabplane.com",
        () => null,
        { readRaw: () => null, writeRaw() {}, deleteRaw() {} },
        async () => new Response(null, { status: 503 }),
      );
      await expect(registration.write("run-dumps/run_1.json", "{}")).rejects.toBeInstanceOf(
        ArchiveUnavailableError,
      );
      const registrationOffline = new UsageApiArchiveWriter(
        "https://api.fabplane.com",
        () => null,
        { readRaw: () => null, writeRaw() {}, deleteRaw() {} },
        async () => {
          throw new TypeError("fetch failed");
        },
      );
      await expect(registrationOffline.write("run-dumps/run_1.json", "{}")).rejects.toBeInstanceOf(
        ArchiveUnavailableError,
      );
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

    test("reports server 413 as a retained-record failure", async () => {
      const h = harness([413]);
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
        { readRaw: () => null, writeRaw() {}, deleteRaw() {} },
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
        { readRaw: (key) => saved.get(key), writeRaw: (key, value) => { saved.set(key, value); }, deleteRaw: key => { saved.delete(key); } },
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

test("record-scoped SQLite receipts survive another record and changed snapshot-id retry, then are really deleted", async () => {
  const { Store } = await import("../src/db");
  const store = Store.open(":memory:");
  store.settings.writeRaw("usage_archive_installation", installation);
  let phase = "interrupted", count = 0;
  const requests: Array<{ phase: string; key: string }> = [];
  const writer = new UsageApiArchiveWriter("https://api.fabplane.com", () => null, store.settings,
    async (_input, init) => {
      const key = new Headers(init?.headers).get("x-fabdesk-archive-key")!;
      requests.push({ phase, key });
      if (phase === "interrupted" && count++ === 1) return new Response(null, { status: 503 });
      return new Response(null, { status: 201 });
    }, { minIntervalMs: 0, retryDelaysMs: [] });
  const receiptCount = () => (store.db.query("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'usage_archive_part_%'").get() as { n: number }).n;
  try {
    const body = "x".repeat(ARCHIVE_PART_BYTES + 1);
    await expect(writer.write("snapshots/attempt-1/conversations/thread.json", body)).rejects.toThrow("503");
    expect(receiptCount()).toBe(1);
    phase = "other";
    await writer.write("run-dumps/other.json", body);
    expect(receiptCount()).toBe(1); // other record's success cannot clear the pending receipt
    phase = "resume";
    await writer.write("snapshots/attempt-2/conversations/thread.json", body);
    expect(requests.filter(r => r.phase === "resume" && r.key === requests[0]!.key)).toHaveLength(0);
    expect(receiptCount()).toBe(0);
    const { partReceiptPrefix } = await import("../src/usage-parts");
    expect(partReceiptPrefix("snapshots/attempt-2/conversations/thread.json")).toBe(partReceiptPrefix("conversations/thread/run_1.json"));
    // Pre-change installation-scoped receipts also support resume, then leave no settings row.
    const sha = createHash("sha256").update(body.slice(0, ARCHIVE_PART_BYTES)).digest("hex");
    store.settings.writeRaw(`usage_archive_part_${installation.installationId}_${sha}`, true);
    phase = "legacy";
    await writer.write("run-dumps/legacy.json", body);
    expect(requests.filter(r => r.phase === "legacy" && r.key === requests[0]!.key)).toHaveLength(0);
    expect(receiptCount()).toBe(0);
  } finally { writer.close(); store.close(); }
});
