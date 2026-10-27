import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { Settings, type Thread } from "@fabdesk/protocol";
import { CoreClient, CoreProvider, nullHost } from "@fabdesk/client-core";
import { Composer } from "./Composer";
import { useUiStore } from "../stores/ui";
import { useAppActions, type AppActions } from "../app/useAppActions";

const client = new CoreClient({ baseUrl: "http://test.invalid", token: "test" });
const settings = Settings.parse({ defaultAgent: "codex", agents: { codex: { model: "gpt-6-astra" } } });

function renderComposer(projectId: string | null, thread: Thread | null = null, loadingThread = false, withSettings = true) {
  // Zustand's server renderer reads its initial snapshot, rather than the live browser state.
  const initial = useUiStore.getInitialState();
  const previous = { ...initial };
  const qc = new QueryClient();
  if (withSettings) qc.setQueryData(["settings"], settings);
  Object.assign(initial, { activeProjectId: projectId, drafts: { [thread?.id ?? "__new__"]: "Build a board" } });
  try {
    return renderToStaticMarkup(<CoreProvider client={client} host={nullHost} queryClient={qc}>
      <Composer thread={thread} loadingThread={loadingThread} onCreateThread={async () => { throw new Error("Rendering must not create a chat"); }} />
    </CoreProvider>);
  } finally {
    Object.assign(initial, previous);
    qc.clear();
  }
}

function sendButton(html: string) {
  const button = html.match(/<button[^>]*aria-label="Send message"[^>]*>/)?.[0];
  expect(button).toBeDefined();
  return button!;
}

test("a nonempty draft still requires a project, with a way to reopen the picker", () => {
  const html = renderComposer(null);
  expect(sendButton(html)).toContain(' disabled=""');
  expect(html).toContain("Choose project");
  expect(html).toContain("Build a board");
  expect(sendButton(renderComposer("project-a"))).not.toContain(' disabled=""');
});

test("sending waits for the existing chat and saved settings to load", () => {
  expect(sendButton(renderComposer("project-a", null, true))).toContain(' disabled=""');
  expect(sendButton(renderComposer("project-a", null, false, false))).toContain(' disabled=""');
  expect(renderComposer("project-a", null, true).match(/<button[^>]*data-testid="agent-model"[^>]*>/)?.[0]).toContain(' disabled=""');
});

test("new chats initialize from saved preferences; existing threads keep their own model", () => {
  expect(renderComposer("project-a")).toContain("GPT-6 Astra");
  const thread: Thread = {
    id: "thread-a", projectId: "project-a", folderId: null, title: "Existing chat", pinned: false, archived: false,
    agentId: "claude", model: "thread-model", parentThreadId: null, branchFromMessageId: null, createdAt: "", updatedAt: "",
  };
  expect(renderComposer("project-a", thread)).toContain("thread-model");
  expect(renderComposer("project-a", { ...thread, model: null })).not.toContain("GPT-6 Astra");
});

test("the New Chat action opens the picker without discarding the current conversation", () => {
  const previous = useUiStore.getState();
  const actions: { current?: AppActions } = {};
  function CaptureActions() { actions.current = useAppActions(); return null; }
  try {
    useUiStore.setState({ activeProjectId: "project-a", activeThreadId: "thread-a" });
    renderToStaticMarkup(<CoreProvider client={client}><CaptureActions /></CoreProvider>);
    actions.current!.newChat();
    expect(useUiStore.getState()).toMatchObject({ activeProjectId: "project-a", activeThreadId: "thread-a", projectPickerOpen: true });
    useUiStore.getState().setProjectPickerOpen(false);
    expect(useUiStore.getState().activeThreadId).toBe("thread-a");
  } finally { useUiStore.setState(previous); }
});
