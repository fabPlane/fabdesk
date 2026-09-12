import { useDoctor } from "@fabdesk/client-core";
import { router } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { Badge, Button, Card, Screen, readable } from "@/components/ui";
import { useConnection } from "@/transport/CoreConnection";
import { useConnections } from "@/transport/connections";
import { useTheme } from "@/theme";

export default function SettingsScreen() {
  const t = useTheme();
  const { connection, status, health, baseUrl, phase, retry } = useConnection();
  const connections = useConnections((s) => s.connections);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 14, ...readable }}>
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", flex: 1 }}>{connection?.name ?? "Not connected"}</Text>
            <Badge
              label={status === "open" ? "connected" : phase}
              tone={status === "open" ? "success" : phase === "unreachable" || phase === "unauthorized" ? "danger" : "warning"}
            />
          </View>
          {baseUrl ? <Field label="Address" value={baseUrl} /> : null}
          {health ? <Field label="Core" value={`${health.version} · ${health.channel} · up ${Math.round(health.uptimeMs / 60000)}m`} /> : null}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <Button title="Reconnect" onPress={retry} style={{ flex: 1 }} />
            <Button title={connections.length > 1 ? "Switch" : "Connections"} onPress={() => router.push("/connect")} style={{ flex: 1 }} />
          </View>
        </Card>

        <AgentsCard />

        <Card>
          <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>
            This app talks straight to a fabPlane daemon on your tailnet or LAN. Nothing goes through fabplane.com, and
            the connection is only as private as the network carrying it — keep it on Tailscale.
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

function AgentsCard() {
  const t = useTheme();
  const { status } = useConnection();
  const doctor = useDoctor();
  if (status !== "open") return null;
  return (
    <Card>
      <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", marginBottom: 8 }}>Agents on that machine</Text>
      {(doctor.data?.agents ?? []).map((a) => (
        <View key={a.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 }}>
          <Text style={{ color: t.fg, fontSize: 13, flex: 1 }}>{a.displayName}</Text>
          <Badge label={a.installed ? (a.version ?? "installed") : "not found"} tone={a.installed ? "success" : "warning"} />
        </View>
      ))}
      {(doctor.data?.agents ?? []).length === 0 ? (
        // `/doctor` probes each agent binary, which takes a few seconds the first time.
        <Text style={{ color: t.muted, fontSize: 13 }}>{doctor.isPending ? "Checking…" : "Nothing reported yet."}</Text>
      ) : null}
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", paddingVertical: 2 }}>
      <Text style={{ color: t.muted, fontSize: 13, width: 80 }}>{label}</Text>
      <Text style={{ color: t.fg, fontSize: 13, flex: 1 }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}
