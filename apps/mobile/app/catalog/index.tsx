/** The open-source catalog (`GET /opensource`), searchable; a row opens the board's page. */
import { useCoreClient, useOpenCatalog } from "@fabdesk/client-core";
import { Stack, router } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { CatalogThumb } from "@/components/CatalogThumb";
import { Empty, Loading, Screen, readable } from "@/components/ui";
import { useTheme } from "@/theme";

export default function CatalogScreen() {
  const t = useTheme();
  const client = useCoreClient();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  // The search hits fabplane.com through the daemon; a keystroke should not.
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);
  const catalog = useOpenCatalog(q);
  const projects = catalog.data?.projects ?? [];

  return (
    <Screen>
      <Stack.Screen options={{ title: "Open-source boards" }} />
      <View style={{ padding: 12, paddingBottom: 6, ...readable }}>
        <TextInput
          // Android in landscape otherwise swaps the screen for a full-screen editor with a DONE key.
          disableFullscreenUI
          value={typed}
          onChangeText={setTyped}
          placeholder="Search the catalog"
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={{
            backgroundColor: t.panel,
            borderColor: t.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: 10,
            color: t.fg,
            paddingHorizontal: 12,
            paddingVertical: 9,
            fontSize: 15,
          }}
        />
      </View>
      {catalog.isLoading ? (
        <Loading label="Loading catalog…" />
      ) : (
        <FlatList
          data={projects}
          keyExtractor={(p) => p.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={
            projects.length === 0 ? { flexGrow: 1 } : { paddingBottom: 24, ...readable }
          }
          ListEmptyComponent={
            <Empty
              title={catalog.isError ? "Could not load the catalog" : "No matching boards"}
              hint={
                catalog.isError
                  ? `${(catalog.error as Error).message} — the computer needs to reach fabplane.com.`
                  : q
                    ? "Try a shorter search."
                    : undefined
              }
            />
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: "/catalog/[owner]/[slug]",
                  params: { owner: item.ownerSlug, slug: item.slug },
                })
              }
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                backgroundColor: pressed ? t.panel2 : t.panel,
                borderBottomColor: t.border,
                borderBottomWidth: StyleSheet.hairlineWidth,
                paddingHorizontal: 16,
                paddingVertical: 10,
              })}
            >
              <CatalogThumb uri={client.openSourcePreviewUrl(item.id)} name={item.name} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ color: t.fg, fontSize: 15, fontWeight: "500" }}>
                  {item.name}
                </Text>
                <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>
                  {item.source?.owner ?? item.ownerSlug} / {item.slug}
                  {item.lede ? ` · ${item.lede}` : item.description ? ` · ${item.description}` : ""}
                </Text>
              </View>
              <Text style={{ color: t.muted, fontSize: 16 }}>›</Text>
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}
