/**
 * Settings → Notifications: the master switch and the four §4.1 prefs. Turning it on is the one
 * place the OS permission prompt appears; a refusal leaves the switch off and says where to fix
 * it. Push uses the platform's own token (APNs / FCM), so a release build with the push
 * entitlement needs nothing else; until a token is obtained, local notifications still work
 * while the app is backgrounded with the socket alive.
 */
import { Alert, Linking, Text, View } from "react-native";
import { useState } from "react";
import { Card, SwitchRow } from "../components/ui";
import { haptic } from "../state/haptics";
import { useTheme } from "../theme";
import { useConnections } from "../transport/connections";
import { requestNotificationPermission } from "./local";
import { fetchDevicePushToken, unregisterPushEverywhere } from "./push";
import { useNotificationStore } from "./store";

export function NotificationsCard() {
  const t = useTheme();
  const store = useNotificationStore();
  const connections = useConnections((s) => s.connections);
  const [busy, setBusy] = useState(false);
  const [tokenNote, setTokenNote] = useState<string | null>(null);

  const enable = async () => {
    setBusy(true);
    try {
      const ok = await requestNotificationPermission();
      if (!ok) {
        Alert.alert(
          "Notifications are off for fabPlane",
          "Allow them in the system settings to be told when a run finishes.",
          [
            { text: "Not now", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ],
        );
        return;
      }
      store.setEnabled(true);
      haptic("success");
      const result = await fetchDevicePushToken();
      if (result.token) {
        store.setPushToken(result.token);
        setTokenNote(null);
      } else {
        setTokenNote(
          result.reason === "unavailable"
            ? `No push token yet${result.detail ? ` (${result.detail})` : ""} — simulators and builds without the push entitlement cannot get one. Local notifications still apply; will retry on the next connect.`
            : "Push is not available on this device.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      store.setEnabled(false);
      await unregisterPushEverywhere(connections);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", marginBottom: 2 }}>
        Notifications
      </Text>
      <SwitchRow
        label="Notify me when runs finish"
        hint={
          store.enabled
            ? store.pushToken
              ? "Push is registered with each computer you connect to."
              : "Local notifications only until a push token is obtained."
            : "Asks for permission when you turn it on."
        }
        value={store.enabled}
        onChange={(on) => {
          if (busy) return;
          void (on ? enable() : disable());
        }}
      />
      {store.enabled ? (
        <View style={{ marginTop: 4 }}>
          <SwitchRow
            label="Finished"
            value={store.prefs.onDone}
            onChange={(v) => store.setPref("onDone", v)}
          />
          <SwitchRow
            label="Failed or stopped"
            value={store.prefs.onFailed}
            onChange={(v) => store.setPref("onFailed", v)}
          />
          <SwitchRow
            label="Needs an answer or approval"
            value={store.prefs.onNeedsInput}
            onChange={(v) => store.setPref("onNeedsInput", v)}
          />
          <SwitchRow
            label="Long jobs (routing, renders)"
            value={store.prefs.onJobs}
            onChange={(v) => store.setPref("onJobs", v)}
          />
        </View>
      ) : null}
      {tokenNote ? (
        <Text style={{ color: t.warning, fontSize: 12, marginTop: 6 }}>{tokenNote}</Text>
      ) : null}
    </Card>
  );
}
