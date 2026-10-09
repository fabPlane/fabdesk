import { expect, test } from "bun:test";
import { runFailureText } from "./runError";

test("a failed run exposes its real error text; healthy or missing runs expose nothing", () => {
  expect(
    runFailureText({ status: "failed", error: "EACCES: permission denied, posix_spawn '/data/routers/tracemaker'" }),
  ).toBe("EACCES: permission denied, posix_spawn '/data/routers/tracemaker'");
  expect(runFailureText({ status: "timed_out", error: null })).toMatch(/timed out without an error message/);
  expect(runFailureText({ status: "completed", error: null })).toBeNull();
  expect(runFailureText({ status: "running", error: null })).toBeNull();
  expect(runFailureText(undefined)).toBeNull();
});
