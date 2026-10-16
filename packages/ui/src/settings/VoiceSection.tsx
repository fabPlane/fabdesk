import type { Settings } from "@fabdesk/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
  const [busy, setBusy] = useState<"cloud" | "clear" | "local" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const status = speech.data;

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
      setNote("Cloud key saved on this computer. It is never sent to the app window.");
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const clearCloud = async () => {
    setBusy("clear");
    setNote(null);
    try {
      await client.clearSpeechCloud();
      setNote("Cloud key removed.");
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const installLocal = async () => {
    setBusy("local");
    setNote(null);
    try {
      await client.installLocalSpeech();
      setNote("Local speech model is ready.");
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
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
      <Row label="Provider" hint="Auto uses on-device speech when it produces a transcript, then a cloud key, then the local model.">
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
          <option value="on_device">On-device</option>
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
      <p className="text-[11px] text-muted">
        Currently {formatVoiceShortcut(parseVoiceShortcut(draft.voice.pushToTalkShortcut), host.platform)}.
        {status ? ` Auto would use ${status.active ?? "nothing ready"}.` : ""}
      </p>

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
      {note && <div className="text-xs text-muted">{note}</div>}
    </div>
  );
}
