import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { UsageApiArchiveWriter } from "../src/usage-api";

describe("usage API archive", () => {
  test("requires a signed-in user and sends the raw archive with a digest", async () => {
    let request: Request | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      request = new Request(input, init);
      return new Response(null, { status: 201 });
    };
    const writer = new UsageApiArchiveWriter("https://api.fabplane.com/", () => "user-token", fetchImpl);
    await writer.write("run-dumps/run_1.json", '{"events":[]}\n');
    expect(request!.url).toBe("https://api.fabplane.com/v1/private/usage-archive");
    expect(request!.headers.get("authorization")).toBe("Bearer user-token");
    expect(request!.headers.get("x-fabdesk-archive-key")).toBe("run-dumps/run_1.json");
    expect(request!.headers.get("x-fabdesk-content-sha256")).toBe(createHash("sha256").update('{"events":[]}\n').digest("hex"));
    expect(await request!.text()).toBe('{"events":[]}\n');
    await expect(new UsageApiArchiveWriter("https://api.fabplane.com", () => null, fetchImpl).write("run-dumps/run_2.json", "{}"))
      .rejects.toThrow("sign-in");
  });
});
