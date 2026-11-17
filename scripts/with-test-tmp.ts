/**
 * Run a command with the OS temp folder pointed at one fresh folder, and remove that folder afterwards.
 *
 * The test suites create temp projects with mkdtemp(tmpdir()) and leave them: one machine had 36 000 fabdesk-tools-*
 * folders and 4 GB of test temp in /tmp. `bun run test` runs through this, so every test's leftovers go with the run.
 * FABDESK_KEEP_TEST_TMP=1 keeps the folder (its path is printed) to look at a failing test's files.
 *
 *   bun scripts/with-test-tmp.ts <command> [args...]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cmd = process.argv.slice(2);
if (!cmd.length) {
  console.error("usage: bun scripts/with-test-tmp.ts <command> [args...]");
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), "fabdesk-test-"));
const keep = process.env["FABDESK_KEEP_TEST_TMP"] === "1";
const cleanup = () => {
  if (keep) console.error(`test temp kept: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
};
const child = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir } });
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    child.kill(sig);
  });
const code = await child.exited;
cleanup();
process.exit(code);
