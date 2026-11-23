import { useShallow } from "zustand/react/shallow";
import { captureAssistantContext, selectAssistantState } from "./assistant-context";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { modelDisplayName } from "./model-display-name";
import type { AgentId, ReasoningEffort, Thread } from "@fabdesk/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, IconButton, Textarea } from "../components/ui";
import { Icon } from "../components/Icon";
import { InstallHint } from "../components/InstallHint";
import { ErrorNotice } from "../components/ErrorNotice";
import { useCore, useSaveAgentPreference, useSaveAgentEffort } from "@fabdesk/client-core";
import { activeQuestion, CoreHttpError, formatVoiceShortcut, parseVoiceShortcut, useDoctor, useSettings, useSpeechStatus, useMessages, useQueueMessage, useUnqueueMessage, useFinishIt, useFinishItNeedsWork, useStartFinishIt, useStopFinishIt, useBoardSources, useProject } from "@fabdesk/client-core";
import { useRunsStore } from "@fabdesk/client-core";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { basename, mimeFromPath, modKey } from "../util";
import { AgentLogo } from "../components/AgentLogo";
import { reasoningEffortLabel } from "./EffortSection";
import { AgentModelMenu } from "./AgentModelMenu";
import { PermissionsMenu } from "./PermissionsMenu";
import { expandSlashCommand, isFinishItCommand, slashSuggestions } from "@fabdesk/client-core";
import { applyComposerTextareaHeight } from "./composer-autosize";
import { useVoiceInput } from "./voice/useVoiceInput";
import { MicButton, VoiceBar } from "./voice/VoiceBar";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { useI18n } from "../i18n";
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
  loadingThread?: boolean;
  /** Creates ownership before sending; navigation waits for the accepted message. */
  onCreateThread: (input: { agentId: AgentId; model?: string }) => Promise<Thread>;
}

const FALLBACK_AGENTS = [
  { id: "claude" as AgentId, displayName: "Claude", installed: true, installHint: "", models: [] as string[] },
];

const EMPTY: never[] = [];

export function Composer({ thread, loadingThread = false, onCreateThread, startMode = false }: ComposerProps) {
  const { t } = useI18n();
  const agentButtonRef = useRef<HTMLButtonElement>(null);
  const { client, host } = useCore();
  const qc = useQueryClient();
  const projectId = useUiStore((s) => s.activeProjectId);
  const draftKey = thread?.id ?? newChatDraftKey(projectId);
  const draft = useUiStore((s) => s.drafts[draftKey] ?? "");
  const setDraft = useUiStore((s) => s.setDraft);
  const savedContexts = useUiStore(s => s.draftBoardContexts?.[draftKey]);
  const matchingContexts = savedContexts?.filter(context => context.projectId === projectId);
  const boardContext = matchingContexts?.length ? { projectId: matchingContexts[0]!.projectId, label: matchingContexts.map(context => context.label).join(", "), instruction: matchingContexts.map(context => context.instruction).join("\n\n") } : undefined;
  const setDraftBoardContext = useUiStore(s => s.setDraftBoardContext);
  const boardSources = useBoardSources(projectId);
  const assistantState = useUiStore(useShallow(selectAssistantState));
  const workspaceContext = captureAssistantContext(assistantState, boardSources.data, boardSources.isFetching || boardSources.isError, matchingContexts);
  const project = useProject(projectId);
  const ideaDraft = !!project.data?.manifest.ideaDraft;
  const rootAutomation = !ideaDraft && boardSources.data?.mode === "single";
  const pending = useUiStore((s) => s.attachments[draftKey] ?? EMPTY);
  const addAttachment = useUiStore((s) => s.addAttachment);
  const removeAttachment = useUiStore((s) => s.removeAttachment);
  const clearAttachments = useUiStore((s) => s.clearAttachments);
  const setSketchOpen = useUiStore((s) => s.setSketchOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const focusNonce = useUiStore((s) => s.composerFocusNonce);
  const agentPickerOpen = useUiStore((s) => s.agentPickerOpen);
  const setAgentPickerOpen = useUiStore((s) => s.setAgentPickerOpen);
  const setProjectPickerOpen = useUiStore((s) => s.setProjectPickerOpen);
  const run = useRunsStore((s) => (thread ? s.runsByThread[thread.id] : undefined));
  const messages = useMessages(thread?.id ?? null);
  const queued = (messages.data ?? []).filter((message) => message.status === "queued");
  const queueMessage = useQueueMessage();
  const unqueueMessage = useUnqueueMessage();
  const doctor = useDoctor();
  const settings = useSettings();
  const savePreference = useSaveAgentPreference();
  const saveEffort = useSaveAgentEffort();
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
  const [model, setModel] = useState<string>(thread ? thread.model ?? "" : settings.data?.agents[settings.data.defaultAgent]?.model ?? "");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selectionNotice, setSelectionNotice] = useState<{ agentId: AgentId; model: string; error: unknown; savedForChat: boolean } | null>(null);
  const explicitChoice = useRef(false);
  const selectionOwner = thread?.id ?? projectId ?? "home";
  const currentSelectionOwner = useRef(selectionOwner);
  currentSelectionOwner.current = selectionOwner;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preparedThread = useRef<Thread | null>(null);

  const questionId = activeQuestion(messages.data ?? [], run?.runId)?.requestId;
  const questionKey = questionId ? `${thread?.id}:${run?.runId}:${questionId}` : undefined;
  const [expandedQuestion, setExpandedQuestion] = useState<{ id: string; focusNonce: number } | null>(null);
  const compactQuestion = !!questionId && !draft.trim() && !pending.length && voice.state.phase === "idle" && !sending && !error
    && !(expandedQuestion?.id === questionKey && expandedQuestion?.focusNonce === focusNonce);
  const revealComposer = () => {
    if (questionKey) setExpandedQuestion({ id: questionKey, focusNonce });
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const previousFocusNonce = useRef(focusNonce);
  useEffect(() => {
    if (previousFocusNonce.current === focusNonce) return;
    previousFocusNonce.current = focusNonce;
    if (questionKey) setExpandedQuestion({ id: questionKey, focusNonce });
  }, [focusNonce, questionKey]);
  const savingEffort = useRef(false);

  useEffect(() => { explicitChoice.current = false; setSelectionNotice(null); }, [thread?.id, projectId]);

  useEffect(() => {
    if (thread) {
      setAgentId(thread.agentId);
      setModel(thread.model ?? "");
    }
    // Refetching the same thread or saving defaults must not undo an explicit picker choice.
  }, [thread?.id, thread?.agentId, thread?.model]);

  const defaultAgent = settings.data?.defaultAgent;
  const defaultModel = defaultAgent ? settings.data?.agents[defaultAgent]?.model ?? "" : "";
  useEffect(() => {
    if (!thread && defaultAgent && !savePreference.isPending && !explicitChoice.current) {
      setAgentId(defaultAgent);
      setModel(defaultModel);
    }
  }, [thread?.id, defaultAgent, defaultModel, savePreference.isPending]);

  const selectAgent = useCallback((id: AgentId, selectedModel: string) => {
    if (!settings.data || loadingThread || savePreference.isPending || savingEffort.current || run || queued.length > 0) return;
    setError(null);
    setSelectionNotice(null);
    savePreference.mutate({ agentId: id, model: selectedModel || null, ...(thread ? { threadId: thread.id } : {}) }, {
      onSuccess: result => {
        if (currentSelectionOwner.current !== selectionOwner) return;
        explicitChoice.current = true;
        setAgentId(id);
        setModel(selectedModel);
        if (result.preferenceError) setSelectionNotice({ agentId: id, model: selectedModel, error: result.preferenceError, savedForChat: true });
      },
      onError: failure => { if (currentSelectionOwner.current === selectionOwner) setSelectionNotice({ agentId: id, model: selectedModel, error: failure, savedForChat: false }); },
    });
  }, [settings.data, loadingThread, savePreference.isPending, savePreference.mutate, thread?.id, selectionOwner, run, queued.length]);

  useEffect(() => {
    if (!compactQuestion) textareaRef.current?.focus();
  }, [focusNonce, thread?.id, compactQuestion]);

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
  }, [draft, compactQuestion]);

  const agents = doctor.data?.agents ?? [];
  const pickerAgents = agents.length > 0 ? agents : FALLBACK_AGENTS;
  const selectedAgent = agents.find((a) => a.id === agentId);
  const agentMissing = selectedAgent ? !selectedAgent.installed : false;
  const displayedModel = model || settings.data?.agents[agentId]?.model || selectedAgent?.defaultModel || "";
  const modelLabel = displayedModel ? modelDisplayName(displayedModel, selectedAgent?.modelAliases) : "Choose model";
  const effortLevels = selectedAgent?.modelEfforts?.[displayedModel] ?? EMPTY;
  const savedEffort = settings.data?.agents[agentId]?.effort;
  const effort = savedEffort && effortLevels.includes(savedEffort) ? savedEffort : null;
  const modelEffortLabel = effortLevels.length ? `${modelLabel} ${reasoningEffortLabel(effort)}` : modelLabel;
  const pickerLabel = `${pickerAgents.find((agent) => agent.id === agentId)?.displayName ?? agentId}: ${modelEffortLabel}`;
  const changeEffort = async (next: ReasoningEffort | null) => {
    if (!settings.data || loadingThread || savePreference.isPending || run || queued.length > 0 || savingEffort.current) return false;
    savingEffort.current = true;
    setError(null);
    try {
      await saveEffort.mutateAsync({ agentId, effort: next });
      return true;
    } catch (failure) { setError(failure); return false; }
    finally { savingEffort.current = false; }
  };

  const finishItSession = finishIt.data ?? null;
  const finishedNeedsWork = useFinishItNeedsWork(projectId, finishItSession?.status === "completed");
  const alreadyFinished = finishItSession?.status === "completed" && finishedNeedsWork.data !== true;
  const finishItBusy = finishItActive(finishItSession) || startFinishIt.isPending || stopFinishIt.isPending || saveEffort.isPending;

  const beginFinishIt = useCallback(async () => {
    if (!projectId || finishItBusy || alreadyFinished || loadingThread || !settings.data || savePreference.isPending || savingEffort.current) return;
    if (!rootAutomation) { setError("Finish it currently supports single-board projects. Ask about the selected board instead."); return; }
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
  }, [projectId, rootAutomation, finishItBusy, alreadyFinished, loadingThread, settings.data, savePreference.isPending, startFinishIt, thread?.id, agentId, model, setActiveThread, qc]);

  const send = useCallback(async () => {
    const typed = draft.trim();
    if (!typed || sending || saveEffort.isPending || loadingThread || !settings.data || savePreference.isPending || savingEffort.current) return;
    if (!thread && !projectId && !startMode) {
      setProjectPickerOpen(true);
      return;
    }
    if (isFinishItCommand(typed)) {
      if (rootAutomation) setDraft(draftKey, "");
      await beginFinishIt();
      return;
    }
    // `/shopping-list …` and friends expand into the instructions the agent needs.
    const expanded = expandSlashCommand(typed) ?? typed;
    const content = expanded;
    const workspaceContext = captureAssistantContext(selectAssistantState(useUiStore.getState()), boardSources.data, boardSources.isFetching || boardSources.isError, matchingContexts);
    setSending(true);
    setError(null);
    try {
      let threadId = thread?.id;
      let created = preparedThread.current;
      if (!threadId) {
        // No title: the daemon names the thread after this first message (and tells every client).
        created ??= await onCreateThread({ agentId, ...(model ? { model } : {}) });
        preparedThread.current = created;
        threadId = created.id;
      }
      const input = {
        content,
        workspaceContext: created && !thread ? { ...workspaceContext, projectId: created.projectId } : workspaceContext,
        attachments: pending.map((a) => ({ path: a.path, mime: a.mime })),
        agentId,
        ...(model ? { model } : {}),
      };
      // The queue endpoint starts immediately when idle and queues if a run began meanwhile.
      await queueMessage.mutateAsync({ threadId, input });
      voice.reset();
      setDraft(draftKey, "");
      clearAttachments(draftKey);
      setDraftBoardContext(draftKey, null);
      if (!thread) setDraft(threadId, "");
      void qc.invalidateQueries({ queryKey: ["messages", threadId] });
      void qc.invalidateQueries({ queryKey: ["threads"] });
      if (created && !thread) {
        const ui = useUiStore.getState();
        if (ui.activeProjectId === projectId && ui.activeThreadId === null && ui.setActiveProject(created.projectId)) ui.setActiveThread(created.id);
        preparedThread.current = null;
      }
    } catch (e) {
      // Retain this prepared thread and the visible draft for a normal retry.
      setError(e);
    } finally {
      setSending(false);
    }
  }, [draft, rootAutomation, matchingContexts, boardSources.data, boardSources.isFetching, boardSources.isError, setDraftBoardContext, sending, saveEffort.isPending, loadingThread, settings.data, savePreference.isPending, startMode, projectId, setProjectPickerOpen, thread, onCreateThread, agentId, model, pending, setDraft, draftKey, clearAttachments, addAttachment, qc, queueMessage, voice.reset, beginFinishIt]);

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
      if (savingEffort.current) return false;
      const offered = doctor.data?.agents ?? FALLBACK_AGENTS;
      const agent = offered.find((a) => a.id === id);
      if (!agent || !settings.data || loadingThread || savePreference.isPending || run || queued.length > 0) return false;
      selectAgent(agent.id, m ?? settings.data.agents[agent.id]?.model ?? "");
      return true;
    };
    return () => {
      composerHandlers.send = null;
      composerHandlers.abort = null;
      composerHandlers.finishIt = null;
      composerHandlers.setAgent = null;
      composerHandlers.voiceToggle = null;
    };
  }, [send, stop, run, doctor.data, settings.data, loadingThread, voice.toggle, beginFinishIt, selectAgent, savePreference.isPending, queued.length]);

  const showStop = !!run && !draft.trim() && !sending;

  const pickFiles = async () => {
    const paths = await host.pickFile({
      multiple: true,
      filters: [{ name: "Images & documents", extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf", "md", "txt", "json"] }],
    });
    for (const p of paths) addAttachment(draftKey, { path: p, mime: mimeFromPath(p), label: basename(p) });
  };

  const suggestions = slashSuggestions(draft).filter(command => rootAutomation || !isFinishItCommand(`/${command.name}`));
  const mod = modKey(host.platform);
  const placeholder = ideaDraft
    ? "Ask or describe the next step…" : thread
    ? t("chat.placeholder")
    : startMode ? "Describe your idea or ask a question…" : projectId
      ? "Ask about this project or describe a change…"
      : "Describe your idea or start with a sketch...";

  const finishAction = <Button variant="secondary" size="sm" aria-label="Finish it"
                title={alreadyFinished ? "Board already finished. Make changes to enable Finish it again." : "Finish schematic, place, route and verify without step-by-step prompts"}
                onClick={() => void beginFinishIt()} disabled={finishItBusy || alreadyFinished || agentMissing || loadingThread || !settings.data || savePreference.isPending} data-testid="finish-it">
                <Icon name="play" width={14} height={14} />
                <span className="fd-action-label">Finish it</span>
              </Button>;

  if (compactQuestion) return <div className="fd-composer-dock bg-bg px-5 pb-3 pt-2">
    <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-panel px-3 py-2 text-xs">
      <span className="text-muted">Answer the question above{queued.length ? ` · ${queued.length} queued` : ""}</span>
      <Button size="sm" variant="ghost" onClick={revealComposer}><Icon name="compose" width={14} height={14} />Write a message instead</Button>
    </div>
  </div>;

  return (
    <div className="fd-composer-dock bg-bg px-5 pb-4 pt-3">
      <div className="mx-auto max-w-3xl">
        {!thread && !loadingThread && !projectId && !startMode && (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-border bg-panel px-3 py-2 text-xs">
            <span>Choose or create a project before sending. Your draft will be kept.</span>
            <Button size="sm" onClick={() => setProjectPickerOpen(true)}>Choose project</Button>
          </div>
        )}
        {queued.length > 0 && <div className="mb-2 max-h-36 space-y-1 overflow-y-auto rounded-xl border border-border bg-panel p-2" aria-label="Queued messages">
          <div className="px-1 text-[11px] text-muted">Queued · sends in order after the current run</div>
          {queued.map((message, index) => <div key={message.id} className="flex items-center gap-2 rounded-lg bg-panel-2 px-2 py-1.5 text-xs">
            <span className="shrink-0 text-muted">{index + 1}.</span><span className="min-w-0 flex-1 truncate" title={message.contentMd}>{message.contentMd}</span>
            <button type="button" className="shrink-0 cursor-pointer text-fg hover:bg-panel-2" disabled={unqueueMessage.isPending} aria-label={`Cancel queued message ${index + 1}`} onClick={() => void unqueueMessage.mutateAsync({ threadId: thread!.id, messageId: message.id }).catch((failure: unknown) => {
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
                  className="text-fg hover:bg-panel-2/70"
                  onClick={() => removeAttachment(draftKey, a.path)}
                  aria-label="Remove attachment"
                >
                  &#10005;
                </button>
              </span>
            ))}
          </div>
        )}
        {finishItSession && (rootAutomation || finishItActive(finishItSession)) && (
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
        <div className="fd-composer-workspace-context" title="The agent receives the current page and selection with your message"><Icon name="sparkles" width={13} height={13} /><span>{workspaceContext.label}</span></div>
        {boardContext && <div className="fd-composer-board-context">
          <details><DisclosureSummary icon="pcb" label={`Attached context · ${boardContext.label}`} variant="compact" /><p>This source context accompanies your next message.</p><p className="break-words">{boardContext.instruction}</p></details>
          <button type="button" aria-label="Remove attached context" onClick={() => setDraftBoardContext(draftKey, null)}>×</button>
        </div>}
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
            {thread && !ideaDraft && <PermissionsMenu key={thread.id} thread={thread} />}
            {projectId && rootAutomation && (startMode ? <WorkspaceMenu className="fd-composer-more" label={<span aria-label="Assistant tools"><Icon name="more" width={18} height={18} /></span>}>
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
                  disabled={!!run || queued.length > 0 || saveEffort.isPending || loadingThread || !settings.data || savePreference.isPending}
                  aria-haspopup="menu"
                  aria-expanded={agentPickerOpen}
                  data-testid="agent-model"
                >
                  <AgentLogo agentId={agentId} />
                  <span className="min-w-0 truncate">{savePreference.isPending ? "Switching…" : modelEffortLabel}</span> <Icon name="chevronDown" width={13} height={13} className="shrink-0" />
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
                  onSelect={selectAgent}
                  onOpenSettings={() => setSettingsOpen(true, "agents")}
                  effort={{ levels: effortLevels, value: effort, agentName: selectedAgent?.displayName ?? agentId,
                    disabled: !!run || queued.length > 0 || loadingThread || !settings.data || savePreference.isPending, saving: saveEffort.isPending, onChange: changeEffort }}
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
                disabled={showStop ? stopping : !draft.trim() || sending || saveEffort.isPending || loadingThread || !settings.data || savePreference.isPending || (!thread && !projectId && !startMode)}
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
        {error != null && <ErrorNotice error={error} agentId={agentId} onDismiss={() => setError(null)} />}
        {selectionNotice && <ErrorNotice error={selectionNotice.error} agentId={selectionNotice.agentId}
          title={selectionNotice.savedForChat ? `Using ${pickerAgents.find(agent => agent.id === selectionNotice.agentId)?.displayName ?? selectionNotice.agentId} · default not saved` : "Could not switch agent"}
          description={selectionNotice.savedForChat ? "You can continue in this chat. Retry saving your default, or restart fabPlane if it was recently updated." : "Your previous agent is still selected. Retry the switch when the connection is ready."}
          tone={selectionNotice.savedForChat ? "warning" : "error"}
          {...(!run && queued.length === 0 && !sending && !savePreference.isPending ? { onRetry: () => selectAgent(selectionNotice.agentId, selectionNotice.model) } : {})}
          onDismiss={() => setSelectionNotice(null)}
          {...(!run && queued.length === 0 && !sending && !savePreference.isPending && selectionNotice.savedForChat && selectionNotice.error instanceof CoreHttpError && selectionNotice.error.status === 404 && host.restartCore ? { onRestart: () => { setSelectionNotice(null); void host.restartCore!().catch(failure => setError(failure)); } } : {})} />}
      </div>
    </div>
  );
}
