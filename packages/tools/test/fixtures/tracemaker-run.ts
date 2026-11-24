import { watchFile, unwatchFile } from "node:fs";
import { open } from "node:fs/promises";
import { runTraceMaker } from "../../src/routers/tracemaker";

// The fixture directory is the child's cwd, so Bun resolves "route" to the fake CLI.
const mode = process.argv[2];
const lock = mode ? await open("board.kicad_pcb", "r") : undefined;
const cancel = new AbortController();
let afterExit: ReturnType<typeof setTimeout> | undefined;
if (mode === "release" || mode === "cancel") {
  // The fake CLI writes this marker in its exit hook, after writing the fresh result.
  watchFile("router-exited", { interval: 5 }, (stats) => {
    if (!stats.isFile()) return;
    unwatchFile("router-exited");
    afterExit = setTimeout(() => {
      if (mode === "cancel") cancel.abort();
      else void lock?.close();
    }, 180);
  });
}

try {
  const result = await runTraceMaker({
    binary: process.execPath, snapshotDir: process.cwd(), timeoutMs: 5000,
    signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(5000)]),
  });
  console.log(JSON.stringify({ elapsedMs: result.elapsedMs, wallMs: result.wallMs }));
} finally {
  unwatchFile("router-exited");
  clearTimeout(afterExit);
  await lock?.close();
}
