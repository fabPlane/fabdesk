/**
 * DRC and ERC findings for a project, grouped by severity. Tap one and its items are ringed on
 * the top render (DRC only — ERC positions are schematic coordinates, which no render shows).
 * Ported from packages/ui/src/board/DrcTab.tsx; the parsing lives in src/lib/drc.ts.
 */
import { useProject, useProjectJson, useProjectText, useRunTool } from "@fabdesk/client-core";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import { DrcRender } from "@/components/DrcRender";
import { usePullRefresh } from "@/components/pull-refresh";
import { Badge, Button, Card, Empty, Loading, Screen, readable } from "@/components/ui";
import {
  boardOutlineBbox,
  groupBySeverity,
  normalizeReport,
  summarize,
  type Violation,
} from "@/lib/drc";
import { galleryRenders, renderView } from "@/lib/renders";
import { useTheme } from "@/theme";

/** A .kicad_pcb past this is not fetched just to find its outline. */
const MAX_PCB_BYTES = 8_000_000;

export default function DrcScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const project = useProject(id ?? null);
  const drc = useProjectJson(id ?? null, "reports/drc.json");
  const erc = useProjectJson(id ?? null, "reports/erc.json");
  const pcb = useMemo(
    () =>
      project.data?.files.find((f) => f.path.endsWith(".kicad_pcb") && f.size <= MAX_PCB_BYTES) ??
      null,
    [project.data],
  );
  const pcbText = useProjectText(id ?? null, pcb?.path ?? null);
  const outline = useMemo(
    () => (typeof pcbText.data === "string" ? boardOutlineBbox(pcbText.data) : null),
    [pcbText.data],
  );
  const topRender = useMemo(
    () => galleryRenders(project.data).find((f) => renderView(f.path) === "top") ?? null,
    [project.data],
  );
  const rows = useMemo(
    () => [...normalizeReport(drc.data, "drc"), ...normalizeReport(erc.data, "erc")],
    [drc.data, erc.data],
  );
  const sections = useMemo(
    () => groupBySeverity(rows).map((s) => ({ title: s.severity, data: s.violations })),
    [rows],
  );
  const summary = useMemo(() => summarize(rows), [rows]);
  const [selected, setSelected] = useState<Violation | null>(null);
  const tool = useRunTool();
  const refreshControl = usePullRefresh(() =>
    Promise.all([project.refetch(), drc.refetch(), erc.refetch()]),
  );

  if (project.isLoading || drc.isLoading || erc.isLoading)
    return <Loading label="Loading reports…" />;
  if (!id || !project.data) return <Screen>{null}</Screen>;

  const noReports = drc.data === null && erc.data === null;
  const running = tool.state.status === "running";
  const runThen = (kind: "drc" | "erc") => () =>
    void tool
      .run(kind, { projectId: id })
      .then(() => Promise.all([drc.refetch(), erc.refetch(), project.refetch()]));

  const header = (
    <View style={{ gap: 12 }}>
      {topRender ? (
        <Card>
          <DrcRender
            projectId={id}
            entry={topRender}
            outline={outline}
            items={selected?.source === "drc" ? selected.items : []}
          />
          {selected ? (
            <View style={{ marginTop: 10, gap: 4 }}>
              <Text style={{ color: t.fg, fontSize: 13, fontWeight: "600" }}>
                {selected.description}
              </Text>
              {selected.source === "erc" ? (
                <Text style={{ color: t.muted, fontSize: 11 }}>
                  Schematic finding — positions are on the sheet, not the board.
                </Text>
              ) : null}
              {selected.items.length === 0 ? (
                <Text style={{ color: t.muted, fontSize: 12 }}>No item details.</Text>
              ) : null}
              {selected.items.map((it, i) => (
                <View key={i} style={{ flexDirection: "row", gap: 6 }}>
                  <Text style={{ color: t.accent, fontFamily: "Menlo", fontSize: 11 }}>
                    {it.pos
                      ? `${i + 1} (${it.pos.x.toFixed(2)}, ${it.pos.y.toFixed(2)}) mm`
                      : `${i + 1} (no position)`}
                  </Text>
                  <Text style={{ color: t.fg, fontSize: 12, flex: 1 }}>{it.description}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={{ color: t.muted, fontSize: 12, marginTop: 8 }}>
              {rows.length
                ? "Tap a finding to ring it on the board."
                : "Nothing to ring — the board passes."}
            </Text>
          )}
        </Card>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button
          title={running ? "Running…" : "Run DRC"}
          onPress={runThen("drc")}
          disabled={running}
          style={{ flex: 1 }}
        />
        <Button
          title={running ? "Running…" : "Run ERC"}
          onPress={runThen("erc")}
          disabled={running}
          style={{ flex: 1 }}
        />
      </View>
      {tool.state.status === "failed" ? (
        <Text style={{ color: t.danger, fontSize: 12 }}>{tool.state.error}</Text>
      ) : null}
    </View>
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: `DRC · ${project.data.name}` }} />
      <SectionList
        sections={sections}
        keyExtractor={(v, i) => `${v.source}:${v.type}:${i}`}
        refreshControl={refreshControl}
        stickySectionHeadersEnabled
        contentContainerStyle={{ padding: 14, paddingBottom: 32, gap: 0, ...readable }}
        ListHeaderComponent={<View style={{ marginBottom: 12 }}>{header}</View>}
        ListEmptyComponent={
          <Empty
            title={noReports ? "No DRC/ERC reports" : "No violations"}
            hint={
              noReports
                ? "Run DRC after routing; reports land in reports/drc.json and reports/erc.json."
                : "The board passes every rule in the current reports."
            }
          />
        }
        renderSectionHeader={({ section }) => (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: t.bg,
              paddingVertical: 8,
            }}
          >
            <Text
              style={{
                color: t.muted,
                fontSize: 11,
                fontWeight: "700",
                textTransform: "uppercase",
                letterSpacing: 0.6,
              }}
            >
              {section.title}
            </Text>
            <Badge label={String(section.data.length)} tone={toneFor(section.title)} />
          </View>
        )}
        renderItem={({ item }) => {
          const active = item === selected;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => setSelected(active ? null : item)}
              style={{
                backgroundColor: active ? t.panel2 : t.panel,
                borderColor: active ? t.accent : t.border,
                borderWidth: StyleSheet.hairlineWidth,
                borderRadius: 10,
                padding: 10,
                marginBottom: 6,
                gap: 3,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Badge label={item.source.toUpperCase()} />
                <Text
                  style={{ color: t.muted, fontFamily: "Menlo", fontSize: 11, flex: 1 }}
                  numberOfLines={1}
                >
                  {item.type}
                </Text>
                {item.items.some((it) => it.pos) && item.source === "drc" ? (
                  <Text style={{ color: t.muted, fontSize: 11 }}>◎</Text>
                ) : null}
              </View>
              <Text style={{ color: t.fg, fontSize: 13 }}>{item.description}</Text>
              {item.items[0] ? (
                <Text
                  style={{ color: t.muted, fontSize: 11 }}
                  numberOfLines={active ? undefined : 1}
                >
                  {item.items.map((it) => it.description).join(" · ")}
                </Text>
              ) : null}
            </Pressable>
          );
        }}
        ListFooterComponent={
          rows.length ? (
            <Text style={{ color: t.muted, fontSize: 12, paddingVertical: 12 }}>
              {summary.errors} error{summary.errors === 1 ? "" : "s"}, {summary.warnings} warning
              {summary.warnings === 1 ? "" : "s"}
              {summary.excluded ? `, ${summary.excluded} excluded` : ""}
            </Text>
          ) : null
        }
      />
    </Screen>
  );
}

function toneFor(severity: string): "danger" | "warning" | "default" {
  return severity === "error" ? "danger" : severity === "warning" ? "warning" : "default";
}
