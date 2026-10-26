import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useCoreClient } from "@fabdesk/client-core";
import { createMobileVoice, type MobileVoiceController } from "@/lib/voice-input";
import { createExpoAvRecorder } from "@/lib/voice-record";
import { useTheme } from "@/theme";

export function HoldToTalk({
  disabled,
  language,
  provider,
  onTranscript,
}: {
  disabled?: boolean;
  language?: string;
  provider?: "auto" | "on_device" | "cloud" | "local";
  onTranscript: (text: string) => void;
}) {
  const t = useTheme();
  const client = useCoreClient();
  const voiceRef = useRef<MobileVoiceController | null>(null);
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const controller = () => {
    if (!voiceRef.current) {
      voiceRef.current = createMobileVoice({
        recorder: createExpoAvRecorder(),
        client,
        ...(language ? { language } : {}),
        ...(provider ? { provider } : {}),
      });
    }
    return voiceRef.current;
  };

  const sync = () => {
    const s = controller().getState();
    if (s.error && s.phase === "idle") {
      setPhase("error");
      setError(s.error);
      return;
    }
    if (s.phase === "recording") setPhase("recording");
    else if (s.phase === "transcribing") setPhase("transcribing");
    else setPhase("idle");
  };

  return (
    <View>
      <Pressable
        disabled={disabled || phase === "transcribing"}
        onPressIn={() => {
          setError(null);
          void controller()
            .holdStart()
            .then(sync);
        }}
        onPressOut={() => {
          void controller()
            .holdEnd()
            .then((text) => {
              sync();
              if (text) onTranscript(text);
            });
        }}
        accessibilityRole="button"
        accessibilityLabel={
          phase === "recording" ? "Release to send what you said" : "Hold to talk"
        }
        style={({ pressed }) => ({
          width: 38,
          height: 38,
          borderRadius: 19,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: phase === "recording" || pressed ? t.danger : t.border,
          backgroundColor: phase === "recording" ? t.danger : t.bg,
        })}
      >
        <Text
          style={{
            color: phase === "recording" ? t.accentFg : t.fg,
            fontSize: 14,
            fontWeight: "700",
          }}
        >
          {phase === "transcribing" ? "…" : "🎤"}
        </Text>
      </Pressable>
      {error ? (
        <Text style={{ color: t.warning, fontSize: 11, marginTop: 4, maxWidth: 180 }}>{error}</Text>
      ) : null}
    </View>
  );
}
