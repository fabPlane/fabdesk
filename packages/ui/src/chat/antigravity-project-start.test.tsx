import { expect, test } from "bun:test";
import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { CoreClient, CoreProvider } from "@fabdesk/client-core";
import { ProjectManifest, Settings } from "@fabdesk/protocol";
// @ts-expect-error The test-only root jsdom dependency has no type declarations.
import { JSDOM } from "jsdom";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { composerHandlers } from "./Composer";
import { ThreadView } from "./ThreadView";

const prompt = "make me a simple blinking light board";
const model = "gemini-4-neon-high";
const project = { id: "blinky", name: "Blinky", path: "/projects/blinky", createdAt: "", updatedAt: "", isDraft: false };

test.each(["home", "draft thread", "prepared Home draft", "prepared Home draft with default model", "Home without CLI", "draft thread without CLI"] as const)("Antigravity project setup preserves the model and message from %s", async (entry) => {
  const existingDraft = entry.startsWith("draft thread");
  const startsWithoutCli = entry.endsWith("without CLI");
  let cliInstalled = !startsWithoutCli;
  let doctorRequests = 0;
  const doctorReport = () => ({ agents: [{ id: "antigravity", installed: cliInstalled, displayName: "Antigravity", installHint: "Install the Antigravity CLI", models: cliInstalled ? [model] : [] }] });
  const useDefaultModel = entry === "prepared Home draft with default model";
  const preparedHomeDraft = entry === "prepared Home draft" || useDefaultModel;
  const claudeModel = "claude-opus-5-5";
  const selectedModel = useDefaultModel ? null : model;
  const w = new JSDOM("<body><div id='mount'></div></body>", { url: "http://test.invalid", pretendToBeVisual: true }).window;
  const globals = Object.entries({
    window: w, document: w.document, HTMLElement: w.HTMLElement, HTMLInputElement: w.HTMLInputElement,
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    ResizeObserver: class { observe() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const originals = new Map(globals.map(([key]) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalUi = useUiStore.getState();
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(w.document.querySelector("#mount"));
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const thread = { id: "t", projectId: project.id, agentId: "antigravity", model: selectedModel, title: "New chat", runtimeMode: "full" };
  let persistedThread = thread;
  const submittedModels: (unknown | null)[] = [];
  const manifest = ProjectManifest.parse({ schema: 1, id: project.id, name: project.name, createdAt: "", updatedAt: "", board: {} });
  let activeProject = { ...project, isDraft: existingDraft, manifest: { ...manifest, ...(existingDraft ? { ideaDraft: {} } : {}) }, files: [] };
  let sendFailuresLeft = preparedHomeDraft ? 2 : 1;
  const client = new CoreClient({ baseUrl: "http://test.invalid", token: "test", fetch: async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (path === "/projects") {
        if (body["draft"] === true) {
          activeProject = { ...activeProject, isDraft: true, manifest: { ...manifest, ideaDraft: {} } };
          return Response.json(activeProject, { status: 201 });
        }
        return Response.json(project, { status: 201 });
      }
      if (path === "/projects/blinky/promote") {
        activeProject = { ...activeProject, name: String(body["name"]), isDraft: false, manifest };
        return Response.json(activeProject);
      }
      if (path === "/threads") {
        persistedThread = { ...thread, ...body, projectId: project.id };
        return Response.json(persistedThread);
      }
      if (path === "/threads/t/messages?queue=1") {
        // Core resolves an omitted model against the stored thread model.
        submittedModels.push(body["model"] ?? persistedThread.model);
        if (sendFailuresLeft > 0) {
          sendFailuresLeft--;
          return Response.json({ code: "precondition", error: "Try again later" }, { status: 412 });
        }
        return Response.json({ messageId: "m" }, { status: 202 });
      }
    }
    if (path === "/threads/t" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      persistedThread = { ...persistedThread, ...body };
      return Response.json(persistedThread);
    }
    if (path === "/settings/agent-preference" && init?.method === "PUT") return Response.json(agySettings);
    if (path === "/doctor") { doctorRequests++; return Response.json(doctorReport()); }
    if (path === "/projects/blinky") return Response.json(activeProject);
    if (path === "/projects/blinky/finish-it") return Response.json({ session: null });
    if (path === "/threads/t") return Response.json(persistedThread);
    return Response.json([]);
  } });
  const agySettings = Settings.parse({ defaultAgent: "antigravity", agents: { antigravity: { model: selectedModel }, claude: { model: claudeModel } } });
  qc.setQueryData(["settings"], preparedHomeDraft ? Settings.parse({ ...agySettings, defaultAgent: "claude" }) : agySettings);
  qc.setQueryData(["doctor"], doctorReport());
  if (existingDraft) {
    qc.setQueryData(["project", project.id], activeProject);
    qc.setQueryData(["thread", thread.id], thread);
  }
  const draftKey = existingDraft ? thread.id : newChatDraftKey(null);
  useUiStore.setState({
    activeProjectId: existingDraft ? project.id : null, activeThreadId: existingDraft ? thread.id : null, drafts: { [draftKey]: prompt },
    attachments: { [draftKey]: [{ label: "Sketch", path: "/tmp/demo.png", mime: "image/png" }] },
  });
  try {
    await act(async () => root.render(<CoreProvider client={client} queryClient={qc} subscribe={() => ({ close() {} })}>
      <ThreadView presentation={existingDraft ? "chat" : "start"} />
    </CoreProvider>));
    const send = () => (w.document.querySelector('[aria-label="Send message"]') as HTMLButtonElement).click();
    if (startsWithoutCli) {
      expect((w.document.querySelector('[aria-label="Send message"]') as HTMLButtonElement).disabled).toBe(true);
      expect(composerHandlers.canSend?.()).toBe(false);
      expect(w.document.querySelector(".fd-setup-notice")?.textContent).toContain("Antigravity CLI not found");
      await act(async () => { send(); composerHandlers.send?.(); });
      expect(w.document.querySelector('[role="dialog"]')).toBeNull();
      expect(writes).toHaveLength(0);
      expect(useUiStore.getState().drafts[draftKey]).toBe(prompt);
      expect(useUiStore.getState().attachments[draftKey]).toHaveLength(1);
      cliInstalled = true;
      const beforeRecheck = doctorRequests;
      const recheck = [...w.document.querySelectorAll(".fd-setup-notice button")].find((button: HTMLButtonElement) => button.textContent === "Recheck installation") as HTMLButtonElement;
      await act(async () => { recheck.click(); await Bun.sleep(25); });
      expect(doctorRequests).toBe(beforeRecheck + 1);
      expect(w.document.querySelector(".fd-setup-notice")).toBeNull();
      expect(composerHandlers.canSend?.()).toBe(true);
    }
    if (preparedHomeDraft) {
      await act(async () => { send(); await Bun.sleep(25); });
      expect(writes.map(x => x.path)).toEqual(["/projects", "/threads", "/threads/t/messages?queue=1"]);
      expect(writes[0]?.body["draft"]).toBe(true);
      expect(writes[2]?.body).toMatchObject({ agentId: "claude", model: claudeModel });
      expect(useUiStore.getState().drafts[draftKey]).toBe(prompt);
      await act(async () => {
        expect(composerHandlers.setAgent?.("antigravity", selectedModel)).toBe(true);
        await Bun.sleep(25);
      });
      expect(w.document.querySelector('[data-testid="agent-model"]')?.getAttribute("aria-label")).toContain("Antigravity");
    }
    const preflightWrites = writes.length;
    await act(async () => send());
    let dialog = w.document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Create a project for Antigravity");
    expect(writes).toHaveLength(preflightWrites);
    expect(composerHandlers.canSelectAgent?.()).toBe(false);
    const cancel = [...dialog.querySelectorAll("button")].find((button: HTMLButtonElement) => button.textContent === "Cancel") as HTMLButtonElement;
    await act(async () => cancel.click());
    expect(writes).toHaveLength(preflightWrites);
    expect(useUiStore.getState().drafts[draftKey]).toBe(prompt);

    await act(async () => send());
    dialog = w.document.querySelector('[role="dialog"]');
    const input = dialog.querySelector("input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(input, "Blinky");
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
    });
    await act(async () => {
      dialog.querySelector('button[type="submit"]').click();
      await Bun.sleep(25);
    });
    expect(submittedModels.at(-1)).toBe(selectedModel);
    const usesExisting = existingDraft || preparedHomeDraft;
    const setupPaths = preparedHomeDraft ? ["/projects/blinky/promote", "/threads/t"] : usesExisting ? ["/projects/blinky/promote"] : ["/projects", "/threads"];
    expect(writes.slice(preflightWrites).map(x => x.path)).toEqual([...setupPaths, "/threads/t/messages?queue=1"]);
    expect(writes[preflightWrites]?.body).toEqual({ name: "Blinky" });
    if (!usesExisting) expect(writes[preflightWrites + 1]?.body).toMatchObject({ projectId: "blinky", model, agentId: "antigravity" });
    if (preparedHomeDraft) expect(writes[preflightWrites + 1]?.body).toEqual({ agentId: "antigravity", model: selectedModel });
    expect(writes[preflightWrites + setupPaths.length]?.body).toMatchObject({
      content: prompt, ...(selectedModel ? { model: selectedModel } : {}), agentId: "antigravity", workspaceContext: { projectId: "blinky" },
      attachments: [{ path: "/tmp/demo.png", mime: "image/png" }],
    });
    expect(useUiStore.getState().drafts[draftKey]).toBe(prompt);
    await act(async () => { send(); await Bun.sleep(25); });
    expect(writes.slice(preflightWrites).map(x => x.path)).toEqual([...setupPaths, "/threads/t/messages?queue=1", "/threads/t/messages?queue=1"]);
    const initialSend = preflightWrites + setupPaths.length;
    const first = writes[initialSend]!.body;
    expect(writes[initialSend + 1]?.body).toMatchObject({
      content: first["content"], ...(selectedModel ? { model: selectedModel } : {}), agentId: first["agentId"],
      attachments: first["attachments"], workspaceContext: { projectId: "blinky" },
    });
    expect(submittedModels.slice(-2)).toEqual([selectedModel, selectedModel]);
    expect(useUiStore.getState().drafts[draftKey]).toBe("");
  } finally {
    await act(async () => { root.unmount(); await Bun.sleep(0); });
    qc.clear();
    useUiStore.setState(originalUi);
    for (const [key, property] of originals) {
      if (property) Object.defineProperty(globalThis, key, property);
      else Reflect.deleteProperty(globalThis, key);
    }
    w.close();
  }
});
