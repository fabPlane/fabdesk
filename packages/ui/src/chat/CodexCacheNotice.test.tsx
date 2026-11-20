import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { Settings, type AgentInfo, type Thread } from "@fabdesk/protocol";
import { CoreClient, CoreProvider, nullHost } from "@fabdesk/client-core";
import { CodexCacheNotice } from "./CodexCacheNotice";
import { Composer } from "./Composer";
import { newChatDraftKey, useUiStore } from "../stores/ui";

const agent: AgentInfo = {
  id: "codex",
  displayName: "Codex",
  installed: true,
  path: "/overridden/codex",
  version: "0.154.0",
  installHint: "",
  models: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol"],
};
const client = new CoreClient({ baseUrl: "http://test.invalid", token: "test" });
const renderNotice = (current = agent, model = "gpt-6.2-sol") =>
  renderToStaticMarkup(
    <CoreProvider client={client} host={nullHost}>
      <CodexCacheNotice agent={current} model={model} />
    </CoreProvider>,
  );

test("the notice is nonblocking, names the resolved CLI, and offers manual guidance only", () => {
  const html = renderNotice();
  expect(html).toContain('role="status"');
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain("autofocus");
  expect(html).toContain("/overridden/codex");
  expect(html).toContain("Codex 0.154.0");
  expect(html).toContain("stable 0.162.0 or later");
  expect(html).toContain("choose GPT-6.1 Sol manually");
  expect(html).toContain("Upstream cache report");
  expect(html).not.toContain('disabled=""');
});

test("current stable and unknown versions keep the scope explicit", () => {
  const current = renderNotice({ ...agent, version: "0.171.0" });
  expect(current).toContain("does not verify caching or usage savings");
  expect(current).not.toContain("update that external");
  expect(current).not.toContain("choose GPT-6.1");
  const { version: _, ...unknown } = agent;
  expect(renderNotice(unknown)).toContain("could not be compared");
  expect(renderNotice({ ...agent, models: ["gpt-6.2-sol"] })).not.toContain("choose GPT-6.1");
  expect(renderNotice({ ...agent, installed: false })).toBe("");
  expect(renderNotice({ ...agent, id: "claude" })).toBe("");
});

function renderComposer(thread: Thread | null = null, loadingThread = false) {
  const initial = useUiStore.getInitialState(),
    previous = { ...initial };
  const qc = new QueryClient();
  qc.setQueryData(
    ["settings"],
    Settings.parse({ defaultAgent: "codex", agents: { codex: { model: "gpt-6.2-sol" } } }),
  );
  qc.setQueryData(["doctor"], {
    agents: [agent, { ...agent, id: "claude", displayName: "Claude" }],
  });
  Object.assign(initial, {
    activeProjectId: "project",
    activeThreadId: thread?.id ?? null,
    drafts: { [thread?.id ?? newChatDraftKey("project")]: "Check this board" },
  });
  try {
    return renderToStaticMarkup(
      <CoreProvider client={client} host={nullHost} queryClient={qc}>
        <Composer
          thread={thread}
          loadingThread={loadingThread}
          onCreateThread={async () => {
            throw new Error("No chat should be created");
          }}
        />
      </CoreProvider>,
    );
  } finally {
    Object.assign(initial, previous);
    qc.clear();
  }
}
const thread: Thread = {
  id: "thread",
  projectId: "project",
  folderId: null,
  title: "Existing",
  pinned: false,
  archived: false,
  agentId: "codex",
  model: "gpt-6.2-astra",
  parentThreadId: null,
  branchFromMessageId: null,
  createdAt: "",
  updatedAt: "",
};

test("the composer covers configured defaults and existing selections without changing them", () => {
  expect(renderComposer()).toContain("GPT-6.2 Sol cache usage");
  const html = renderComposer(thread);
  expect(html).toContain("GPT-6.2 Astra cache usage");
  expect(html).not.toContain("GPT-6.2 Sol cache usage");
  expect(html.match(/<button[^>]*aria-label="Send message"[^>]*>/)?.[0]).not.toContain(
    'disabled=""',
  );
  expect(renderComposer({ ...thread, model: "gpt-6.1-sol" })).not.toContain(
    "data-codex-cache-notice",
  );
  expect(renderComposer({ ...thread, agentId: "claude" })).not.toContain("data-codex-cache-notice");
  expect(renderComposer(thread, true)).not.toContain("data-codex-cache-notice");
});
