import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CoreClient, CoreHttpError, CoreProvider, nullHost } from "@fabdesk/client-core";
import type { ReactNode } from "react";
import { ErrorAgentContext, ErrorNotice } from "../components/ErrorNotice";
import { MessageBubble } from "./MessageList";
import type { Message } from "@fabdesk/protocol";

const raw = "Failed to authenticate: OAuth session expired and could not be refreshed";
const client = new CoreClient({ baseUrl: "http://test.invalid", token: "test" });
const render = (node: ReactNode) => renderToStaticMarkup(<CoreProvider client={client} host={nullHost}>{node}</CoreProvider>);
const message: Message = { id: "m", threadId: "t", role: "assistant", runId: "r", createdAt: "2026-10-19T00:00:00Z", contentMd: `${raw}\n\n⚠ ${raw}`, parts: [{ type: "text", text: `${raw}\n\n⚠ ${raw}` }] };

test("historical duplicate failures render one explanation with sign-in instructions", () => {
  const html = renderToStaticMarkup(<ErrorAgentContext.Provider value="claude"><MessageBubble message={message} streaming={false} /></ErrorAgentContext.Provider>);
  expect(html.match(/data-testid="error-notice"/g)).toHaveLength(1);
  expect(html).toContain("Claude needs you to sign in again");
  expect(html).toContain("claude auth login");
  expect(html).toContain("Agent settings");
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
});

test("raw JSON is kept in collapsed details, not the main explanation", () => {
  const html = renderToStaticMarkup(<ErrorNotice error={new CoreHttpError(404, "/threads", '{"code":"project_not_found","error":"missing"}')} />);
  expect(html).toContain("Choose a project again");
  expect(html).toContain("Choose project");
  expect(html.split("<details")[0]).not.toContain("project_not_found");
});

test("historical account-model rejection offers the in-chat picker, preserving partial work", () => {
  const text = "I inspected your schematic.\n\n⚠ The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
  const html = render(<MessageBubble message={{ ...message, contentMd: text, parts: [{ type: "text", text }] }} streaming={false} />);
  expect(html).toContain("I inspected your schematic.");
  expect(html).toContain("The selected model is unavailable");
  expect(html).toContain("Choose model");
  expect(html).not.toContain("Agent settings");
  expect(html).not.toContain("sign in again");
});

test("a user quoting an error is never rewritten as an app failure", () => {
  const html = renderToStaticMarkup(<MessageBubble message={{ ...message, role: "user" }} streaming={false} />);
  expect(html).not.toContain('data-testid="error-notice"');
  expect(html).toContain("Failed to authenticate");
});

test("partial work is preserved before a failure and ordinary warnings remain text", () => {
  const content = `I saved your schematic.\n\n⚠ ${raw}`;
  const html = render(<MessageBubble message={{ ...message, contentMd: content, parts: [{ type: "text", text: content }] }} streaming={false} />);
  expect(html).toContain("I saved your schematic.");
  expect(html.match(/data-testid="error-notice"/g)).toHaveLength(1);
  const warning = "⚠ Check polarity before connecting power.";
  const normal = render(<MessageBubble message={{ ...message, contentMd: warning, parts: [{ type: "text", text: warning }] }} streaming={false} />);
  expect(normal).not.toContain('data-testid="error-notice"');
  expect(normal).toContain("Check polarity");
});

test("Codex's nonfatal Windows warning stays separate from its normal reply", () => {
  const text = "⚠ Windows denied a Codex overlay symlink (EPERM). Using the original CODEX_HOME and live credential store; per-project config isolation is unavailable.\n\nI will inspect the board.";
  const html = render(<MessageBubble message={{ ...message, contentMd: text, parts: [{ type: "text", text }] }} streaming={false} />);
  expect(html).toContain('data-severity="warning"');
  expect(html).toContain('role="status"');
  expect(html).not.toContain('role="alert"');
  expect(html).toContain("Codex is using your shared settings");
  expect(html).toContain("I will inspect the board.");
  expect(html).not.toContain("sign in again");
});
