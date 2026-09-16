/**
 * One catalog board: hero render, what it is, and Remix — which clones it on the computer as a
 * new project (`POST /opensource/projects/:owner/:slug/remix`) and opens that project here. Port
 * of packages/ui/src/opensource/OpenSourceView.tsx.
 */
import { useCoreClient, useOpenSourceProject, useRemixOpenSource } from "@fabdesk/client-core";
import { Image } from "expo-image";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { CatalogThumb } from "@/components/CatalogThumb";
import { Badge, Button, Card, Empty, Loading, Screen, readable } from "@/components/ui";
import { useTheme } from "@/theme";

export default function CatalogProjectScreen() {
  const { owner, slug } = useLocalSearchParams<{ owner: string; slug: string }>();
  const id = owner && slug ? `${owner}/${slug}` : null;
  const t = useTheme();
  const client = useCoreClient();
  const project = useOpenSourceProject(id);
  const remix = useRemixOpenSource();
  const [heroFailed, setHeroFailed] = useState(false);
  const entry = project.data;

  if (project.isLoading) return <Loading label="Loading board…" />;
  if (!id || !entry) {
    return (
      <Screen>
        <Stack.Screen options={{ title: "Board" }} />
        <Empty
          title="Could not load this board"
          hint={project.isError ? (project.error as Error).message : undefined}
        />
      </Screen>
    );
  }

  const onRemix = () => {
    if (remix.isPending) return;
    remix
      .mutateAsync(id)
      .then((result) => {
        // Replace, so Back from the new project lands on the catalog list, not on this page.
        router.replace({ pathname: "/project/[id]", params: { id: result.project.id } });
      })
      .catch((e: unknown) =>
        Alert.alert("Remix failed", e instanceof Error ? e.message : String(e)),
      );
  };

  const hero = client.openSourcePreviewUrl(id, "hero");
  const source = entry.source?.owner ?? entry.ownerSlug;

  return (
    <Screen>
      <Stack.Screen options={{ title: entry.name }} />
      <ScrollView contentContainerStyle={{ padding: 14, gap: 14, ...readable }}>
        <View
          style={{
            width: "100%",
            aspectRatio: 4 / 3,
            borderRadius: 12,
            backgroundColor: t.panel2,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {hero && !heroFailed ? (
            <Image
              source={{ uri: hero }}
              contentFit="contain"
              transition={150}
              style={{ width: "100%", height: "100%" }}
              onError={() => setHeroFailed(true)}
              accessibilityLabel={`${entry.name} 3D preview`}
            />
          ) : (
            <View style={{ alignItems: "center", gap: 8 }}>
              <CatalogThumb uri="" name={entry.name} size={64} radius={12} />
              <Text style={{ color: t.muted, fontSize: 13 }}>No 3D preview yet.</Text>
            </View>
          )}
        </View>

        <View style={{ gap: 4 }}>
          <Text style={{ color: t.fg, fontSize: 20, fontWeight: "700" }}>{entry.name}</Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>
            {source} / {entry.slug}
            {entry.source?.license ? ` · ${entry.source.license}` : ""}
          </Text>
          {entry.tags?.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
              {entry.tags.map((tag) => (
                <Badge key={tag} label={tag} />
              ))}
            </View>
          ) : null}
        </View>

        <Button
          title={remix.isPending ? "Cloning on the computer…" : "Remix into a new project"}
          variant="primary"
          disabled={remix.isPending}
          onPress={onRemix}
        />
        <Text style={{ color: t.muted, fontSize: 12, marginTop: -6 }}>
          The daemon clones the repository next to your other projects and imports the board.
        </Text>

        {entry.lede || entry.description ? (
          <Card>
            <Text style={{ color: t.fg, fontSize: 14, lineHeight: 20 }}>
              {entry.lede ?? entry.description}
            </Text>
          </Card>
        ) : null}
        {entry.overview ? (
          <Card>
            <Text style={{ color: t.fg, fontSize: 14, lineHeight: 20 }}>{entry.overview}</Text>
          </Card>
        ) : null}
        {entry.highlights?.length ? (
          <Card>
            <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", marginBottom: 6 }}>
              Highlights
            </Text>
            {entry.highlights.map((h, i) => (
              <Text key={i} style={{ color: t.fg, fontSize: 14, lineHeight: 20 }}>
                • {h}
              </Text>
            ))}
          </Card>
        ) : null}
        {entry.source?.url || entry.homepageUrl ? (
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(entry.source?.url ?? entry.homepageUrl!)}
          >
            <Text style={{ color: t.accent, fontSize: 13 }}>
              {entry.source?.url ?? entry.homepageUrl}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
