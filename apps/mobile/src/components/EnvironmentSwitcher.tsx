/**
 * The environment switcher: a pill in the Chats header with the active computer's name and a
 * status dot, and the sheet it opens listing every paired computer — status, last seen, tap to
 * switch, "Pair another" at the bottom.
 *
 * Not `useOptionSheet`: the iOS action sheet is imperative and one line per row, and the point of
 * this sheet is dots that keep updating while it is open (the probe loop runs while it is mounted).
 * So it is the same bottom modal on both platforms.
 */
import { router } from "expo-router";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  effectiveVia,
  lastSeenLabel,
  orderEnvironments,
  statusLabel,
  type EnvironmentStatus,
  type ReachedVia,
} from "@/lib/environments";
import { haptic } from "@/state/haptics";
import { useConnections, type Connection } from "@/transport/connections";
import {
  useEnvironmentStatus,
  useEnvironmentStatusOf,
  useEnvironmentViaOf,
  useStatusProbing,
} from "@/transport/CoreConnection";
import { useTheme, type Theme } from "@/theme";

export function statusColor(t: Theme, status: EnvironmentStatus): string {
  return status === "reachable" ? t.success : status === "offline" ? t.danger : t.muted;
}

/** "Online via relay" for a hollow dot; the plain status otherwise. */
export function dotLabel(status: EnvironmentStatus, via: ReachedVia | null): string {
  return status === "reachable" && via === "relay" ? "Online via relay" : statusLabel[status];
}

/**
 * A solid dot for a direct connection; a hollow ring of the same colour when the computer is
 * reachable only through the relay — same "online", one hop longer, and the hint to look at the
 * Settings card for which path is in use.
 */
export function StatusDot({
  status,
  via = null,
  size = 8,
}: {
  status: EnvironmentStatus;
  via?: ReachedVia | null;
  size?: number;
}) {
  const t = useTheme();
  const hollow = status === "reachable" && via === "relay";
  const color = statusColor(t, status);
  return (
    <View
      accessibilityLabel={dotLabel(status, via)}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: hollow ? "transparent" : color,
        borderColor: color,
        borderWidth: hollow ? Math.max(1.5, size / 5) : 0,
      }}
    />
  );
}

export function EnvironmentSwitcher() {
  const t = useTheme();
  const { connections, activeId } = useConnections();
  const active = connections.find((c) => c.id === activeId) ?? null;
  const [open, setOpen] = useState(false);
  const status = useEnvironmentStatusOf(active?.id ?? "");
  const via = useEnvironmentViaOf(active?.id ?? "");
  if (!active) return null;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`Computer: ${active.name}, ${dotLabel(status, via)}. Tap to switch.`}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          alignSelf: "flex-start",
          // Shares a row with Sort and Archived; a long hostname truncates rather than pushing them off.
          maxWidth: "50%",
          borderColor: t.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: 12,
          backgroundColor: pressed ? t.panel2 : t.panel,
          paddingHorizontal: 10,
          paddingVertical: 4,
        })}
      >
        <StatusDot status={status} via={via} />
        <Text
          numberOfLines={1}
          style={{ color: t.fg, fontSize: 12, fontWeight: "600", flexShrink: 1 }}
        >
          {active.name}
        </Text>
        <Text style={{ color: t.muted, fontSize: 10 }}>▾</Text>
      </Pressable>
      <EnvironmentSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function EnvironmentSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { connections, activeId, setActive } = useConnections();
  const statuses = useEnvironmentStatus((s) => s.statuses);
  const liveStatus = useEnvironmentStatusOf(activeId ?? "");
  const liveVia = useEnvironmentViaOf(activeId ?? "");
  useStatusProbing(open);

  const statusOf = (id: string) =>
    id === activeId ? liveStatus : (statuses[id]?.status ?? "unknown");
  const viaOf = (id: string) =>
    id === activeId ? liveVia : effectiveVia(statuses[id], null, statusOf(id));
  const ordered = orderEnvironments(connections, activeId, statusOf);

  const pick = (c: Connection) => {
    onClose();
    if (c.id === activeId) return;
    haptic("selection");
    // On a tablet a thread from the old computer may be open in the detail pane; it would query
    // the new one for an id it has never heard of. Back to the root first, then swap.
    if (router.canDismiss()) router.dismissAll();
    void setActive(c.id);
  };

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)" }}
        onPress={onClose}
        accessibilityLabel="Close"
      />
      <View
        style={{
          backgroundColor: t.panel,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          paddingBottom: Math.max(12, insets.bottom),
          maxHeight: "70%",
        }}
      >
        <View style={{ padding: 16, paddingBottom: 8 }}>
          <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600" }}>Computers</Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>
            Chats and projects are per computer. Tap one to switch.
          </Text>
        </View>
        <ScrollView>
          {ordered.map((c, i) => {
            const status = statusOf(c.id);
            const via = viaOf(c.id);
            const isActive = c.id === activeId;
            return (
              <Pressable
                key={c.id}
                onPress={() => pick(c)}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                accessibilityLabel={`${c.name}, ${dotLabel(status, via)}${isActive ? ", current" : ""}`}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? t.panel2 : "transparent",
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  borderTopColor: t.border,
                  borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                })}
              >
                <StatusDot status={status} via={via} size={10} />
                <View style={{ flex: 1 }}>
                  <Text
                    numberOfLines={1}
                    style={{ color: t.fg, fontSize: 15, fontWeight: isActive ? "700" : "500" }}
                  >
                    {c.name}
                  </Text>
                  <Text style={{ color: t.muted, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
                    {dotLabel(status, via)} · {lastSeenLabel(c, statuses[c.id])}
                  </Text>
                </View>
                <Text style={{ color: t.accent, width: 16, fontSize: 15 }}>
                  {isActive ? "✓" : ""}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            onPress={() => {
              onClose();
              router.push("/connect");
            }}
            accessibilityRole="button"
            style={({ pressed }) => ({
              backgroundColor: pressed ? t.panel2 : "transparent",
              paddingHorizontal: 16,
              paddingVertical: 13,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              borderTopColor: t.border,
              borderTopWidth: StyleSheet.hairlineWidth,
            })}
          >
            <Text style={{ color: t.accent, width: 10, fontSize: 16, fontWeight: "600" }}>＋</Text>
            <Text style={{ color: t.accent, fontSize: 15, fontWeight: "600" }}>Pair another</Text>
          </Pressable>
        </ScrollView>
        <Pressable
          onPress={onClose}
          style={({ pressed }) => ({
            marginTop: 6,
            marginHorizontal: 12,
            paddingVertical: 12,
            alignItems: "center",
            borderRadius: 10,
            backgroundColor: pressed ? t.panel2 : t.bg,
          })}
        >
          <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600" }}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}
