import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runDrc } from "@fabdesk/kicad";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const cliPath = process.env["FABPLANE_KICAD_CLI"];
test.skipIf(!cliPath)("installed KiCad DRC publishes a verified report and preserves it after later native/check failures", async () => {
  const project = await tempProject("native-drc-publication"), board = join(project.dir, "board.kicad_pcb"), output = join(project.dir, "reports/drc.json");
  const original = await readFile(join(import.meta.dir, "../../kicad/test/fixtures/mini-two-layer.kicad_pcb"));
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  let fault: "none" | "after-cli" | "source-change" = "none", staged = "";
  try {
    await writeFile(board, original);
    const base = mockServices([project]);
    const services = mockServices([project], { kicad: { ...base.kicad,
      resolveCli: async () => ({ path: cliPath!, version: "10.99.0" }),
      runDrc: async (cli, args) => {
        staged = args.outFile;
        const result = await runDrc(cli, args);
        expect(await Bun.file(staged).exists()).toBe(true);
        if (fault === "after-cli") throw new Error("Native report produced, later validation failed");
        if (fault === "source-change") await writeFile(board, Buffer.concat([original, Buffer.from("\n")]));
        return result;
      },
    }, design: { ...base.design, query: async () => [] } });
    const registry = createRegistry(), factory = contextFactory(services, project);
    const check = () => registry.invoke("verify_drc", { schematicParity: false }, ref => factory({ def: registry.get("verify_drc")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    await check();
    const saved = await readFile(output), report = JSON.parse(saved.toString());
    expect(report.pcbRevision.sha256).toBe(sha(original)); expect(report.schematicParityChecked).toBe(false);
    expect(report.counts).toMatchObject({ errors: expect.any(Number), warnings: expect.any(Number) });
    expect(await readFile(board)).toEqual(original); expect(staged).not.toBe(output);
    expect(await Bun.file(staged).exists()).toBe(false);
    fault = "after-cli"; await expect(check()).rejects.toThrow("later validation failed");
    expect(await readFile(output)).toEqual(saved); expect(await readFile(board)).toEqual(original);
    expect(await Bun.file(staged).exists()).toBe(false);
    fault = "source-change"; await expect(check()).rejects.toThrow("changed while DRC was running");
    expect(await readFile(output)).toEqual(saved); expect(await Bun.file(staged).exists()).toBe(false);
  } finally { await rm(project.dir, { recursive: true, force: true }); }
}, 120_000);
