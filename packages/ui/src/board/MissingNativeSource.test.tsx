import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { Thread } from "@fabdesk/protocol";
import { CoreClient, CoreProvider, nullHost, useRunsStore } from "@fabdesk/client-core";
import { MissingNativeSource } from "./MissingNativeSource";

function render(runningProject: string | null) {
  const initial = useRunsStore.getInitialState(), previous = { ...initial };
  const qc = new QueryClient();
  qc.setQueryData(["project", "one"], { files: [] });
  qc.setQueryData(["threads", "", "one"], runningProject ? [Thread.parse({ id: "chat", projectId: runningProject, agentId: "codex", model: null, title: "Make a button light", createdAt: "", updatedAt: "", pinned: false, archived: false, folderId: null, parentThreadId: null, branchFromMessageId: null })] : []);
  Object.assign(initial, { runsByThread: runningProject ? { chat: { threadId: "chat", runId: "run", agentId: "codex", startedAt: 1 } } : {} });
  try {
    return renderToStaticMarkup(<CoreProvider client={new CoreClient({ baseUrl: "http://test.invalid", token: "test" })} host={nullHost} queryClient={qc}><MissingNativeSource projectId="one" kind="pcb" enabled /></CoreProvider>);
  } finally { Object.assign(initial, previous); qc.clear(); }
}

test("a working project assistant replaces duplicate generation prompts with a conversation path", () => {
  const html = render("one");
  expect(html).toContain("Assistant is working");
  expect(html).toContain("Open conversation");
  expect(html).not.toContain("Generate with agent");
  expect(html).toContain("has been linked to this view yet");
});

test("idle and other-project runs keep the ordinary source recovery actions", () => {
  for (const project of [null, "other"]) {
    const html = render(project);
    expect(html).toContain("Generate with agent");
    expect(html).toContain("Import PCB");
    expect(html).not.toContain("Assistant is working");
  }
});
