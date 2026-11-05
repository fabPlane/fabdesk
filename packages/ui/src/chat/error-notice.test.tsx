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

test("agent recovery stays compact while sign-in instructions remain in collapsed details", () => {
  const html = renderToStaticMarkup(<ErrorNotice error={raw} agentId="claude" />);
  const summary = html.split("<details")[0]!;
  expect(summary).toContain("Switch agent");
  expect(summary).not.toContain("claude auth login");
  expect(summary).not.toContain("Your agent login has expired");
  expect(html).toContain("claude auth login");
  expect(html).toContain("Agent settings");
  expect(html).not.toContain("<details open");
});

test("defaults failure distinguishes the usable chat and retains the real HTTP failure", () => {
  const html = renderToStaticMarkup(<ErrorNotice error={new CoreHttpError(404, "/settings/agent-preference", '{"error":"not found"}')}
    title="Using Codex · default not saved" description="You can continue in this chat." tone="warning" onRetry={() => {}} onRestart={() => {}} onDismiss={() => {}} />);
  expect(html).toContain('role="status"');
  expect(html).not.toContain('role="alert"');
  expect(html).toContain("Using Codex · default not saved");
  expect(html).toContain("Restart core");
  expect(html).toContain("Retry");
  expect(html).toContain("HTTP 404 /settings/agent-preference");
  expect(html.split("<details")[0]).not.toContain("not found");
  expect(html).not.toContain("Choose project");
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

test("a metadata warning accompanying a rejected model stays in Details", () => {
  const warning = "⚠ Model metadata for gpt-6.1-sol not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";
  const rejected = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
  const text = `${warning}\n\n⚠ ${rejected}`;
  const html = render(<MessageBubble message={{ ...message, contentMd: text, parts: [{ type: "text", text }] }} streaming={false} />);
  expect(html).toContain("The selected model is unavailable");
  expect(html.split("<details")[0]).not.toContain("Model metadata");
  expect(html).toContain("Defaulting to fallback metadata");
  expect(html.match(/data-testid="error-notice"/g)).toHaveLength(1);
});

test("a changed-model advisory is compact and keeps the successful reply visible", () => {
  const notice = "This session was recorded with model `old-model` but is resuming with `new-model`. Consider switching back to `old-model` as it may affect Codex performance.";
  const text = `⚠ ${notice}\n\nReady.`;
  const html = render(<MessageBubble message={{ ...message, contentMd: text, parts: [{ type: "text", text }] }} streaming={false} />);
  expect(html).toContain("Model changed for this conversation");
  expect(html).toContain('data-severity="warning"');
  expect(html).toContain("Ready.");
  expect(html.split("<details")[0]).not.toContain("Consider switching back");
  expect(html).not.toContain("Choose model");
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
