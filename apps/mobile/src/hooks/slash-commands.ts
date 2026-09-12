/**
 * Slash commands for one thread's composer: the suggestions for the current draft, running one
 * (a direct tool call — never through the agent) and the toast that reports on it.
 *
 * The tool call goes through `useRunTool`, which turns a job-backed answer into a wait on the job
 * and mirrors it into the runs store, so the Jobs screen shows the same run the toast points at.
 */
import { useRunTool } from "@fabdesk/client-core";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isSlashDraft,
  parseSlashCommand,
  slashBlockedReason,
  slashSuggestions,
  slashToast,
  type SlashCommand,
} from "@/lib/slash-commands";
import { haptic } from "@/state/haptics";

const DONE_TOAST_MS = 6000;

export function useSlashCommands(
  thread: { id: string; projectId: string | null } | undefined,
  draft: string,
  setDraft: (next: string) => void,
) {
  const tool = useRunTool();
  const [last, setLast] = useState<SlashCommand | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const active = isSlashDraft(draft);
  const blocked = active ? slashBlockedReason(thread) : null;
  const suggestions = useMemo(
    () => (active && !blocked ? slashSuggestions(draft) : []),
    [active, blocked, draft],
  );
  /** For the composer button: `null` outside a slash draft, else whether it can run as typed. */
  const state: "ready" | "incomplete" | null = !active
    ? null
    : !blocked && parseSlashCommand(draft).ok
      ? "ready"
      : "incomplete";

  const run = useCallback(
    (command: SlashCommand) => {
      if (!thread?.projectId) return;
      setLast(command);
      setDismissed(false);
      setDraft("");
      haptic("tap");
      void tool.run(command.tool, { projectId: thread.projectId, ...command.args });
    },
    [thread?.projectId, tool, setDraft],
  );

  /** Return in a slash draft: run it if it parses; else keep the draft (the popover explains). */
  const submitDraft = useCallback((): boolean => {
    if (!active || blocked) return false;
    const parsed = parseSlashCommand(draft);
    if (!parsed.ok) return false;
    run(parsed.command);
    return true;
  }, [active, blocked, draft, run]);

  // A finished toast fades on its own; a failure stays until the next command or a tap.
  useEffect(() => {
    if (tool.state.status !== "done") return;
    const timer = setTimeout(() => setDismissed(true), DONE_TOAST_MS);
    return () => clearTimeout(timer);
  }, [tool.state.status, tool.state.jobId]);

  const toast = last && !dismissed ? slashToast(last, tool.state) : null;
  const openJobs = useCallback(() => {
    setDismissed(true);
    router.push({
      pathname: "/jobs",
      params: thread?.projectId ? { projectId: thread.projectId } : {},
    });
  }, [thread?.projectId]);

  return {
    active,
    state,
    blocked,
    suggestions,
    run,
    submitDraft,
    toast,
    openJobs,
    dismiss: () => setDismissed(true),
  };
}
