/**
 * Create an empty project. The desktop's dialog asks for a name and nothing else (board settings
 * are set by the first build or by the agent), so this does the same: `POST /projects { name }`.
 */
import { useCreateProject } from "@fabdesk/client-core";
import { Stack, router } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, Screen, readable } from "@/components/ui";
import { useTheme } from "@/theme";

const MAX_NAME = 80; // CreateProject in packages/protocol

export default function NewProjectScreen() {
  const t = useTheme();
  const create = useCreateProject();
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_NAME;

  const submit = () => {
    if (!valid || create.isPending) return;
    create
      .mutateAsync(trimmed)
      .then((p) => router.replace({ pathname: "/project/[id]", params: { id: p.id } }))
      .catch((e: unknown) =>
        Alert.alert("Could not create the project", e instanceof Error ? e.message : String(e)),
      );
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: "New project" }} />
      <View style={{ padding: 16, gap: 12, ...readable }}>
        <Text style={{ color: t.muted, fontSize: 13 }}>
          The daemon creates a folder for it on the computer, next to your other projects. Build the
          board from a chat afterwards.
        </Text>
        <TextInput
          // Android in landscape otherwise swaps the screen for a full-screen editor with a DONE key.
          disableFullscreenUI
          autoFocus
          value={name}
          onChangeText={setName}
          onSubmitEditing={submit}
          placeholder="Project name"
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          maxLength={MAX_NAME}
          style={{
            backgroundColor: t.panel,
            borderColor: t.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: 10,
            color: t.fg,
            paddingHorizontal: 12,
            paddingVertical: 11,
            fontSize: 16,
          }}
        />
        <Button
          title={create.isPending ? "Creating…" : "Create"}
          variant="primary"
          disabled={!valid || create.isPending}
          onPress={submit}
        />
        <Button
          title="Or remix a board from the catalog"
          onPress={() => router.replace("/catalog")}
        />
      </View>
    </Screen>
  );
}
