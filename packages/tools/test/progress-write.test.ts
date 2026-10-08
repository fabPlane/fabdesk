import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../src/fs";

test("64 simultaneous atomic writes with a frozen clock have unique temporary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-atomic-"));
  const now = Date.now;
  try {
    Date.now = () => 1234;
    const path = join(dir, "progress.json");
    await Promise.all(
      Array.from({ length: 64 }, (_, i) => writeAtomic(path, JSON.stringify({ i }))),
    );
    expect(JSON.parse(await readFile(path, "utf8")).i).toBeGreaterThanOrEqual(0);
    expect(await readdir(dir)).toEqual(["progress.json"]);
  } finally {
    Date.now = now;
    await rm(dir, { recursive: true, force: true });
  }
});

test("route worker survives injected progress failure and persists the newest terminal record", async () => {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/progress-write-failure.ts")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toContain("progress write failed");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    state: "completed",
    diskState: "completed",
    alive: true,
    progressFrames: 64,
  });
});

test("a delayed frame telemetry write failure does not exit the worker process", async () => {
  const code = `import { FrameSink } from ${JSON.stringify(join(import.meta.dir, "../src/frame-sink.ts"))};
    const sink = new FrameSink("/dev/null/frames.jsonl", null);
    sink.onMessage({kind: "meta", runId: "r", router: "capacity", bounds: {x1:0,y1:0,x2:1,y2:1}, layers:["top"], unitsPerMm:1});
    await Bun.sleep(150); await sink.close(); console.log("alive");`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toContain("frames write failed");
  expect(exit).toBe(0);
  expect(stdout.trim()).toBe("alive");
});
