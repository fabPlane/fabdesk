import type { Settings, SpeechBackendId, SpeechStatus } from "@fabdesk/protocol";

/** The daemon cannot know whether this app window ships a speech recognition engine. */
export function availableSpeechBackend(
  provider: Settings["voice"]["provider"],
  status: SpeechStatus | undefined,
  builtInAvailable: boolean,
): SpeechBackendId | null {
  if (provider === "on_device") return builtInAvailable ? "on_device" : null;
  const ready = (id: "cloud" | "local") => !!status?.backends.find((backend) => backend.id === id)?.ready;
  if (provider === "cloud" || provider === "local") return ready(provider) ? provider : null;
  if (builtInAvailable) return "on_device";
  if (ready("cloud")) return "cloud";
  if (ready("local")) return "local";
  return null;
}
