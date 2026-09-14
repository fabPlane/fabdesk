/**
 * A tool call the run has paused on, in supervised mode. Approve / Deny answer it from the phone;
 * once anyone has answered (desktop, phone, or the daemon's timeout) the card just says so.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  bareToolName,
  decisionLabel,
  inputDetail,
  inputPreview,
  type ApprovalDecision,
  type ApprovalPart,
} from "@/lib/pending-requests";
import { useTheme } from "@/theme";

export function PendingApprovalCard({
  part,
  busy,
  onDecide,
}: {
  part: ApprovalPart;
  busy: boolean;
  onDecide: (requestId: string, decision: ApprovalDecision) => void;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const resolved = decisionLabel(part);
  const tool = bareToolName(part.tool);
  const preview = inputPreview(part.input);
  const accent = resolved ? t.muted : t.warning;

  return (
    <View
      style={{
        backgroundColor: t.panel,
        borderColor: accent,
        borderWidth: StyleSheet.hairlineWidth,
        borderLeftWidth: 3,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={`${resolved ? "Resolved" : "Pending"} approval for ${tool}`}
        style={{ padding: 10, gap: 3 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: accent, fontSize: 11, fontWeight: "700" }}>
            {resolved ? "APPROVAL" : "NEEDS APPROVAL"}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: t.fg, fontSize: 12, fontFamily: "Menlo", flex: 1 }}
          >
            {tool}
          </Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>{open ? "▾" : "▸"}</Text>
        </View>
        <Text style={{ color: t.fg, fontSize: 14, lineHeight: 20 }}>{part.summary}</Text>
        {!open && preview && preview !== part.summary ? (
          <Text numberOfLines={1} style={{ color: t.muted, fontSize: 11, fontFamily: "Menlo" }}>
            {preview}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <View
          style={{
            borderTopColor: t.border,
            borderTopWidth: StyleSheet.hairlineWidth,
            backgroundColor: t.panel2,
            padding: 10,
          }}
        >
          <Text style={{ color: t.fg, fontSize: 11, fontFamily: "Menlo" }} selectable>
            {inputDetail(part.input) || "(no input)"}
          </Text>
        </View>
      ) : null}
      {resolved ? (
        <Text
          style={{
            color: part.decision === "approve" ? t.success : t.muted,
            fontSize: 12,
            paddingHorizontal: 10,
            paddingBottom: 10,
          }}
        >
          {resolved}
        </Text>
      ) : (
        <View
          style={{
            flexDirection: "row",
            gap: 8,
            padding: 10,
            paddingTop: 4,
            alignItems: "center",
          }}
        >
          <DecisionButton
            label="Deny"
            color={t.danger}
            fg={t.danger}
            outline
            disabled={busy}
            onPress={() => onDecide(part.requestId, "deny")}
          />
          <DecisionButton
            label="Approve"
            color={t.accent}
            fg={t.accentFg}
            disabled={busy}
            onPress={() => onDecide(part.requestId, "approve")}
          />
          {busy ? <ActivityIndicator color={t.muted} /> : null}
        </View>
      )}
    </View>
  );
}

function DecisionButton({
  label,
  color,
  fg,
  outline,
  disabled,
  onPress,
}: {
  label: string;
  color: string;
  fg: string;
  outline?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        paddingHorizontal: 18,
        paddingVertical: 9,
        borderRadius: 16,
        backgroundColor: outline ? "transparent" : color,
        borderColor: color,
        borderWidth: outline ? 1 : 0,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ color: fg, fontWeight: "700", fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}
