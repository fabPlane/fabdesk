import { FeedbackNotice } from "../components/FeedbackNotice";
import { speechErrorMessage } from "../chat/voice/speech-error";
import { useNativeSpeech } from "../chat/voice/useNativeSpeech";
import { availableSpeechBackend } from "../chat/voice/availability";
import { webSpeechAvailable } from "../chat/voice/web-speech";
import type { Settings } from "@fabdesk/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import { Button, Input, Select } from "../components/ui";
import { useCore, useSpeechStatus } from "@fabdesk/client-core";
import { formatVoiceShortcut, parseVoiceShortcut } from "@fabdesk/client-core";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="fd-settings-row grid grid-cols-[180px_minmax(0,1fr)] items-center gap-4 py-2 text-[13px]">
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-4 text-muted">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function VoiceSection({
  draft,
  update,
}: {
  draft: Settings;
  update: (fn: (s: Settings) => Settings) => void;
}) {
  const { client, host } = useCore();
  const speech = useSpeechStatus();
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(speech.data?.cloudBaseUrl ?? "");
  const [busy, setBusy] = useState<"cloud" | "clear" | "local" | "native" | null>(null);
  const [note, setNote] = useState<{ tone: "info" | "success" | "error"; message: string } | null>(null);
  const nativeSetupId = useRef<string | null>(null);
  const status = speech.data;
  const native = useNativeSpeech(draft.voice.language);
  const builtInAvailable = webSpeechAvailable() || native.available;
  const activeBackend = availableSpeechBackend(draft.voice.provider, status, builtInAvailable);
  const backendLabels = { on_device: native.available ? "macOS on-device speech" : "Built-in speech", cloud: "Cloud speech", local: "Local model" };

  useEffect(() => () => {
    if (nativeSetupId.current) void native.service?.cancel(nativeSetupId.current).catch(() => {});
  }, [native.service]);

  const prepareNative = async () => {
    if (!native.service) return;
    const id = crypto.randomUUID();
    nativeSetupId.current = id;
    setBusy("native"); setNote(null);
    try {
      const result = await native.service.prepare(draft.voice.language, id);
      setNote({ tone: "info", message: result.message });
      await qc.invalidateQueries({ queryKey: ["native-speech"] });
    } catch (error) { setNote({ tone: "error", message: speechErrorMessage(error) }); }
    finally { nativeSetupId.current = null; setBusy(null); }
  };

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["speech"] });
  };

  const saveCloud = async () => {
    if (!apiKey.trim()) return;
    setBusy("cloud");
    setNote(null);
    try {
      await client.setSpeechCloud({
        apiKey: apiKey.trim(),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      setApiKey("");
      setNote({ tone: "success", message: "Cloud key saved on this computer. It is never sent to the app window." });
      await refresh();
    } catch (e) {
      setNote({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const clearCloud = async () => {
    setBusy("clear");
    setNote(null);
    try {
      await client.clearSpeechCloud();
      setNote({ tone: "success", message: "Cloud key removed." });
      await refresh();
    } catch (e) {
      setNote({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const installLocal = async () => {
    setBusy("local");
    setNote(null);
    try {
      await client.installLocalSpeech();
      setNote({ tone: "success", message: "Local speech model is ready." });
      await refresh();
    } catch (e) {
      setNote({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-muted">
        Speak to the agent instead of typing. Audio is used only while you are speaking and is not
        kept after the transcript is ready. The cloud key stays in the daemon and is never shown
        to the app window.
      </p>
      <Row label="Provider" hint="Auto uses built-in speech when available, then a cloud key, then the local model.">
        <Select
          value={draft.voice.provider}
          onChange={(e) =>
            update((s) => ({
              ...s,
              voice: { ...s.voice, provider: e.target.value as Settings["voice"]["provider"] },
            }))
          }
        >
          <option value="auto">Auto</option>
          <option value="on_device" disabled={!builtInAvailable}>{native.available ? "On-device (macOS)" : "Built-in speech"}{builtInAvailable ? "" : " (unavailable in this app)"}</option>
          <option value="cloud">Cloud</option>
          <option value="local">Local model</option>
        </Select>
      </Row>
      <Row label="Language">
        <Input
          value={draft.voice.language}
          onChange={(e) => update((s) => ({ ...s, voice: { ...s.voice, language: e.target.value } }))}
          placeholder="en"
        />
      </Row>
      <Row label="Push-to-talk" hint="Hold the shortcut while you speak, or tap it to start and stop.">
        <Select
          value={draft.voice.pushToTalkMode}
          onChange={(e) =>
            update((s) => ({
              ...s,
              voice: { ...s.voice, pushToTalkMode: e.target.value as Settings["voice"]["pushToTalkMode"] },
            }))
          }
        >
          <option value="hold">Hold</option>
          <option value="toggle">Toggle</option>
        </Select>
      </Row>
      <Row label="Shortcut" hint="Click the field and press the keys. Esc cancels a take.">
        <Input
          value={draft.voice.pushToTalkShortcut}
          readOnly
          onKeyDown={(e) => {
            e.preventDefault();
            if (e.key === "Escape" || e.key === "Tab") return;
            const parts: string[] = [];
            if (e.ctrlKey) parts.push("Ctrl");
            if (e.altKey) parts.push("Alt");
            if (e.shiftKey) parts.push("Shift");
            if (e.metaKey) parts.push("Meta");
            const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
            if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
            parts.push(key);
            update((s) => ({ ...s, voice: { ...s.voice, pushToTalkShortcut: parts.join("+") } }));
          }}
        />
      </Row>
      <div role="status" className={`rounded-lg border px-3 py-2 text-xs ${activeBackend ? "border-border text-muted" : "border-warning/30 bg-warning/5 text-warning"}`}>
        {native.checking ? "Checking on-device speech…" : activeBackend ? `Ready: ${backendLabels[activeBackend]}.` : (draft.voice.provider === "on_device" || native.needsDownload)
          ? native.message || "Built-in speech recognition is not available in this app. Choose Cloud or Local model below."
          : "Speech recognition needs setup. Add a cloud key or configure a local speech engine below."}
        {activeBackend === "on_device" && native.available && <p className="mt-1 text-[11px] text-muted">Audio stays on this Mac. macOS manages the speech model.</p>}
        <p className="mt-1 text-[11px] text-muted">Hold {formatVoiceShortcut(parseVoiceShortcut(draft.voice.pushToTalkShortcut), host.platform)} to speak.</p>
      </div>

      {native.needsDownload && (
        <div className="rounded-lg border border-border p-3">
          <div className="mb-1 text-[13px] font-medium">On-device speech</div>
          <p className="mb-3 text-xs leading-5 text-muted">Download the speech model from Apple for this language. No API key is needed, and your recordings stay on this Mac. Siri and keyboard Dictation can stay off.</p>
          <Button size="sm" disabled={busy !== null} onClick={() => void prepareNative()}>{busy === "native" ? "Preparing on-device speech…" : "Prepare on-device speech"}</Button>
          {busy === "native" && <Button size="sm" variant="ghost" onClick={() => { if (nativeSetupId.current) void native.service?.cancel(nativeSetupId.current); }}>Cancel</Button>}
        </div>
      )}
      <div className="rounded-lg border border-border p-3">
        <div className="mb-2 text-[13px] font-medium">Cloud speech key</div>
        <p className="mb-3 text-[11px] leading-4 text-muted">
          OpenAI-compatible transcriptions endpoint. {status?.cloudConfigured ? "A key is saved on this computer." : "No key saved."}
        </p>
        <div className="space-y-2">
          <Input
            type="password"
            autoComplete="off"
            placeholder={status?.cloudConfigured ? "Replace key" : "API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Input
            placeholder="https://api.openai.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={!apiKey.trim() || busy !== null} onClick={() => void saveCloud()}>
              {busy === "cloud" ? "Saving…" : "Save key"}
            </Button>
            <Button size="sm" disabled={!status?.cloudConfigured || busy !== null} onClick={() => void clearCloud()}>
              {busy === "clear" ? "Removing…" : "Remove key"}
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="mb-2 text-[13px] font-medium">Local model</div>
        <p className="mb-3 text-[11px] leading-4 text-muted">
          Downloads a small on-device model into this computer&apos;s fabPlane data folder. Needs{" "}
          <span className="font-mono">whisper-cli</span> on the PATH (or in that folder).{" "}
          {status?.localInstalled ? "Installed." : status?.backends.find((b) => b.id === "local")?.message ?? "Not installed."}
        </p>
        <Button size="sm" disabled={busy !== null} onClick={() => void installLocal()}>
          {busy === "local" ? "Downloading…" : status?.localInstalled ? "Re-download model" : "Download model"}
        </Button>
      </div>
      {note && <FeedbackNotice tone={note.tone} title={note.tone === "error" ? "Voice setup needs attention" : "Voice setup update"} {...(note.tone !== "error" ? { onDismiss: () => setNote(null) } : {})}>{note.message}</FeedbackNotice>}
    </div>
  );
}
