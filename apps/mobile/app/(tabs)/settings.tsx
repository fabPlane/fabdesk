import { useDoctor, usePatchSettings, useSettings } from "@fabdesk/client-core";
import type { AgentId } from "@fabdesk/protocol";
import { router } from "expo-router";
import { Alert, ScrollView, Text, View } from "react-native";
import { AccountCard } from "@/components/AccountCard";
import { Badge, Button, Card, Screen, Segmented, SwitchRow, readable } from "@/components/ui";
import { hardwareKeyboardShortcutsAvailable } from "@/layout/keyboard";
import { connectionPath, pathHint, pathLabel } from "@/lib/connection-path";
import { NotificationsCard } from "@/notifications/NotificationsCard";
import { haptic } from "@/state/haptics";
import { usePrefs, type Appearance } from "@/state/prefs";
import { useConnection } from "@/transport/CoreConnection";
import { useConnections } from "@/transport/connections";
import { useTheme } from "@/theme";
import { APP_LOCALES, LOCALE_META, mobileLocale, preloadMobileCatalog, translate } from "@/lib/i18n";
import type { AgentReplyChoice, UiLocaleChoice } from "@fabdesk/protocol";
import { useEffect } from "react";

const APPEARANCE_OPTIONS: readonly { value: Appearance; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function SettingsScreen() {
  const t = useTheme();
  const { connection, status, health, baseUrl, phase, via, coreOffline, retry } = useConnection();
  const connections = useConnections((s) => s.connections);
  // Which way this phone reaches the computer: straight over the tailnet/LAN, or the relay.
  const path = connectionPath({ via, baseUrl, relayUrl: connection?.relayUrl });

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 14, ...readable }}>
        <AccountCard />

        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", flex: 1 }}>
              {connection?.name ?? "Not connected"}
            </Text>
            <Badge
              label={
                status === "open"
                  ? "connected"
                  : phase === "core-offline" || (coreOffline && phase === "connecting")
                    ? "computer offline"
                    : phase
              }
              tone={
                status === "open"
                  ? "success"
                  : phase === "unreachable" || phase === "core-offline" || phase === "unauthorized"
                    ? "danger"
                    : "warning"
              }
            />
          </View>
          {path ? <Field label="Path" value={pathLabel(path)} /> : null}
          {baseUrl ? <Field label="Address" value={baseUrl} /> : null}
          {health ? (
            <Field
              label="Core"
              value={`${health.version} · ${health.channel} · up ${Math.round(health.uptimeMs / 60000)}m`}
            />
          ) : null}
          {path ? (
            <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, marginTop: 6 }}>
              {pathHint(path)}
            </Text>
          ) : null}
          {coreOffline && status !== "open" ? (
            <Text style={{ color: t.warning, fontSize: 12, lineHeight: 17, marginTop: 6 }}>
              The relay is up, but {connection?.name ?? "your computer"} is not connected to it.
              Wake it, or check that it is signed in to fabplane.com with remote access on.
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <Button title="Reconnect" onPress={retry} style={{ flex: 1 }} />
            <Button
              title={connections.length > 1 ? "Switch" : "Connections"}
              onPress={() => router.push("/connect")}
              style={{ flex: 1 }}
            />
          </View>
          <Button
            title="Jobs on that machine"
            onPress={() => router.push("/jobs")}
            style={{ marginTop: 8 }}
          />
        </Card>

        <AgentsCard />

        <LanguageCard />

        <NotificationsCard />

        <ThisPhoneCard />

        <Card>
          <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>
            {path?.via === "relay"
              ? `This app is talking to your computer through the ${path.host} relay: the computer dials out to it, so no port is open on your network. Your device token is checked by the computer, not the relay. A direct tailnet or LAN address is used again as soon as one answers.`
              : "This app talks straight to a fabPlane daemon on your tailnet or LAN whenever one answers, and falls back to the fabplane.com relay only when the computer has one set up and nothing direct is reachable. A direct connection is only as private as the network carrying it — keep it on Tailscale."}
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

/**
 * Agents found on that machine, and which one new chats use. The default is the daemon's own
 * setting (`PATCH /settings`), so changing it here changes it on the desktop too.
 */
function AgentsCard() {
  // The daemon hooks below need the CoreProvider, which only exists once a transport does —
  // reading them while the computer is unreachable threw and took the whole tab down.
  const { status } = useConnection();
  if (status !== "open") return null;
  return <AgentsCardBody />;
}

function AgentsCardBody() {
  const t = useTheme();
  const doctor = useDoctor();
  const settings = useSettings();
  const patch = usePatchSettings();
  const agents = doctor.data?.agents ?? [];
  const installed = agents.filter((a) => a.installed);
  const current = settings.data?.defaultAgent;

  const choose = (id: AgentId) => {
    if (id === current || patch.isPending) return;
    haptic("selection");
    patch.mutate(
      { defaultAgent: id },
      {
        onError: (e) =>
          Alert.alert(
            "Could not change the default agent",
            e instanceof Error ? e.message : String(e),
          ),
      },
    );
  };

  return (
    <Card>
      <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", marginBottom: 8 }}>
        Agents on that machine
      </Text>
      {agents.map((a) => (
        <View
          key={a.id}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 }}
        >
          <Text style={{ color: t.fg, fontSize: 13, flex: 1 }}>{a.displayName}</Text>
          <Badge
            label={a.installed ? (a.version ?? "installed") : "not found"}
            tone={a.installed ? "success" : "warning"}
          />
        </View>
      ))}
      {agents.length === 0 ? (
        // `/doctor` probes each agent binary, which takes a few seconds the first time.
        <Text style={{ color: t.muted, fontSize: 13 }}>
          {doctor.isPending ? "Checking…" : "Nothing reported yet."}
        </Text>
      ) : null}
      {installed.length > 0 ? (
        <View style={{ marginTop: 12, gap: 6 }}>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            Default for new chats{patch.isPending ? " · saving…" : ""}
          </Text>
          <Segmented
            value={current ?? installed[0]!.id}
            options={installed.map((a) => ({ value: a.id, label: a.displayName }))}
            onChange={choose}
          />
          {current && !installed.some((a) => a.id === current) ? (
            <Text style={{ color: t.warning, fontSize: 12 }}>
              The desktop's default ({current}) is not installed on that machine.
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function LanguageCard() {
  const t = useTheme();
  const { status } = useConnection();
  if (status !== "open") return null;
  return <LanguageCardBody theme={t} />;
}

function LanguageCardBody({ theme: t }: { theme: ReturnType<typeof useTheme> }) {
  const settings = useSettings();
  const patch = usePatchSettings();
  const uiLocale = (settings.data?.uiLocale ?? "system") as UiLocaleChoice;
  const agentReply = (settings.data?.agentReplyLanguage ?? "match") as AgentReplyChoice;
  const languages =
    typeof navigator !== "undefined" && navigator.languages ? [...navigator.languages] : [];
  const locale = mobileLocale(uiLocale, languages);
  useEffect(() => {
    void preloadMobileCatalog(locale);
  }, [locale]);
  const label = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const setUi = (next: UiLocaleChoice) => {
    if (next === uiLocale || patch.isPending) return;
    haptic("selection");
    patch.mutate({ uiLocale: next });
  };
  const setAgent = (next: AgentReplyChoice) => {
    if (next === agentReply || patch.isPending) return;
    haptic("selection");
    patch.mutate({ agentReplyLanguage: next });
  };
  return (
    <Card>
      <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", marginBottom: 8 }}>{label("common.language")}</Text>
      <Text style={{ color: t.muted, fontSize: 12, marginBottom: 6 }}>{label("settings.language.ui")}</Text>
      <View style={{ gap: 6 }}>
        <Option
          label={label("settings.language.system")}
          selected={uiLocale === "system"}
          onPress={() => setUi("system")}
        />
        {APP_LOCALES.map((id) => (
          <Option
            key={id}
            label={`${LOCALE_META[id].nativeName} — ${LOCALE_META[id].nameEn}`}
            selected={uiLocale === id}
            onPress={() => setUi(id)}
          />
        ))}
      </View>
      <Text style={{ color: t.muted, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
        {label("settings.language.agent")}
      </Text>
      <Option
        label={label("settings.language.matchMessage")}
        selected={agentReply === "match"}
        onPress={() => setAgent("match")}
      />
      {APP_LOCALES.map((id) => (
        <Option
          key={`agent-${id}`}
          label={LOCALE_META[id].nativeName}
          selected={agentReply === id}
          onPress={() => setAgent(id)}
        />
      ))}
    </Card>
  );
}

function Option({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      title={selected ? `✓ ${label}` : label}
      onPress={onPress}
      style={{ marginTop: 4 }}
    />
  );
}

/** Preferences that live on this phone only. */
function ThisPhoneCard() {
  const t = useTheme();
  const prefs = usePrefs();
  return (
    <Card>
      <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", marginBottom: 8 }}>
        This phone
      </Text>
      <Text style={{ color: t.muted, fontSize: 12, marginBottom: 6 }}>Appearance</Text>
      <Segmented
        value={prefs.appearance}
        options={APPEARANCE_OPTIONS}
        onChange={(v) => {
          haptic("selection");
          prefs.setAppearance(v);
        }}
      />
      <View style={{ marginTop: 8 }}>
        <SwitchRow
          label="Haptics"
          hint="A light tap on selections and results."
          value={prefs.haptics}
          onChange={(on) => {
            prefs.setHaptics(on);
            if (on) haptic("success");
          }}
        />
        <SwitchRow
          label="Keep screen awake while a run is live"
          hint="So a long route or render can be watched without the screen locking."
          value={prefs.keepAwake}
          onChange={prefs.setKeepAwake}
        />
      </View>
      {hardwareKeyboardShortcutsAvailable ? (
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 8 }}>
          Hardware keyboard: ⌘N new chat · ⌘K search chats
        </Text>
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
