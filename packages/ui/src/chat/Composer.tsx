import { modelDisplayName } from "./model-display-name";
import type { AgentId, Thread } from "@fabdesk/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, IconButton, Textarea } from "../components/ui";
import { Icon } from "../components/Icon";
import { InstallHint } from "../components/InstallHint";
import { ErrorNotice } from "../components/ErrorNotice";
import { useCore } from "@fabdesk/client-core";
import { CoreHttpError, formatVoiceShortcut, parseVoiceShortcut, useDoctor, useSettings, useSpeechStatus, useMessages, useQueueMessage, useUnqueueMessage, useFinishIt, useFinishItNeedsWork, useStartFinishIt, useStopFinishIt } from "@fabdesk/client-core";
import { useRunsStore } from "@fabdesk/client-core";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { basename, mimeFromPath, modKey } from "../util";
import { AgentLogo } from "../components/AgentLogo";
import { AgentModelMenu } from "./AgentModelMenu";
import { PermissionsMenu } from "./PermissionsMenu";
import { expandSlashCommand, isFinishItCommand, slashSuggestions } from "@fabdesk/client-core";
import { applyComposerTextareaHeight } from "./composer-autosize";
import { useVoiceInput } from "./voice/useVoiceInput";
import { MicButton, VoiceBar } from "./voice/VoiceBar";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { FinishItPanel } from "./FinishItPanel";
import { finishItActive } from "./finish-it-view";

/** Bridge for the global shortcut hook (mod+Enter send, mod+. abort) and for app automation. */
export const composerHandlers: {
  send: (() => void) | null;
  abort: (() => void) | null;
  finishIt: (() => void) | null;
  /**
   * Picks agent (and optionally model) exactly as the dropdown does, for callers with no DOM to
   * click. Returns false when the agent is not one the composer offers.
   */
  setAgent: ((agentId: string, model?: string | null) => boolean) | null;
  voiceToggle: (() => void) | null;
} = {
  send: null,
  abort: null,
  finishIt: null,
  setAgent: null,
  voiceToggle: null,
};

export interface ComposerProps {
  /** First-start actions already expose sketch creation; advanced automation stays requested. */
  startMode?: boolean;
  thread: Thread | null;
  /** Creates a thread for a first message; returns the new thread id. */
  onCreateThread: (input: { agentId: AgentId; model?: string }) => Promise<string>;
}

const FALLBACK_AGENTS = [
  { id: "claude" as AgentId, displayName: "Claude", installed: true, installHint: "", models: [] as string[] },
];

const EMPTY: never[] = [];

export function Composer({ thread, onCreateThread, startMode = false }: ComposerProps) {
  const agentButtonRef = useRef<HTMLButtonElement>(null);
  const { client, host } = useCore();
  const qc = useQueryClient();
  const projectId = useUiStore((s) => s.activeProjectId);
  const draftKey = thread?.id ?? newChatDraftKey(projectId);
  const draft = useUiStore((s) => s.drafts[draftKey] ?? "");
  const setDraft = useUiStore((s) => s.setDraft);
  const pending = useUiStore((s) => s.attachments[draftKey] ?? EMPTY);
  const addAttachment = useUiStore((s) => s.addAttachment);
  const removeAttachment = useUiStore((s) => s.removeAttachment);
  const clearAttachments = useUiStore((s) => s.clearAttachments);
  const setSketchOpen = useUiStore((s) => s.setSketchOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const focusNonce = useUiStore((s) => s.composerFocusNonce);
  const agentPickerOpen = useUiStore((s) => s.agentPickerOpen);
  const setAgentPickerOpen = useUiStore((s) => s.setAgentPickerOpen);
  const run = useRunsStore((s) => (thread ? s.runsByThread[thread.id] : undefined));
  const messages = useMessages(thread?.id ?? null);
  const queued = (messages.data ?? []).filter((message) => message.status === "queued");
  const queueMessage = useQueueMessage();
  const unqueueMessage = useUnqueueMessage();
  const doctor = useDoctor();
  const settings = useSettings();
  const speech = useSpeechStatus();
  const voice = useVoiceInput({
    client,
    voice: settings.data?.voice,
    status: speech.data,
    onTranscript: (text) => {
      const current = useUiStore.getState().drafts[draftKey] ?? "";
      const next = current.trim() ? `${current.trim()} ${text}` : text;
      setDraft(draftKey, next);
    },
  });
  const finishIt = useFinishIt(projectId);
  const startFinishIt = useStartFinishIt();
  const stopFinishIt = useStopFinishIt();
  const setActiveThread = useUiStore((s) => s.setActiveThread);
  const [agentId, setAgentId] = useState<AgentId>(thread?.agentId ?? settings.data?.defaultAgent ?? "claude");
  const [model, setModel] = useState<string>(thread?.model ?? "");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    applyComposerTextareaHeight(el, draft);
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      applyComposerTextareaHeight(el, draft);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draft]);

  const agents = doctor.data?.agents ?? [];
  const pickerAgents = agents.length > 0 ? agents : FALLBACK_AGENTS;
  const selectedAgent = agents.find((a) => a.id === agentId);
  const agentMissing = selectedAgent ? !selectedAgent.installed : false;
  const displayedModel = model || settings.data?.agents[agentId]?.model || selectedAgent?.defaultModel || "";
  const modelLabel = displayedModel ? modelDisplayName(displayedModel, selectedAgent?.modelAliases) : "Choose model";
  const pickerLabel = `${pickerAgents.find((agent) => agent.id === agentId)?.displayName ?? agentId}: ${modelLabel}`;

  const finishItSession = finishIt.data ?? null;
  const finishedNeedsWork = useFinishItNeedsWork(projectId, finishItSession?.status === "completed");
  const alreadyFinished = finishItSession?.status === "completed" && finishedNeedsWork.data !== true;
  const finishItBusy = finishItActive(finishItSession) || startFinishIt.isPending || stopFinishIt.isPending;

  const beginFinishIt = useCallback(async () => {
    if (!projectId || finishItBusy || alreadyFinished) return;
    setError(null);
    try {
      const result = await startFinishIt.mutateAsync({
        projectId,
        ...(thread?.id ? { threadId: thread.id } : {}),
        agentId,
        ...(model ? { model } : {}),
      });
      setActiveThread(result.session.threadId);
      void qc.invalidateQueries({ queryKey: ["messages", result.session.threadId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, finishItBusy, alreadyFinished, startFinishIt, thread?.id, agentId, model, setActiveThread, qc]);

  const send = useCallback(async () => {
    const typed = draft.trim();
    if (!typed || sending) return;
    if (isFinishItCommand(typed)) {
      setDraft(draftKey, "");
      await beginFinishIt();
      return;
    }
    // `/shopping-list …` and friends expand into the instructions the agent needs.
    const content = expandSlashCommand(typed) ?? typed;
    setSending(true);
    setError(null);
    let createdThreadId: string | null = null;
    try {
      let threadId = thread?.id;
      if (!threadId) {
        // No title: the daemon names the thread after this first message (and tells every client).
        threadId = await onCreateThread({ agentId, ...(model ? { model } : {}) });
        createdThreadId = threadId;
      }
      const input = {
        content,
        attachments: pending.map((a) => ({ path: a.path, mime: a.mime })),
        agentId,
        ...(model ? { model } : {}),
      };
      // The queue endpoint starts immediately when idle and queues if a run began meanwhile.
      await queueMessage.mutateAsync({ threadId, input });
      voice.reset();
      setDraft(draftKey, "");
      clearAttachments(draftKey);
      if (!thread) setDraft(threadId, "");
      void qc.invalidateQueries({ queryKey: ["messages", threadId] });
      void qc.invalidateQueries({ queryKey: ["threads"] });
    } catch (e) {
      if (createdThreadId) {
        setDraft(createdThreadId, draft);
        for (const attachment of pending) addAttachment(createdThreadId, attachment);
        setDraft(draftKey, "");
        clearAttachments(draftKey);
      }
      setError(e);
    } finally {
      setSending(false);
    }
  }, [draft, sending, thread, onCreateThread, agentId, model, pending, setDraft, draftKey, clearAttachments, addAttachment, qc, queueMessage, voice.reset, beginFinishIt]);

  const stop = useCallback(async () => {
    if (!run || stopping) return;
    setStopping(true);
    setError(null);
    try { await client.abort(run.threadId); }
    catch { setError("Could not stop the run. Check the connection and try again."); }
    finally { setStopping(false); }
  }, [run, stopping, client]);

  useEffect(() => {
    composerHandlers.send = () => void send();
    composerHandlers.abort = run ? () => void stop() : null;
    composerHandlers.voiceToggle = () => voice.toggle();
    composerHandlers.finishIt = () => void beginFinishIt();
    composerHandlers.setAgent = (id, m) => {
      const offered = doctor.data?.agents ?? FALLBACK_AGENTS;
      const agent = offered.find((a) => a.id === id);
      if (!agent) return false;
      setAgentId(agent.id);
      setModel(m ?? settings.data?.agents[agent.id]?.model ?? "");
      return true;
    };
    return () => {
      composerHandlers.send = null;
      composerHandlers.abort = null;
      composerHandlers.finishIt = null;
      composerHandlers.setAgent = null;
      composerHandlers.voiceToggle = null;
    };
  }, [send, stop, run, doctor.data, settings.data, voice.toggle, beginFinishIt]);

  const showStop = !!run && !draft.trim() && !sending;

  const pickFiles = async () => {
    const paths = await host.pickFile({
      multiple: true,
      filters: [{ name: "Images & documents", extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf", "md", "txt", "json"] }],
    });
    for (const p of paths) addAttachment(draftKey, { path: p, mime: mimeFromPath(p), label: basename(p) });
  };

  const suggestions = slashSuggestions(draft);
  const mod = modKey(host.platform);
  const placeholder = thread
    ? "Message the agent..."
    : startMode ? "Describe your project…" : projectId
      ? "Ask about this project or describe a change…"
      : "Describe your idea or start with a sketch...";

  const finishAction = <Button variant="secondary" size="sm" aria-label="Finish it"
                title={alreadyFinished ? "Board already finished. Make changes to enable Finish it again." : "Finish schematic, place, route and verify without step-by-step prompts"}
                onClick={() => void beginFinishIt()} disabled={finishItBusy || alreadyFinished || agentMissing} data-testid="finish-it">
                <Icon name="play" width={14} height={14} />
                <span className="fd-action-label">Finish it</span>
              </Button>;

  return (
    <div className="fd-composer-dock bg-bg px-5 pb-4 pt-3">
      <div className="mx-auto max-w-3xl">
        {queued.length > 0 && <div className="mb-2 max-h-36 space-y-1 overflow-y-auto rounded-xl border border-border bg-panel p-2" aria-label="Queued messages">
          <div className="px-1 text-[11px] text-muted">Queued · sends in order after the current run</div>
          {queued.map((message, index) => <div key={message.id} className="flex items-center gap-2 rounded-lg bg-panel-2 px-2 py-1.5 text-xs">
            <span className="shrink-0 text-muted">{index + 1}.</span><span className="min-w-0 flex-1 truncate" title={message.contentMd}>{message.contentMd}</span>
            <button type="button" className="shrink-0 text-muted hover:text-fg" disabled={unqueueMessage.isPending} aria-label={`Cancel queued message ${index + 1}`} onClick={() => void unqueueMessage.mutateAsync({ threadId: thread!.id, messageId: message.id }).catch((failure: unknown) => {
              void messages.refetch();
              setError(failure instanceof CoreHttpError && failure.status === 409
                ? "This message has already started and cannot be canceled."
                : "Could not cancel this queued message. Check the connection and try again.");
            })}>Cancel</button>
          </div>)}
          <div className="px-1 text-[11px] text-muted">Queued messages use this chat’s agent and model when they start.</div>
        </div>}
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pending.map((a) => (
              <span
                key={a.path}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 py-1 text-xs"
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
        {finishItSession && (
          <FinishItPanel
            session={finishItSession}
            stopping={stopFinishIt.isPending || finishItSession.status === "stopping"}
            onStop={() => {
              if (!projectId) return;
              void stopFinishIt.mutateAsync(projectId).catch((failure: unknown) => {
                setError(failure instanceof Error ? failure.message : String(failure));
              });
            }}
          />
        )}
        {suggestions.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5" data-testid="slash-suggestions">
            {suggestions.map((c) => (
              <button
                key={c.name}
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-0.5 text-xs hover:bg-panel-2"
                onClick={() => {
                  setDraft(draftKey, `/${c.name} `);
                  textareaRef.current?.focus();
                }}
                title={c.hint}
              >
                <span className="font-mono">{c.usage}</span>
                <span className="text-muted">{c.hint}</span>
              </button>
            ))}
          </div>
        )}
        <div className="fd-composer rounded-xl border border-border bg-panel transition-colors focus-within:border-accent">
          <VoiceBar
            state={voice.state}
            shortcut={settings.data?.voice.pushToTalkShortcut ?? "Alt+Space"}
            platform={host.platform}
            onCancel={voice.cancel}
            onOpenSettings={() => setSettingsOpen(true, "voice")}
          />
          <Textarea
            ref={textareaRef}
            value={draft}
            placeholder={placeholder}
            className="h-[52px] max-h-[240px] min-h-[52px] overflow-y-auto border-0 bg-transparent px-4 py-3 text-sm leading-6 focus:border-0"
            rows={1}
            onChange={(e) => setDraft(draftKey, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && voice.state.phase !== "idle") {
                e.preventDefault();
                voice.cancel();
                return;
              }
              if (voice.state.phase === "recording" || voice.state.phase === "transcribing") return;
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="fd-composer-toolbar flex flex-wrap items-center gap-1.5 px-2.5 py-2">
            <IconButton title="Attach file" onClick={() => void pickFiles()}>
              <Icon name="paperclip" />
            </IconButton>
            {!startMode && <Button
              variant="ghost"
              size="sm"
              className="fd-sketch-button"
              aria-label="Sketch"
              title={`Sketch (${mod} + Shift + S)`}
              onClick={() => setSketchOpen(true)}
            >
              <Icon name="compose" width={16} height={16} /><span className="fd-action-label">Sketch</span>
            </Button>}
            <MicButton
              active={voice.state.phase === "recording"}
              disabled={sending}
              mode={settings.data?.voice.pushToTalkMode ?? "hold"}
              title={`Speak (${formatVoiceShortcut(parseVoiceShortcut(settings.data?.voice.pushToTalkShortcut), host.platform)})`}
              onHoldStart={() => void voice.holdStart()}
              onHoldEnd={voice.holdEnd}
              onToggle={voice.toggle}
            />
            {thread && <PermissionsMenu key={thread.id} thread={thread} />}
            {projectId && (startMode ? <WorkspaceMenu className="fd-composer-more" label={<span aria-label="Assistant tools"><Icon name="more" width={18} height={18} /></span>}>
              <div className="fd-menu-caption">Automation</div>
              {finishAction}
              <p className="fd-menu-caption">Finish schematic, placement, routing and checks with the agent.</p>
            </WorkspaceMenu> : finishAction)}

            <div className="fd-composer-send-group ml-auto flex min-w-0 items-center gap-2">
              <div className="fd-agent-control relative min-w-0">
                <Button
                  ref={agentButtonRef}
                  variant="ghost"
                  size="sm"
                  className="fd-agent-button h-8 max-w-full font-medium"
                  title={`${pickerLabel} (${mod} + /)`}
                  aria-label={`Agent and model: ${pickerLabel}`}
                  onClick={() => setAgentPickerOpen(!agentPickerOpen)}
                  disabled={!!run || queued.length > 0}
                  aria-haspopup="menu"
                  aria-expanded={agentPickerOpen}
                  data-testid="agent-model"
                >
                  <AgentLogo agentId={agentId} />
                  <span className="min-w-0 truncate">{modelLabel}</span> <Icon name="chevronDown" width={13} height={13} className="shrink-0" />
                </Button>
                <AgentModelMenu
                  anchorRef={agentButtonRef}
                  open={agentPickerOpen}
                  onClose={() => setAgentPickerOpen(false)}
                  agents={pickerAgents}
                  agentId={agentId}
                  model={model}
                  defaultModel={(id) => settings.data?.agents[id]?.model ?? ""}
                  configuredModels={(id) => settings.data?.agents[id]?.pickerModels ?? []}
                  onSelect={(id, m) => {
                    setAgentId(id);
                    setModel(m);
                  }}
                  onOpenSettings={() => setSettingsOpen(true, "agents")}
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                className="fd-composer-primary"
                style={{ width: 36, height: 36, padding: 0, borderRadius: "50%", flexShrink: 0 }}
                aria-label={showStop ? "Stop current run; queued messages stay scheduled" : sending ? "Sending message" : run ? "Queue message" : "Send message"}
                aria-busy={showStop ? stopping : sending}
                onClick={() => void (showStop ? stop() : send())}
                disabled={showStop ? stopping : !draft.trim() || sending}
                title={showStop ? "Stop current run. Queued messages stay scheduled." : run ? "Queue message (Enter). Stop current run with " + mod + " + ." : "Send message (Enter)"}
              >
                <Icon name={showStop ? "stop" : run ? "queue" : "arrowUp"} width={18} height={18} {...(showStop ? { fill: "currentColor" } : {})} />
              </Button>
            </div>
          </div>
        </div>
        {agentMissing && selectedAgent && (
          <details className="fd-setup-notice mt-2 rounded-lg border border-warning/25 bg-warning/5 text-xs leading-5 text-warning">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
              <span className="min-w-0 flex-1 truncate">{selectedAgent.displayName} is not installed</span>
              <span className="shrink-0 font-medium">Setup instructions</span>
              <Icon name="chevronDown" width={14} height={14} className="fd-setup-chevron shrink-0 transition-transform" />
            </summary>
            <div className="border-t border-warning/20 px-3 py-2"><InstallHint text={selectedAgent.installHint} /></div>
          </details>
        )}
        {error != null && <ErrorNotice error={error} agentId={agentId} />}
      </div>
    </div>
  );
}
