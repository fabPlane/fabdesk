import { expect, test } from "bun:test";
import { runFailureNotice, runFailureText } from "./runError";

test("a failed run exposes its real error text; healthy or missing runs expose nothing", () => {
  expect(
    runFailureText({ status: "failed", error: "EACCES: permission denied, posix_spawn '/data/routers/tracemaker'" }),
  ).toBe("EACCES: permission denied, posix_spawn '/data/routers/tracemaker'");
  expect(runFailureText({ status: "timed_out", error: null })).toMatch(/timed out without an error message/);
  expect(runFailureText({ status: "completed", error: null })).toBeNull();
  expect(runFailureText({ status: "running", error: null })).toBeNull();
  expect(runFailureText(undefined)).toBeNull();
});

test("a result the board checks refused is not reported as an unavailable router", () => {
  const refused = runFailureNotice({ status: "failed", candidate: { available: true } }, true);
  expect(refused.title).toBe("Routing result not applied");
  expect(refused.hint).not.toContain("unavailable");
  expect(runFailureNotice({ status: "failed", candidate: { available: false } }, true).hint).toBe("This router is currently unavailable.");
  expect(runFailureNotice({ status: "failed" }, false).title).toBe("Routing stopped");
  expect(runFailureNotice({ status: "timed_out", candidate: { available: true } }, false).title).toBe("Routing timed out");
});
