import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runToolCli } from "./tool-cli";

const manifest = [
  {
    name: "pcb_inspect",
    toolset: "circuit",
    title: "Inspect a PCB region",
    description: "Inspect board geometry near a point.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, near: { type: "object" } },
    },
    annotations: {},
    longRunning: false,
  },
];

describe("scriptable tool CLI", () => {
  afterEach(() => {
    spyOn(process.stdout, "write").mockRestore();
  });

  test("searches the manifest without exposing every schema", async () => {
    let output = "";
    spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const fetchMock = async () => Response.json(manifest);
    expect(
      await runToolCli(
        { action: "search", query: "geometry", baseUrl: "http://core", token: "t" },
        { fetch: fetchMock as unknown as typeof fetch },
      ),
    ).toBe(0);
    const parsed = JSON.parse(output) as {
      matches: Array<{
        name: string;
        title: string;
        description: string;
        longRunning: boolean;
        inputSchema?: unknown;
      }>;
    };
    expect(parsed.matches).toEqual([
      {
        name: "pcb_inspect",
        title: "Inspect a PCB region",
        description: "Inspect board geometry near a point.",
        longRunning: false,
      },
    ]);
    expect(parsed.matches[0]?.inputSchema).toBeUndefined();
  });

  test("unreachable agent-shell endpoint returns actionable JSON without retrying or exposing credentials", async () => {
    let output = "", calls = 0;
    spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
    const code = await runToolCli({ action: "describe", name: "pcb_inspect", baseUrl: "http://core", token: "private-token" }, { fetch: (async () => { calls++; throw Error("network sandbox denied private-token"); }) as unknown as typeof fetch });
    expect(code).toBe(1); expect(calls).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ ok: false, code: "endpoint_unavailable" });
    expect(output).toContain("MCP"); expect(output).not.toContain("private-token");
  });

  test("calls tools with the current project and supports JSONL batches", async () => {
    let output = "";
    const bodies: unknown[] = [];
    spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tools/manifest")) return Response.json(manifest);
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, json: { revision: "abc" } });
    };
    const code = await runToolCli(
      {
        action: "batch",
        input: '{"name":"pcb_inspect","arguments":{"near":{"x":1,"y":2,"radius":3}}}\n',
        project: "/project",
        baseUrl: "http://core",
        token: "t",
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(code).toBe(0);
    expect(bodies).toEqual([{ near: { x: 1, y: 2, radius: 3 }, project: "/project" }]);
    expect(JSON.parse(output).name).toBe("pcb_inspect");
  });
});
