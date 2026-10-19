import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { CoreClient, CoreProvider, nullHost, useRunsStore } from "@fabdesk/client-core";
import { ToolCallCard, isCommandTool, isImageTool } from "./ToolCallCard";
import { WorkedActivity } from "./RunActivity";
import { MessageBubble } from "./MessageList";
import { MessageList, ToolGroup } from "./MessageList";
import type { Message, Thread } from "@fabdesk/protocol";

const command = { type: "tool_use" as const, id: "cmd", name: "command_execution", input: { command: "git status --short" } };
const result = { type: "tool_result" as const, id: "cmd", output: "clean" };
const image = { type: "tool_use" as const, id: "image", name: "mcp__fabdesk__view_image", input: { path: "C:\\boards\\preview.png" } };
const imageResult = { type: "tool_result" as const, id: "image", output: "Viewed" };
const client = new CoreClient({ baseUrl: "http://test.invalid", token: "test" });
const render = (node: ReactNode) => renderToStaticMarkup(<CoreProvider client={client} host={nullHost}>{node}</CoreProvider>);
afterEach(() => useRunsStore.setState({ runsByThread: {}, threadByRun: {} }));

test("collapsed groups expose active commands but keep completed command details folded", () => {
  const html = render(<ToolGroup calls={[{ use: command, result }, { use: { ...command, id: "current", input: { command: "inspect board" } } }]} streaming />);
  expect(html).toContain("Running inspect board");
  expect(html).not.toContain("Ran git status");
  expect(html).toContain('data-active="true"');
  expect(html).toContain("fd-activity-shimmer");
});

test("stopped or historical pending calls do not shimmer or claim to be running", () => {
  const html = render(<ToolCallCard use={command} />);
  expect(html).toContain("Pending git status");
  expect(html).not.toContain("fd-activity-shimmer");
  expect(render(<ToolGroup calls={[{ use: command }]} streaming={false} />)).not.toContain("Running");
});

test("image steps stay visible while collapsed and distinguish viewing, viewed and failure", () => {
  const active = render(<ToolGroup calls={[{ use: image }]} streaming />);
  expect(active).toContain("Viewing image · preview.png");
  expect(active).toContain('data-kind="image"');
  const complete = render(<ToolGroup calls={[{ use: image, result: imageResult }]} streaming={false} />);
  expect(complete).toContain("Viewed image · preview.png");
  expect(complete).not.toContain("fd-activity-shimmer");
  const failed = render(<ToolCallCard use={image} result={{ ...imageResult, isError: true }} streaming />);
  expect(failed).toContain("Could not view image");
  expect(failed).not.toContain("Viewed image");
  expect(failed).not.toContain("fd-activity-shimmer");
});

test("only explicit image-view tools get viewed-image labels", () => {
  for (const name of ["view_image", "functions.view_image", "mcp__a_server__view_image", "image_view", "open_image"]) expect(isImageTool(name)).toBe(true);
  for (const name of ["render_board", "generate_image", "Read", "image_search"]) expect(isImageTool(name)).toBe(false);
});

test("a new run does not animate unfinished tools belonging to an older run", () => {
  useRunsStore.getState().startRun({ runId: "new", threadId: "thread", agentId: "codex", startedAt: Date.now() });
  const thread = { id: "thread", parentThreadId: null } as Thread;
  const old: Message = { id: "old-message", threadId: "thread", role: "assistant", runId: "old", contentMd: "", parts: [command], createdAt: "2026-10-16T00:00:00Z" };
  // Zustand SSR reads getInitialState, so supply the live snapshot explicitly.
  const snapshot = useRunsStore.getInitialState();
  const previous = snapshot.runsByThread;
  snapshot.runsByThread = useRunsStore.getState().runsByThread;
  let html: string;
  try { html = render(<MessageList thread={thread} messages={[old]} loading={false} />); }
  finally { snapshot.runsByThread = previous; }
  expect(html).not.toContain("Running git status");
  expect(html).toContain('data-testid="run-activity"');
  expect(html).toContain("Working…");
});

test("command icons recognize explicit namespaced shell tools", () => {
  expect(isCommandTool("functions.exec_command")).toBe(true);
  expect(isCommandTool("mcp__desktop__run_shell_command")).toBe(true);
  expect(isCommandTool("Bash")).toBe(true);
  expect(isCommandTool("command_palette")).toBe(false);
});

const finishedRun = { id: "finished", threadId: "thread", agentId: "codex" as const, agentSessionId: null, status: "completed" as const, startedAt: "2026-10-16T10:00:00Z", endedAt: "2026-10-16T10:04:11Z", exitCode: 0 };

test("stopped, failed, and unanswered activity starts expanded so useful content stays visible", () => {
  for (const status of ["aborted", "failed"] as const) {
    expect(render(<WorkedActivity run={{ ...finishedRun, status }}>Partial progress</WorkedActivity>)).toContain('<details open=""');
  }
  expect(render(<WorkedActivity run={finishedRun} unanswered>Unanswered question</WorkedActivity>)).toContain('<details open=""');
  expect(render(<WorkedActivity run={finishedRun}>Finished progress</WorkedActivity>)).not.toContain('<details open=""');
});
test("reopened chats show each saved duration instead of only the latest run's timing", () => {
  const earlier = { ...finishedRun, id: "earlier", endedAt: "2026-10-16T10:07:05Z" };
  const stopped = { ...finishedRun, id: "stopped", status: "aborted" as const, endedAt: "2026-10-16T10:00:12Z" };
  const thread = { id: "thread", parentThreadId: null, run: finishedRun, runs: [finishedRun, stopped, earlier] } as Thread & { run: typeof finishedRun; runs: (typeof earlier | typeof stopped)[] };
  const messages: Message[] = [earlier, stopped, finishedRun].flatMap((run, i) => [
    { id: `user-${i}`, threadId: "thread", role: "user", runId: null, contentMd: "Continue", parts: [], createdAt: run.startedAt },
    { id: `reply-${i}`, threadId: "thread", role: "assistant", runId: run.id, contentMd: "Reply", parts: [], createdAt: run.startedAt },
  ]);
  const html = render(<MessageList thread={thread} messages={messages} loading={false} />);
  expect(html).toContain("Worked for 7m 5s");
  expect(html).toContain("Worked for 12s · Stopped");
  expect(html).toContain("Worked for 4m 11s");
  expect(html.split('data-testid="worked-activity"').length - 1).toBe(3);
  expect(html).not.toContain(">Worked</span>");
});

test("finished duration uses persisted timestamps, with no invented timing", () => {
  expect(render(<WorkedActivity run={finishedRun} />)).toContain("Worked for 4m 11s");
  expect(render(<WorkedActivity run={{ ...finishedRun, endedAt: null }} />)).toContain(">Worked</span>");
  expect(render(<WorkedActivity run={{ ...finishedRun, endedAt: "invalid" }} />)).toContain(">Worked</span>");
  expect(render(<WorkedActivity run={{ ...finishedRun, status: "running" }} />)).toBe("");
  expect(render(<WorkedActivity run={{ ...finishedRun, status: "aborted" }} />)).toContain("Stopped");
});
test("finished summary appears once above matching assistant messages and survives snapshot rendering", () => {
  const thread = { id: "thread", parentThreadId: null, run: finishedRun } as Thread & { run: typeof finishedRun };
  const message: Message = { id: "reply", threadId: "thread", role: "assistant", runId: "finished", contentMd: "Ready", parts: [], createdAt: finishedRun.startedAt };
  const html = render(<MessageList thread={thread} messages={[message, { ...message, id: "reply-2" }]} loading={false} />);
  expect(html.split('data-testid="worked-activity"').length - 1).toBe(1);
  expect(html).toContain("border-b");
  expect(render(<MessageBubble message={message} streaming={false} />)).not.toContain(">Agent<");
});
test("collapsed tool errors show a labeled warning icon without counts", () => {
  const html = render(<ToolGroup calls={[{ use: command, result: { ...result, isError: true } }]} streaming={false} />);
  expect(html).toContain('aria-label="Tool error"');
  expect(html).toContain("text-danger");
  expect(html).not.toContain("1 error");
  expect(html).not.toContain("tabular-nums");
});
