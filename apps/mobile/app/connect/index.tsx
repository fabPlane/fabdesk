/**
 * Saved computers, and the two ways to add one: scan the QR the desktop shows, or type a
 * fabdesk://pair URL when the camera will not cooperate.
 */
import { parsePairingUrl } from "@fabdesk/protocol";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Badge, Button, Card, Screen, readable } from "@/components/ui";
import { describePairingFailure } from "@/lib/pairing-failure";
import { claimAndSave } from "@/transport/pair";
import { useConnections } from "@/transport/connections";
import { warmUpLocalNetwork } from "@/transport/local-network-warmup";
import { relativeTime } from "@/lib/format";
import { useTheme } from "@/theme";

export default function ConnectScreen() {
  const t = useTheme();
  const { connections, activeId, setActive, forget } = useConnections();
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);

  // iOS puts up its Local Network prompt on the first request to a LAN address and fails that
  // request. Better it happens here, on a throwaway probe, than on the claim after a scan.
  useEffect(() => {
    void warmUpLocalNetwork(useConnections.getState().connections.flatMap((c) => c.candidates));
  }, []);

  const pairManually = async () => {
    const payload = parsePairingUrl(manual);
    if (!payload) {
      Alert.alert(
        "That is not a pairing link",
        "It should start with fabdesk://pair — copy it from the desktop's pairing dialog.",
      );
      return;
    }
    setBusy(true);
    try {
      await claimAndSave(payload);
      setManual("");
      router.back();
    } catch (e) {
      const failure = describePairingFailure(e, { platform: Platform.OS });
      Alert.alert(failure.title, failure.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: 14, gap: 14, ...readable }}
        keyboardShouldPersistTaps="handled"
      >
        <Button
          title="Scan pairing code"
          variant="primary"
          onPress={() => router.push("/connect/scan")}
        />
        {Platform.OS === "ios" ? (
          <Text style={{ color: t.muted, fontSize: 12, marginTop: -6 }}>
            iOS may ask to let fabPlane find devices on your local network — allow it, or a
            computer on the same Wi-Fi can't be reached.
          </Text>
        ) : null}

        {connections.map((c) => (
          <Card key={c.id}>
            <Pressable onPress={() => void setActive(c.id)}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", flex: 1 }}>
                  {c.name}
                </Text>
                {c.id === activeId ? <Badge label="active" tone="success" /> : null}
              </View>
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 4 }} numberOfLines={1}>
                {c.baseUrl}
              </Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>
                paired {relativeTime(c.pairedAt)}
                {c.lastConnectedAt ? ` · last seen ${relativeTime(c.lastConnectedAt)}` : ""}
              </Text>
            </Pressable>
            <Button
              title="Forget"
              variant="danger"
              style={{ marginTop: 10 }}
              onPress={() =>
                Alert.alert("Forget this computer?", `${c.name} will need pairing again.`, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Forget", style: "destructive", onPress: () => void forget(c.id) },
                ])
              }
            />
          </Card>
        ))}

        <Card>
          <Text style={{ color: t.fg, fontSize: 14, fontWeight: "600", marginBottom: 6 }}>
            Paste a pairing link
          </Text>
          <Text style={{ color: t.muted, fontSize: 12, marginBottom: 8 }}>
            Settings › Remote access › Pair a device on the desktop shows the link behind the QR
            code.
          </Text>
          <TextInput
            // Android in landscape otherwise swaps the screen for a full-screen editor with a DONE key.
            disableFullscreenUI
            value={manual}
            onChangeText={setManual}
            placeholder="fabdesk://pair?…"
            placeholderTextColor={t.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              backgroundColor: t.bg,
              borderColor: t.border,
              borderWidth: StyleSheet.hairlineWidth,
              borderRadius: 8,
              color: t.fg,
              fontSize: 13,
              paddingHorizontal: 10,
              paddingVertical: 9,
            }}
          />
          <Button
            title={busy ? "Pairing…" : "Pair"}
            disabled={busy || !manual}
            onPress={() => void pairManually()}
            style={{ marginTop: 10 }}
          />
        </Card>
      </ScrollView>
    </Screen>
  );
}
