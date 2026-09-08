import { afterAll, describe, expect, test } from "bun:test";
import { ToolError } from "@fabdesk/tools";
import { FpPcbBridgeClient, parseSse } from "../src/fp-pcb-bridge";

type Session = { id: string; state: string; path: string | null };
const sessions = new Map<Session["id"], Session>();
const calls: string[] = [];
let nextSession = 1;

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const job = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id,
  state,
  log: [],
  ...extra,
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/health")
      return Response.json({
        ok: true,
        name: "@fp-pcb/bridge",
        kicadCliExists: true,
        sessions: [...sessions.values()],
      });
    if (url.pathname === "/sessions" && req.method === "GET")
      return Response.json({ sessions: [...sessions.values()] });
    if (url.pathname === "/sessions" && req.method === "POST") {
      const body = (await req.json()) as { path: string | null };
      const s = { id: `s${nextSession++}`, state: "running", path: body.path };
      sessions.set(s.id, s);
      return Response.json({ session: s, wsUrl: `/ws?session=${s.id}` }, { status: 201 });
    }
    const m = /^\/sessions\/([^/]+)\/compile(?:\/([^/]+))?$/.exec(url.pathname);
    if (m) {
      const [, sid, jid] = m;
      if (!sessions.has(sid!))
        return Response.json({ error: `unknown session "${sid}"` }, { status: 404 });
      if (req.method === "POST") {
        const body = (await req.json()) as { source: { entrypoint: string } };
        const id = body.source.entrypoint.replace(/\.netlist\.json$/, "");
        return Response.json({ job: job(id, "queued") }, { status: 202 });
      }
      if (req.method === "DELETE") return Response.json({ ok: true, job: job(jid!, "cancelled") });
      if (req.headers.get("accept") !== "text/event-stream")
        return Response.json({
          job: job(jid!, "done", {
            result: { ok: true, diagnostics: [], counts: {}, durationMs: 1 },
          }),
        });
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(sse("state", job(jid!, "queued"))));
          c.enqueue(enc.encode(": keepalive\n\n"));
          c.enqueue(enc.encode(sse("progress", job(jid!, "importing"))));
          if (jid === "err")
            c.enqueue(enc.encode(sse("error", job(jid, "failed", { error: "kicad-cli exited" }))));
          else if (jid === "cut") return c.close();
          else if (jid === "hang")
            return; // stays open until the client goes away
          else
            c.enqueue(
              enc.encode(
                sse(
                  "done",
                  job(jid!, "done", {
                    result: { ok: true, diagnostics: [], counts: { components: 2 }, durationMs: 7 },
                    revision: 3,
                  }),
                ),
              ),
            );
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ error: `not found: ${url.pathname}` }, { status: 404 });
  },
});
afterAll(() => server.stop(true));

const client = () => new FpPcbBridgeClient({ url: server.url.origin + "/" });
const request = (name: string) => ({
  source: { kind: "netlist-json", files: {}, entrypoint: `${name}.netlist.json` },
});

async function collect(text: string) {
  const out = [];
  for await (const ev of parseSse(new Response(text).body!)) out.push(ev);
  return out;
}

describe("parseSse", () => {
  test("events, multi-line data, comments, CRLF and an unterminated tail", async () => {
    const text =
      'event: state\ndata: {"a":1}\n\n: keepalive\n\nevent: progress\r\ndata: line1\r\ndata: line2\r\n\r\ndata: tail';
    expect(await collect(text)).toEqual([
      { event: "state", data: '{"a":1}' },
      { event: "progress", data: "line1\nline2" },
      { event: "message", data: "tail" },
    ]);
  });
});

describe("FpPcbBridgeClient", () => {
  test("health and session reuse", async () => {
    const c = client();
    expect(c.url.endsWith("/")).toBe(false);
    expect((await c.health()).ok).toBe(true);
    const a = await c.sessionFor("/w/board.kicad_pro");
    const b = await c.sessionFor("/w/board.kicad_pro");
    const bare = await c.sessionFor(null);
    expect(b.id).toBe(a.id);
    expect(bare.id).not.toBe(a.id);
    expect(bare.path).toBeNull();
  });

  test("follows a compile over SSE to done and reports progress", async () => {
    const c = client();
    const s = await c.sessionFor(null);
    const seen: string[] = [];
    const done = await c.compile(s.id, request("ok"), { onProgress: (j) => seen.push(j.state) });
    expect(done.state).toBe("done");
    expect(done.result?.counts.components).toBe(2);
    expect(done.revision).toBe(3);
    expect(seen).toEqual(["queued", "importing"]);
  });

  test("an error event yields the failed record, not an exception", async () => {
    const c = client();
    const s = await c.sessionFor(null);
    const failed = await c.compile(s.id, request("err"));
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("kicad-cli exited");
  });

  test("a stream that ends early falls back to the JSON record", async () => {
    const c = client();
    const s = await c.sessionFor(null);
    const done = await c.compile(s.id, request("cut"));
    expect(done.state).toBe("done");
    expect(calls.at(-1)).toBe(`GET /sessions/${s.id}/compile/cut`);
  });

  test("aborting cancels the job on the bridge", async () => {
    const c = client();
    const s = await c.sessionFor(null);
    const ac = new AbortController();
    const pending = c.compile(s.id, request("hang"), {
      signal: ac.signal,
      onProgress: () => ac.abort(),
    });
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toContain(`DELETE /sessions/${s.id}/compile/hang`);
  });

  test("a vanished session is not_found so the caller can recreate it", async () => {
    const c = client();
    await expect(c.compile("nope", request("ok"))).rejects.toMatchObject({ code: "not_found" });
  });

  test("an unreachable bridge is unavailable, with the URL in the message", async () => {
    const c = new FpPcbBridgeClient({ url: "http://127.0.0.1:1", timeoutMs: 500 });
    const err = await c.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("unavailable");
    expect((err as ToolError).message).toContain("127.0.0.1:1");
  });
});
