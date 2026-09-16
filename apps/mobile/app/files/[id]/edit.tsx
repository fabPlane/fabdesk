/**
 * Plain-text editor for one project file. Saving writes the whole file through
 * `PUT /projects/:id/files/*` — the same route the agents use — behind a confirmation, because a
 * phone edit races anything an agent is doing to the same file on the desktop.
 */
import { useProjectText, useWriteProjectFile } from "@fabdesk/client-core";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, Text, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Loading, Screen } from "@/components/ui";
import { useTheme } from "@/theme";

export default function FileEditScreen() {
  const { id, path } = useLocalSearchParams<{ id: string; path: string }>();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const text = useProjectText(id ?? null, path ?? null);
  const write = useWriteProjectFile();
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    // Seed once; refetches must not clobber what is being typed.
    if (draft === null && typeof text.data === "string") setDraft(text.data);
  }, [draft, text.data]);
  const dirty = draft !== null && draft !== text.data;
  const name = path ? path.slice(path.lastIndexOf("/") + 1) : "Edit";

  const save = () => {
    if (!id || !path || draft === null) return;
    Alert.alert(
      "Overwrite this file?",
      `Agents write files too. Saving replaces ${path} on the computer with what is on this screen.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          style: "destructive",
          onPress: () =>
            write
              .mutateAsync({ projectId: id, path, content: draft })
              .then(() => router.back())
              .catch((e: unknown) =>
                Alert.alert("Could not save", e instanceof Error ? e.message : String(e)),
              ),
        },
      ],
    );
  };

  const discard = () => {
    if (!dirty) return router.back();
    Alert.alert("Discard changes?", undefined, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => router.back() },
    ]);
  };

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: name,
          headerLeft: () => (
            <Pressable hitSlop={12} accessibilityRole="button" onPress={discard}>
              <Text style={{ color: t.accent, fontSize: 16 }}>Cancel</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              hitSlop={12}
              accessibilityRole="button"
              onPress={save}
              disabled={!dirty || write.isPending}
            >
              <Text
                style={{
                  color: dirty && !write.isPending ? t.accent : t.muted,
                  fontSize: 16,
                  fontWeight: "600",
                }}
              >
                {write.isPending ? "Saving…" : "Save"}
              </Text>
            </Pressable>
          ),
        }}
      />
      {draft === null ? (
        <Loading label={text.isError ? (text.error as Error).message : "Loading file…"} />
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding"
          keyboardVerticalOffset={insets.top + (Platform.OS === "ios" ? 44 : 56)}
        >
          <TextInput
            // Android in landscape otherwise swaps the screen for a full-screen editor with a DONE key.
            disableFullscreenUI
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            value={draft}
            onChangeText={setDraft}
            style={{
              flex: 1,
              color: t.fg,
              fontFamily: "Menlo",
              fontSize: 12,
              lineHeight: 18,
              padding: 14,
            }}
          />
        </KeyboardAvoidingView>
      )}
    </Screen>
  );
}
