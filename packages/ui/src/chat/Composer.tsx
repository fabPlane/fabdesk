import type { AgentId, Thread } from "@fabdesk/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, IconButton, Kbd, Select, Textarea } from "../components/ui";
import { useCore } from "../core/CoreProvider";
import { useDoctor, useSettings } from "../hooks/queries";
import { useRunsStore } from "../stores/runs";
import { DRAFT_KEY_NEW, useUiStore } from "../stores/ui";
import { basename, mimeFromPath, modKey } from "../util";

/** Bridge for the global shortcut hook (mod+Enter send, mod+. abort). */
export const composerHandlers: { send: (() => void) | null; abort: (() => void) | null } = {
  send: null,
  abort: null,
};

export interface ComposerProps {
  thread: Thread | null;
  /** Creates a thread for a first message; returns the new thread id. */
  onCreateThread: (input: { title: string; agentId: AgentId; model?: string }) => Promise<string>;
}

const FALLBACK_AGENTS = [
  { id: "claude" as AgentId, displayName: "Claude Code", installed: true, installHint: "", models: [] as string[] },
];

const EMPTY: never[] = [];

export function Composer({ thread, onCreateThread }: ComposerProps) {
  const { client, host } = useCore();
  const qc = useQueryClient();
  const draftKey = thread?.id ?? DRAFT_KEY_NEW;
  const draft = useUiStore((s) => s.drafts[draftKey] ?? "");
  const setDraft = useUiStore((s) => s.setDraft);
  const pending = useUiStore((s) => s.attachments[draftKey] ?? EMPTY);
  const addAttachment = useUiStore((s) => s.addAttachment);
  const removeAttachment = useUiStore((s) => s.removeAttachment);
  const clearAttachments = useUiStore((s) => s.clearAttachments);
  const setSketchOpen = useUiStore((s) => s.setSketchOpen);
  const focusNonce = useUiStore((s) => s.composerFocusNonce);
  const agentPickerOpen = useUiStore((s) => s.agentPickerOpen);
  const setAgentPickerOpen = useUiStore((s) => s.setAgentPickerOpen);
  const projectId = useUiStore((s) => s.activeProjectId);
  const run = useRunsStore((s) => (thread ? s.runsByThread[thread.id] : undefined));
  const doctor = useDoctor();
  const settings = useSettings();
  const [agentId, setAgentId] = useState<AgentId>(thread?.agentId ?? settings.data?.defaultAgent ?? "claude");
  const [model, setModel] = useState<string>(thread?.model ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const agentSelectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (thread) {
      setAgentId(thread.agentId);
      setModel(thread.model ?? "");
    } else if (settings.data) {
      setAgentId(settings.data.defaultAgent);
      setModel(settings.data.agents[settings.data.defaultAgent]?.model ?? "");
    }
  }, [thread, settings.data]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [focusNonce, thread?.id]);

  useEffect(() => {
    if (agentPickerOpen) {
      agentSelectRef.current?.focus();
      setAgentPickerOpen(false);
    }
  }, [agentPickerOpen, setAgentPickerOpen]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(240, Math.max(44, el.scrollHeight))}px`;
  }, [draft]);

  const agents = doctor.data?.agents ?? [];
  const selectedAgent = agents.find((a) => a.id === agentId);
  const agentMissing = selectedAgent ? !selectedAgent.installed : false;

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending || run) return;
    setSending(true);
    setError(null);
    try {
      let threadId = thread?.id;
      if (!threadId) {
        threadId = await onCreateThread({ title: content.slice(0, 60), agentId, ...(model ? { model } : {}) });
      }
      await client.sendMessage(threadId, {
        content,
        attachments: pending.map((a) => ({ path: a.path, mime: a.mime })),
        agentId,
        ...(model ? { model } : {}),
      });
      setDraft(draftKey, "");
      clearAttachments(draftKey);
      if (draftKey === DRAFT_KEY_NEW) setDraft(threadId, "");
      void qc.invalidateQueries({ queryKey: ["messages", threadId] });
      void qc.invalidateQueries({ queryKey: ["threads"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [draft, sending, run, thread?.id, onCreateThread, agentId, model, client, pending, setDraft, draftKey, clearAttachments, qc]);

  useEffect(() => {
    composerHandlers.send = () => void send();
    composerHandlers.abort = thread ? () => void client.abort(thread.id) : null;
    return () => {
      composerHandlers.send = null;
      composerHandlers.abort = null;
    };
  }, [send, client, thread]);

  const pickFiles = async () => {
    const paths = await host.pickFile({
      multiple: true,
      filters: [{ name: "Images & documents", extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf", "md", "txt", "json"] }],
    });
    for (const p of paths) addAttachment(draftKey, { path: p, mime: mimeFromPath(p), label: basename(p) });
  };

  const mod = modKey(host.platform);
  const placeholder = thread
    ? "Message the agent..."
    : projectId
      ? "Describe the board you want..."
      : "Pick or create a project, then describe the board...";

  return (
    <div className="border-t border-border bg-bg px-4 pb-3 pt-2">
      <div className="mx-auto max-w-3xl">
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pending.map((a) => (
              <span
                key={a.path}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-panel px-2 py-0.5 text-xs"
              >
                <span className="text-muted">{a.mime.startsWith("image/") ? "img" : "file"}</span> {a.label}
                <button
                  className="text-muted hover:text-fg"
                  onClick={() => removeAttachment(draftKey, a.path)}
                  aria-label="Remove attachment"
                >
                  &#10005;
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="rounded-xl border border-border bg-panel shadow-sm focus-within:border-accent">
          <Textarea
            ref={textareaRef}
            value={draft}
            placeholder={placeholder}
            className="border-0 bg-transparent px-3.5 py-2.5 focus:border-0"
            rows={2}
            onChange={(e) => setDraft(draftKey, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex items-center gap-1.5 px-2 pb-2">
            <Select
              ref={agentSelectRef}
              value={agentId}
              onChange={(e) => {
                const id = e.target.value as AgentId;
                setAgentId(id);
                setModel(settings.data?.agents[id]?.model ?? "");
              }}
              className="h-7 text-xs"
              title={`Agent (${mod}/)`}
            >
              {(agents.length > 0 ? agents : FALLBACK_AGENTS).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                  {a.installed ? "" : " (not installed)"}
                </option>
              ))}
            </Select>
            <input
              list={`models-${agentId}`}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model (default)"
              className="h-7 w-40 rounded-md border border-border bg-panel px-2 text-xs outline-none focus:border-accent"
            />
            <datalist id={`models-${agentId}`}>
              {(selectedAgent?.models ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <IconButton title="Attach file" onClick={() => void pickFiles()}>
              +
            </IconButton>
            <Button
              variant="ghost"
              size="sm"
              title={`Sketch (${mod}Shift+S)`}
              onClick={() => setSketchOpen(true)}
              disabled={!projectId}
            >
              Sketch
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {run ? (
                <Button variant="danger" size="sm" onClick={() => void client.abort(run.threadId)} title={`Abort (${mod}.)`}>
                  &#9632; Stop
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void send()}
                  disabled={!draft.trim() || sending}
                  title={`Send (${mod}Enter)`}
                >
                  {sending ? "Sending..." : "Send"} <Kbd>&#8629;</Kbd>
                </Button>
              )}
            </div>
          </div>
        </div>
        {agentMissing && selectedAgent && (
          <div className="mt-1.5 text-xs text-warning">
            {selectedAgent.displayName} is not installed. {selectedAgent.installHint}
          </div>
        )}
        {error && <div className="mt-1.5 text-xs text-danger">{error}</div>}
      </div>
    </div>
  );
}
