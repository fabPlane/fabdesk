import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runArtifactCli } from "./artifact-cli";
import { inspectProjectRevision, runProjectRevision } from "./project-revisions";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function acceptedProject() {
  const directory = await mkdtemp(join(tmpdir(), "fabdesk-artifact-cli-"));
  directories.push(directory);
  await writeFile(join(directory, "board.kicad_pro"), "{}\n");
  await writeFile(join(directory, "board.kicad_sch"), "schematic\n");
  await writeFile(join(directory, "board.kicad_pcb"), "pcb\n");
  await runProjectRevision(
    { action: "accept", project: directory },
    {
      validate: async () => ({
        structural: "pass",
        evidenceLevel: "measured",
        toolchain: { kicadCli: "/bundle/kicad-cli", version: "10.99.0" },
        checks: [],
      }),
      out: () => {},
      err: () => {},
    },
  );
  return directory;
}

describe("accepted-artifact CLI", () => {
  test("runs applicable verification through the common kernel", async () => {
    const project = await acceptedProject();
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    let output = "";
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const name = new URL(String(input)).pathname.split("/").pop()!;
      calls.push({ name, body: JSON.parse(String(init?.body)) });
      return Response.json({ text: `${name} passed`, json: { pass: true }, isError: false });
    };
    expect(
      await runArtifactCli(
        { action: "verify", project, baseUrl: "http://core", token: "secret" },
        {
          fetch: fetchMock as unknown as typeof fetch,
          out: (text) => {
            output += text;
          },
        },
      ),
    ).toBe(0);
    expect(calls.map((call) => call.name)).toEqual(["verify_erc", "verify_drc", "verify_gate"]);
    expect(calls[1]?.body).toMatchObject({ project, schematicParity: true, severity: "all" });
    expect(JSON.parse(output)).toMatchObject({ operation: "verify", stable: true, pass: true });
  });

  test("rejects an operation when source changes while the kernel is running", async () => {
    const project = await acceptedProject();
    let calls = 0;
    let output = "";
    const fetchMock = async () => {
      calls++;
      if (calls === 1) await writeFile(join(project, "board.kicad_pcb"), "changed\n");
      return Response.json({ text: "done", json: {}, isError: false });
    };
    expect(
      await runArtifactCli(
        { action: "render", project, baseUrl: "http://core", token: "secret" },
        {
          fetch: fetchMock as unknown as typeof fetch,
          out: (text) => {
            output += text;
          },
        },
      ),
    ).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ stable: false, pass: false });
  });

  test("requires an accepted clean revision before calling the kernel", async () => {
    const project = await acceptedProject();
    await writeFile(join(project, "design.py"), "candidate\n");
    let error = "";
    let called = false;
    expect(
      await runArtifactCli(
        { action: "verify", project, baseUrl: "http://core", token: "secret" },
        {
          inspect: inspectProjectRevision,
          fetch: (async () => {
            called = true;
            return Response.json({});
          }) as unknown as typeof fetch,
          out: () => {},
          err: (text) => {
            error += text;
          },
        },
      ),
    ).toBe(1);
    expect(called).toBe(false);
    expect(error).toContain("differs from accepted revision");
  });
});
