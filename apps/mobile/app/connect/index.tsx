/**
 * Saved computers with their status, and the two ways to add one: scan the QR the desktop shows,
 * or type a fabdesk://pair URL when the camera will not cooperate. Every computer is probed on
 * arrival and once a minute after (`useStatusProbing`); pull down to probe them all now.
 */
import { parsePairingUrl } from "@fabdesk/protocol";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusDot } from "@/components/EnvironmentSwitcher";
import { Badge, Button, Card, Screen, readable } from "@/components/ui";
import { lastSeenLabel, orderEnvironments, statusLabel } from "@/lib/environments";
import { describePairingFailure } from "@/lib/pairing-failure";
import { haptic } from "@/state/haptics";
import { claimAndSave } from "@/transport/pair";
import { useConnections } from "@/transport/connections";
import {
  useEnvironmentStatus,
  useEnvironmentStatusOf,
  useStatusProbing,
} from "@/transport/CoreConnection";
import { warmUpLocalNetwork } from "@/transport/local-network-warmup";
import { relativeTime } from "@/lib/format";
import { useTheme } from "@/theme";

export default function ConnectScreen() {
  const t = useTheme();
  const { connections, activeId, setActive, forget } = useConnections();
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const statuses = useEnvironmentStatus((s) => s.statuses);
  const refresh = useEnvironmentStatus((s) => s.refresh);
  const [refreshing, setRefreshing] = useState(false);
  useStatusProbing(true);
  const liveStatus = useEnvironmentStatusOf(activeId ?? "");
  const statusOf = (id: string) =>
    id === activeId ? liveStatus : (statuses[id]?.status ?? "unknown");
  const ordered = orderEnvironments(connections, activeId, statusOf);

  // iOS puts up its Local Network prompt on the first request to a LAN address and fails that
  // request. Better it happens here, on a throwaway probe, than on the claim after a scan.
  useEffect(() => {
    void warmUpLocalNetwork(useConnections.getState().connections.flatMap((c) => c.candidates));
  }, []);

  // Tracks the pull, not the store's `probing`: a timer-driven round must not strand the spinner.
  const onRefresh = () => {
    setRefreshing(true);
    void refresh().finally(() => setRefreshing(false));
  };

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
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.muted} />
        }
      >
        <Button
          title="Scan pairing code"
          variant="primary"
          onPress={() => router.push("/connect/scan")}
        />
        {Platform.OS === "ios" ? (
          <Text style={{ color: t.muted, fontSize: 12, marginTop: -6 }}>
            iOS may ask to let fabPlane find devices on your local network — allow it, or a computer
            on the same Wi-Fi can't be reached.
          </Text>
        ) : null}

        {ordered.map((c) => (
          <Card key={c.id}>
            <Pressable
              onPress={() => {
                if (c.id === activeId) return;
                haptic("selection");
                void setActive(c.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${c.name}, ${statusLabel[statusOf(c.id)]}${c.id === activeId ? ", active" : ", tap to switch"}`}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <StatusDot status={statusOf(c.id)} size={10} />
                <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", flex: 1 }}>
                  {c.name}
                </Text>
                {c.id === activeId ? <Badge label="active" tone="success" /> : null}
              </View>
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 4 }} numberOfLines={1}>
                {statusLabel[statusOf(c.id)]} · {statuses[c.id]?.baseUrl ?? c.baseUrl}
              </Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>
                paired {relativeTime(c.pairedAt)} · {lastSeenLabel(c, statuses[c.id])}
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
