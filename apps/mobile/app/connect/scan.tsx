import { parsePairingUrl } from "@fabdesk/protocol";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Platform, StyleSheet, Text, View } from "react-native";
import { Button, Empty, Loading, Screen } from "@/components/ui";
import { describePairingFailure } from "@/lib/pairing-failure";
import { claimAndSave } from "@/transport/pair";
import { useTheme } from "@/theme";

export default function ScanScreen() {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  // The scanner fires repeatedly on the same code; the pairing token is one-time, so only the
  // first scan may reach the daemon.
  const claimed = useRef(false);

  if (!permission) return <Loading label="Checking camera access…" />;

  if (!permission.granted) {
    return (
      <Screen>
        <Empty
          title="Camera access needed"
          hint="The pairing code is a QR code shown by fabPlane on your computer."
          action={
            <Button
              title="Allow camera"
              variant="primary"
              onPress={() => void requestPermission()}
            />
          }
        />
      </Screen>
    );
  }

  const onScan = async (data: string) => {
    if (claimed.current || busy) return;
    const payload = parsePairingUrl(data);
    if (!payload) return;
    claimed.current = true;
    setBusy(true);
    try {
      const connection = await claimAndSave(payload);
      router.dismissTo("/(tabs)");
      Alert.alert("Paired", `Connected to ${connection.name}.`);
    } catch (e) {
      claimed.current = false;
      const failure = describePairingFailure(e, { platform: Platform.OS });
      Alert.alert(failure.title, failure.message, [{ text: "OK", onPress: () => setBusy(false) }]);
    }
  };

  return (
    <Screen>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => void onScan(data)}
      />
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 40,
          alignItems: "center",
          paddingHorizontal: 24,
        }}
      >
        <View style={{ backgroundColor: t.panel, borderRadius: 12, padding: 14 }}>
          <Text style={{ color: t.fg, fontSize: 14, textAlign: "center" }}>
            {busy ? "Pairing…" : "Point at the code in Settings › Remote access on your computer."}
          </Text>
        </View>
      </View>
    </Screen>
  );
}
