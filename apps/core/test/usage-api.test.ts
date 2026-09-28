import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { UsageApiArchiveWriter } from "../src/usage-api";

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
});
