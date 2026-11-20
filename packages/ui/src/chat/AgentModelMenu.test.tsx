import { expect, test } from "bun:test";
import { act, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { createRequire } from "node:module";
import type { AgentId, AgentInfo } from "@fabdesk/protocol";
import { CoreClient, CoreProvider, nullHost } from "@fabdesk/client-core";
import { AgentModelMenu } from "./AgentModelMenu";

// jsdom is an existing runtime-only dependency; the harness only needs its DOM window.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis };
};

test("focused model guidance preserves focus, availability, and explicit selection", async () => {
  const dom = new JSDOM("<!doctype html><button id='anchor'>Model</button><div id='root'></div>", {
    url: "http://test.invalid",
  });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    innerHeight: 800,
    innerWidth: 1000,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.querySelector("#root")!);
  const anchor = document.querySelector<HTMLButtonElement>("#anchor")!;
  const selected: Array<[AgentId, string]> = [],
    links: string[] = [];
  const client = new CoreClient({ baseUrl: "http://test.invalid", token: "test" });
  const agents: AgentInfo[] = [
    {
      id: "codex",
      displayName: "Codex",
      installed: true,
      version: "0.154.0",
      path: "/custom/codex",
      installHint: "",
      models: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol"],
    },
    {
      id: "claude",
      displayName: "Claude",
      installed: true,
      version: "0.154.0",
      path: "/custom/claude",
      installHint: "",
      models: ["gpt-6.2-sol"],
    },
  ];
  const render = (open: boolean) => (
    <CoreProvider
      client={client}
      subscribe={() => ({ close() {} })}
      host={{
        ...nullHost,
        openExternal: (url) => {
          links.push(url);
        },
      }}
    >
      <AgentModelMenu
        open={open}
        anchorRef={{ current: anchor } as RefObject<HTMLButtonElement>}
        onClose={() => {}}
        agents={agents}
        agentId="codex"
        model="gpt-6.2-sol"
        defaultModel={(id) => (id === "codex" ? "gpt-6.2-sol" : "")}
        configuredModels={() => []}
        onSelect={(id, model) => selected.push([id, model])}
        onOpenSettings={() => {}}
        effort={{
          levels: [],
          value: null,
          agentName: "Codex",
          disabled: false,
          saving: false,
          onChange: async () => true,
        }}
      />
    </CoreProvider>
  );
  const note = () => document.querySelector("[data-codex-cache-notice]");
  try {
    await act(async () => {
      root.render(render(true));
    });
    const codex = document.querySelector<HTMLButtonElement>('[data-agent="codex"]')!;
    expect(document.activeElement).toBe(codex);
    expect(note()).toBeNull();
    await act(async () => {
      codex.click();
    });
    const sol = document.querySelector<HTMLButtonElement>(
      '#agent-models-codex button[title="gpt-6.2-sol"]',
    )!;
    await act(async () => {
      sol.focus();
    });
    expect(note()?.textContent).toContain("GPT-6.2 Sol cache usage");
    expect(document.activeElement).toBe(sol);
    expect(selected).toEqual([]);
    expect(links).toEqual([]);
    const astra = document.querySelector<HTMLButtonElement>(
      '#agent-models-codex button[title="gpt-6.2-astra"]',
    )!;
    await act(async () => {
      astra.focus();
    });
    expect(note()?.textContent).toContain("GPT-6.2 Astra cache usage");
    expect(note()?.textContent).not.toContain("GPT-6.2 Sol cache usage");
    const report = Array.from(note()!.querySelectorAll("button")).find(
      (button) => button.textContent === "Upstream cache report",
    )!;
    await act(async () => {
      report.focus();
    });
    expect(note()).not.toBeNull();
    expect(document.activeElement).toBe(report);
    await act(async () => {
      window.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toBe("Codex 0.162.0 release");
    await act(async () => {
      report.click();
    });
    expect(links).toEqual(["https://github.com/openai/codex/issues/62312"]);
    expect(selected).toEqual([]);
    const claude = document.querySelector<HTMLButtonElement>('[data-agent="claude"]')!;
    await act(async () => {
      claude.focus();
      claude.click();
    });
    expect(note()).toBeNull();
    const claudeModel = document.querySelector<HTMLButtonElement>(
      '#agent-models-claude button[title="gpt-6.2-sol"]',
    )!;
    await act(async () => {
      claudeModel.focus();
    });
    expect(note()).toBeNull();
    expect(selected).toEqual([]);
    await act(async () => {
      codex.click();
    });
    const manual = document.querySelector<HTMLButtonElement>(
      '#agent-models-codex button[title="gpt-6.1-sol"]',
    )!;
    await act(async () => {
      manual.focus();
      manual.click();
    });
    expect(note()).toBeNull();
    expect(selected).toEqual([["codex", "gpt-6.1-sol"]]);
    await act(async () => {
      root.render(render(false));
    });
    expect(document.activeElement).toBe(anchor);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
