import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { Settings, type Thread } from "@fabdesk/protocol";
import { CoreClient, CoreProvider, nullHost } from "@fabdesk/client-core";
import { Composer } from "./Composer";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { useAppActions, type AppActions } from "../app/useAppActions";

const client = new CoreClient({ baseUrl: "http://test.invalid", token: "test" });
const settings = Settings.parse({ defaultAgent: "codex", agents: { codex: { model: "gpt-6-astra" } } });

function renderComposer(projectId: string | null, thread: Thread | null = null, loadingThread = false, withSettings = true, effort?: string | null, levels?: string[], startMode = false) {
  // Zustand's server renderer reads its initial snapshot, rather than the live browser state.
  const initial = useUiStore.getInitialState();
  const previous = { ...initial };
  const qc = new QueryClient();
  if (withSettings) qc.setQueryData(["settings"], effort === undefined ? settings : Settings.parse({
    ...settings, agents: { codex: { ...settings.agents.codex, effort } },
  }));
  if (levels) qc.setQueryData(["doctor"], { agents: [{
    id: "codex", displayName: "Codex", installed: true, models: ["gpt-6-astra"],
    modelEfforts: { "gpt-6-astra": levels },
  }] });
  const selectedId = thread?.id ?? (loadingThread ? "loading-thread" : null);
  Object.assign(initial, { activeProjectId: projectId, activeThreadId: selectedId, drafts: { [selectedId ?? newChatDraftKey(projectId)]: "Build a board" } });
  try {
    return renderToStaticMarkup(<CoreProvider client={client} host={nullHost} queryClient={qc}>
      <Composer startMode={startMode} thread={thread} loadingThread={loadingThread} onCreateThread={async () => { throw new Error("Rendering must not create a chat"); }} />
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
  expect(renderComposer("project-a", null, true)).toContain("Build a board");
  expect(renderComposer("project-a", null, true)).toContain("Loading chat agent and model");
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

test("the model label shows the effective effort, including Auto and unsupported-model fallback", () => {
  const label = (effort: string | null, levels: string[]) => renderComposer("project-a", null, false, true, effort, levels);
  expect(label("high", ["low", "high"])).toContain(">GPT-6 Astra High</span>");
  expect(label("high", ["low", "high"])).toContain('aria-label="Agent and model: Codex: GPT-6 Astra High"');
  expect(label("low", ["low", "high"])).toContain(">GPT-6 Astra Low</span>");
  expect(label(null, ["low", "high"])).toContain(">GPT-6 Astra Auto</span>");
  expect(label("ultra", ["low", "high"])).toContain(">GPT-6 Astra Auto</span>");
  expect(label("high", [])).toContain(">GPT-6 Astra</span>");
});

test("Home can begin an idea draft without requiring a project picker", () => {
  const html = renderComposer(null, null, false, true, undefined, undefined, true);
  expect(sendButton(html)).not.toContain(' disabled=""');
  expect(html).not.toContain("Choose project");
});

test("markup toggle is off by default and pressed with a drawing placeholder while on", () => {
  const html = renderComposer("project-a");
  expect(html).toContain('data-testid="markup-toggle"');
  expect(html).toContain("Markup");
  expect(html).not.toContain("Draw on the canvas and ask about it");
  expect(html.match(/<button[^>]*data-testid="markup-toggle"[^>]*>/)?.[0]).not.toContain(' disabled=""');
  const initial = useUiStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, { markupOpen: true, markupTool: "pen", activeProjectId: "project-a", drafts: { [newChatDraftKey("project-a")]: "Build a board" } });
  try {
    const open = renderComposer("project-a");
    expect(open).toContain('aria-pressed="true"');
    expect(open).toContain("Draw on the canvas and ask about it");
  } finally {
    Object.assign(initial, previous);
  }
});

test("startMode hides markup because there is no board view", () => {
  expect(renderComposer(null, null, false, true, undefined, undefined, true)).not.toContain('data-testid="markup-toggle"');
});

test("markup toggle is disabled on DOM-only workspace tabs", () => {
  const initial = useUiStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, { boardTab: "notes", workspaceArea: "files", activeProjectId: "project-a", drafts: { [newChatDraftKey("project-a")]: "Build a board" } });
  try {
    const html = renderComposer("project-a");
    const button = html.match(/<button[^>]*data-testid="markup-toggle"[^>]*>/)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain(' disabled=""');
  } finally {
    Object.assign(initial, previous);
  }
});
