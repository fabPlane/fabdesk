import { expect, test } from "bun:test";
import { CoreClient, CoreHttpError } from "./CoreClient";
import { saveAgentSelection } from "./agent-selection";

function fixture(failChat = false, failDefaults = false) {
  const calls: Array<{ path: string; method: string | undefined; body: unknown }> = [];
  const client = new CoreClient({ baseUrl: "http://test.invalid", token: "test", fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    calls.push({ path, method: init?.method, body });
    if (path === "/threads/chat") return failChat ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json({ id: "chat", agentId: body.agentId, model: body.model });
    return failDefaults ? Response.json({ error: "not found" }, { status: 404 }) : Response.json({ defaultAgent: body.agentId, agents: { [body.agentId]: { model: body.model } } });
  } });
  return { client, calls };
}

test("an existing chat switches before defaults and explicitly clears the previous agent's model", async () => {
  const { client, calls } = fixture();
  const result = await saveAgentSelection(client, { threadId: "chat", agentId: "codex", model: null });
  expect(calls).toEqual([
    { path: "/threads/chat", method: "PATCH", body: { agentId: "codex", model: null } },
    { path: "/settings/agent-preference", method: "PUT", body: { agentId: "codex", model: null } },
  ]);
  expect(result.thread).toMatchObject({ id: "chat", agentId: "codex", model: null });
  expect(result.settings?.defaultAgent).toBe("codex");
  expect(result.preferenceError).toBeNull();
});

test("an older core's defaults endpoint cannot undo a saved conversation switch", async () => {
  const { client, calls } = fixture(false, true);
  const result = await saveAgentSelection(client, { threadId: "chat", agentId: "codex", model: "selected-model" });
  expect(result.thread).toMatchObject({ agentId: "codex", model: "selected-model" });
  expect(result.settings).toBeNull();
  expect(result.preferenceError).toBeInstanceOf(CoreHttpError);
  expect(result.preferenceError).toMatchObject({ status: 404, path: "/settings/agent-preference" });
  expect(calls).toHaveLength(2);
});

test("a failed conversation switch never changes defaults or claims a successful switch", async () => {
  const { client, calls } = fixture(true);
  await expect(saveAgentSelection(client, { threadId: "chat", agentId: "codex", model: "selected-model" })).rejects.toBeInstanceOf(CoreHttpError);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.path).toBe("/threads/chat");
});

test("new-chat selection creates no conversation and retains the actual defaults failure", async () => {
  const { client, calls } = fixture(false, true);
  const result = await saveAgentSelection(client, { agentId: "codex", model: "selected-model" });
  expect(result.thread).toBeNull();
  expect(result.preferenceError).toMatchObject({ status: 404 });
  expect(calls.map(call => call.path)).toEqual(["/settings/agent-preference"]);
});
