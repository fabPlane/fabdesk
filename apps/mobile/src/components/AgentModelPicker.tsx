/**
 * The `claude · haiku` pill. Tapping it asks for an agent, then (when that agent offers more than
 * its default) a model — two short sheets rather than one long one, which is what a thumb wants.
 */
import type { AgentInfo } from "@fabdesk/protocol";
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import {
  agentOptions,
  choiceLabel,
  modelOptions,
  type AgentChoice,
  type PickerSettings,
} from "@/lib/agent-choice";
import { useTheme } from "@/theme";
import { useOptionSheet } from "./OptionSheet";

export function AgentModelPicker({
  value,
  onChange,
  agents,
  settings,
  disabled,
  style,
}: {
  value: AgentChoice;
  onChange: (next: AgentChoice) => void;
  agents: readonly AgentInfo[];
  settings: PickerSettings | undefined;
  disabled?: boolean | undefined;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const { show, sheet } = useOptionSheet();

  const pickModel = (agent: AgentInfo) => {
    const models = modelOptions(agent, settings, value);
    if (models.length <= 1) {
      onChange({ agentId: agent.id, model: models[0]?.model ?? "" });
      return;
    }
    show({
      title: `${agent.id} model`,
      options: models.map((m) => ({
        label: m.label,
        hint: m.hint,
        selected: m.selected,
        onPress: () => onChange({ agentId: agent.id, model: m.model }),
      })),
    });
  };

  const open = () => {
    const options = agentOptions(agents, value);
    if (options.length === 0) {
      show({
        title: "No agents",
        message: "No agent CLI is installed on the connected computer.",
        options: [],
      });
      return;
    }
    show({
      title: "Agent",
      options: options.map((o) => ({
        label: o.label,
        hint: o.hint,
        selected: o.selected,
        onPress: () => {
          const agent = agents.find((a) => a.id === o.agentId);
          if (agent) pickModel(agent);
        },
      })),
    });
  };

  return (
    <>
      <Pressable
        onPress={open}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Agent and model: ${choiceLabel(value)}`}
        hitSlop={6}
        style={({ pressed }) => [
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            alignSelf: "flex-start",
            borderColor: t.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: 12,
            backgroundColor: pressed ? t.panel2 : t.bg,
            paddingHorizontal: 10,
            paddingVertical: 4,
            opacity: disabled ? 0.5 : 1,
          },
          style,
        ]}
      >
        <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12, fontFamily: "Menlo" }}>
          {choiceLabel(value)}
        </Text>
        <Text style={{ color: t.muted, fontSize: 10 }}>▾</Text>
      </Pressable>
      {sheet}
    </>
  );
}
