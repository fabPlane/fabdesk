import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildCircuit, readCircuitJson } from "../src/index";
import { tempProject } from "./helpers";

describe("buildCircuit", () => {
  test("builds the offline led-usb fixture with no errors and no autorouted traces", async () => {
    const dir = await tempProject("led-usb");
    const result = await buildCircuit({ projectDir: dir, cacheDir: join(dir, ".cache") });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.elementCounts.pcb_trace).toBeUndefined();
    expect(result.elementCounts.pcb_via).toBeUndefined();
    expect(result.elementCounts.source_component).toBe(3);
    expect(result.elementCounts.source_trace).toBe(3);
    expect(result.durationMs).toBeGreaterThan(0);
    // The sibling module imported by circuit.tsx contributed its components.
    expect(result.circuitJson.some((e) => (e as { name?: string }).name === "LED1")).toBe(true);

    const onDisk = await readCircuitJson(dir);
    expect(onDisk).not.toBeNull();
    expect(onDisk?.length).toBe(result.circuitJson.length);
  }, 60_000);

  test("reports transpile errors with file/line/column", async () => {
    const dir = await tempProject("broken");
    const result = await buildCircuit({ projectDir: dir });
    expect(result.ok).toBe(false);
    expect(result.circuitJson).toEqual([]);
    const [error] = result.errors;
    expect(error?.type).toBe("transpile_error");
    expect(error?.file).toBe("circuit.tsx");
    expect(error?.line).toBeGreaterThan(0);
    expect(error?.column).toBeGreaterThan(0);
    expect(await readCircuitJson(dir)).toBeNull();
  }, 30_000);

  test("missing entrypoint is a build error, not an exception", async () => {
    const dir = await tempProject("led-usb");
    const result = await buildCircuit({ projectDir: dir, entrypoint: "nope.tsx" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.type).toBe("missing_entrypoint");
  });

  test("abort signal rejects", async () => {
    const dir = await tempProject("led-usb");
    const controller = new AbortController();
    const pending = buildCircuit({ projectDir: dir, signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  }, 30_000);

  test.skipIf(!process.env.FABDESK_NETWORK_TESTS)(
    "builds a fixture with an @tsci registry import and caches the fetch",
    async () => {
      const dir = await tempProject("tsci-import");
      const cacheDir = join(dir, ".cache");
      const first = await buildCircuit({ projectDir: dir, cacheDir });
      expect(first.errors).toEqual([]);
      const cached = await Array.fromAsync(new Bun.Glob("registry/*.json").scan({ cwd: cacheDir }));
      expect(cached.length).toBeGreaterThan(0);
      const second = await buildCircuit({ projectDir: dir, cacheDir });
      expect(second.ok).toBe(true);
    },
    120_000,
  );
});
