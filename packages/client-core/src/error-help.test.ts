import { expect, test } from "bun:test";
import { agentErrorText, errorHelp, errorPayload, splitAgentError } from "./error-help";
import { CoreClient, CoreHttpError } from "./CoreClient";

test("raw API JSON becomes recovery guidance without losing status, code or diagnostics", async () => {
  const raw = JSON.stringify({ error: "FOREIGN KEY constraint failed", code: "internal" });
  const client = new CoreClient({ baseUrl: "http://test", token: "t", fetch: async () => new Response(raw, { status: 500 }) });
  const error = await client.createThread({ agentId: "claude", projectId: "stale" }).catch(e => e);
  expect(error).toBeInstanceOf(CoreHttpError);
  expect(error.status).toBe(500);
  expect(error.code).toBe("internal");
  expect(error.path).toBe("/threads");
  expect(error.rawMessage).toBe(raw);
  expect(error.message).toContain("start a new chat");
  expect(error.message).not.toContain("FOREIGN KEY");
  expect(errorHelp(error).action).toBe("projects");
});

test("provider-specific login advice does not confuse Claude with fabPlane", () => {
  const raw = "Failed to authenticate: OAuth session expired and could not be refreshed";
  expect(errorHelp(raw, { agentId: "claude" })).toMatchObject({ title: "Claude needs you to sign in again", command: "claude auth login", action: "agents" });
  expect(errorHelp(raw, { agentId: "codex" }).command).toBe("codex login");
  expect(errorHelp(raw).command).toBeUndefined();
  expect(errorHelp('{"error":"cloud_signed_out"}', { status: 401 }).action).toBe("auth");
  expect(errorHelp("unauthorized", { status: 401 }).message).toContain("paired device");
});

test.each([
  ["rate_limit_error", "Wait a little"],
  ["insufficient_quota", "usage and billing"],
  ["context_length_exceeded", "Start a new chat"],
  ["model_not_found", "different model"],
  ["failed to start claude: ENOENT", "Settings → Agents"],
  ["ENOENT: no such file or directory", "select it again"],
  ["ENOSPC", "Free up space"],
  ["EACCES: permission denied", "folder you can write to"],
  ["SQLITE_BUSY: database is locked", "Wait a moment"],
  ["database disk image is malformed", "Keep your app data"],
  ["ETIMEDOUT", "whether the action completed"],
  ["ECONNREFUSED", "Check your connection"],
  ["MCP server \"fabdesk\" failed to connect", "Restart fabPlane"],
  ["board.kicad_pcb not found", "build the board first"],
  ["an agent run is already active on this thread", "current run to finish"],
])("%s has a specific recovery step", (raw, action) => {
  expect(errorHelp(raw).message).toContain(action);
});

test("malformed JSON, HTML and internal errors do not become the primary message", () => {
  for (const raw of ['{"error":', "<html>Bad gateway</html>", '{"error":"private stack trace","code":"internal"}']) {
    const error = new CoreHttpError(500, "/threads", raw);
    expect(error.message).toContain("share the technical details");
    expect(error.rawMessage).toBe(raw);
  }
  expect(errorPayload('{"error":{"message":"rate limit exceeded","code":"rate_limit"}}').code).toBe("rate_limit");
});

test("network errors gain guidance while intentional cancellations stay cancellations", async () => {
  const client = new CoreClient({ baseUrl: "http://test", token: "t", fetch: async () => { throw new TypeError("Failed to fetch"); } });
  await expect(client.listProjects()).rejects.toThrow("Check your connection");
  const abort = new DOMException("Canceled", "AbortError");
  const canceled = new CoreClient({ baseUrl: "http://test", token: "t", fetch: async () => { throw abort; } });
  expect(await canceled.listProjects().catch(e => e)).toBe(abort);
});

test("old duplicate authentication replies collapse, but user prose is not classified", () => {
  const raw = "Failed to authenticate: OAuth session expired and could not be refreshed";
  expect(agentErrorText(`${raw}\n\n⚠ ${raw}`)).toBe(raw);
  expect(agentErrorText(`The error '${raw}' means you should sign in.`)).toBeNull();
  expect(agentErrorText("Your board is ready.\n\nThere was a rate limit earlier.")).toBeNull();
  expect(agentErrorText("⚠ Check polarity before connecting power.")).toBeNull();
  expect(splitAgentError(`I saved the schematic.\n\n⚠ ${raw}`)).toEqual({ before: "I saved the schematic.", error: raw });
});

test("Windows Codex isolation fallback is a warning, not a login or file permission failure", () => {
  const raw = "Windows denied a Codex overlay symlink (EPERM). Using the original CODEX_HOME and live credential store; per-project config isolation is unavailable.";
  expect(errorHelp(raw, { agentId: "codex" })).toMatchObject({ severity: "warning", title: "Codex is using your shared settings" });
  expect(errorHelp(raw).command).toBeUndefined();
  expect(errorHelp(raw).message).toContain("may update your shared settings");
  expect(splitAgentError(`⚠ ${raw}\n\nI will inspect the board.`)).toEqual({ before: "", error: raw, after: "I will inspect the board." });
});
