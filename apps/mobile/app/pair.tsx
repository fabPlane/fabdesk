/**
 * The `fabdesk://pair?…` deep link. The QR the desktop shows encodes exactly this URL, so a link
 * that arrives by AirDrop or a message instead of the camera lands here and pairs the same way.
 * Without this route the scheme is registered but the URL has nowhere to go.
 */
import { parsePairingUrl } from "@fabdesk/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Button, Empty, Loading, Screen } from "@/components/ui";
import { pairingUrlFromParams, type RouteParams } from "@/lib/pair-link";
import { claimAndSave } from "@/transport/pair";
import { useTheme } from "@/theme";

export default function PairLinkScreen() {
  const t = useTheme();
  const params: RouteParams = useLocalSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  // The pairing token is one-time; a re-render must not claim it twice.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const payload = parsePairingUrl(pairingUrlFromParams(params));
    if (!payload) {
      setError(
        "That is not a pairing link. It should come from Settings › Remote access › Pair a device on the desktop.",
      );
      return;
    }
    setName(payload.name);
    claimAndSave(payload)
      .then(() => router.replace("/(tabs)"))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [params]);

  if (error) {
    return (
      <Screen>
        <Empty
          title="Pairing failed"
          hint={error}
          action={<Button title="Connections" onPress={() => router.replace("/connect")} />}
        />
      </Screen>
    );
  }
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Loading label={name ? `Pairing with ${name}…` : "Pairing…"} />
        <Text style={{ color: t.muted, fontSize: 12, textAlign: "center", paddingHorizontal: 24 }}>
          Each address the computer listed is tried in turn, so this can take a few seconds.
        </Text>
      </View>
    </Screen>
  );
}
