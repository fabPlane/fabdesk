import { expect, test } from "bun:test";
import { captureAssistantContext, selectAssistantState } from "./assistant-context";
import { useUiStore } from "../stores/ui";
const now = "2026-10-29T00:00:00Z";
const state = (): ReturnType<typeof selectAssistantState> => ({ ...selectAssistantState(useUiStore.getState()), activeProjectId: "p", workspaceArea: "outputs" as const, boardTab: "renders" as const, assistantSurfaces: {}, settingsOpen: false, sketchOpen: false, inventoryOpen: false, orderFlowOpen: false, activeOpenSourceId: null });
test("context follows mounted preview priority and ignores another project's selections", () => {
  const snapshot = state();
  snapshot.assistantSurfaces = { library: { projectId: "p", label: "Library", details: "2 selected", priority: 5 }, preview: { projectId: "p", label: "Preview · pcb.svg", details: "boards/io/renders/pcb.svg", priority: 40 }, other: { projectId: "other", label: "Other PCB", details: "private source", priority: 100 } };
  const first = captureAssistantContext(snapshot, undefined, true, [], now);
  expect(first.label).toBe("Preview · pcb.svg"); expect(first.details).toContain("boards/io/renders/pcb.svg"); expect(first.details).not.toContain("private source"); expect(first.capturedAt).toBe(now);
  delete (snapshot.assistantSurfaces as Record<string, unknown>).preview;
  expect(captureAssistantContext(snapshot, undefined, true, [], now).label).toBe("Library");
});
test("Settings context replaces hidden page selection and oversized details stay bounded valid data", () => {
  const snapshot = state(); snapshot.settingsOpen = true; snapshot.settingsSection = "kicad";
  snapshot.assistantSurfaces = { page: { projectId: "p", label: "Old output", details: '"'.repeat(30000), priority: 5 } };
  expect(captureAssistantContext(snapshot, undefined, false, [], now).label).toBe("Settings / kicad");
  snapshot.settingsOpen = false;
  const context = captureAssistantContext(snapshot, undefined, false, [{ label: "Attached", instruction: '"'.repeat(20000) }], now);
  expect(context.details.length).toBeLessThanOrEqual(16000); expect(() => JSON.parse(context.details)).not.toThrow();
});


test("a settings window excludes a hidden board finding and follows section navigation", () => {
  const snapshot = state();
  snapshot.workspaceArea = "boards" as typeof snapshot.workspaceArea;
  snapshot.boardTab = "pcb" as typeof snapshot.boardTab;
  snapshot.rootFinding = { projectId: "p", description: "Hidden PCB finding", itemDescription: "R1", point: { x: 1, y: 2 }, sourceSha256: "a".repeat(64) } as NonNullable<typeof snapshot.rootFinding>;
  const sources = { projectId: "p", mode: "single" } as Parameters<typeof captureAssistantContext>[1];
  expect(captureAssistantContext(snapshot, sources, false).details).toContain("Hidden PCB finding");
  snapshot.settingsOpen = true;
  snapshot.settingsSection = "voice";
  const context = captureAssistantContext(snapshot, sources, false);
  expect(context.label).toBe("Settings / voice");
  expect(context.details).not.toContain("Hidden PCB finding");
  snapshot.settingsSection = "router";
  expect(captureAssistantContext(snapshot, sources, false).label).toBe("Settings / router");
});


test("secondary windows select only their own context and keep catalog identity", () => {
  const snapshot = state();
  snapshot.assistantSurfaces = {
    old: { projectId: "p", label: "Hidden board", details: "old finding", priority: 100 },
    inventory: { projectId: "p", scope: "inventory", label: "Parts inventory", details: "Service check failed", priority: 10 },
    catalog: { projectId: "p", scope: "catalog", label: "Catalog / Sensor", details: "Preview only", priority: 10 },
  };
  snapshot.inventoryOpen = true;
  const inventory = captureAssistantContext(snapshot, undefined, false);
  expect(inventory.label).toBe("Parts inventory");
  expect(inventory.details).toContain("Service check failed");
  expect(inventory.details).not.toContain("old finding");
  snapshot.inventoryOpen = false; snapshot.activeOpenSourceId = "catalog-sensor";
  const catalog = captureAssistantContext(snapshot, undefined, false);
  expect(catalog.label).toBe("Catalog / Sensor");
  expect(JSON.parse(catalog.details).catalogProjectId).toBe("catalog-sensor");
});

test("Home context identifies a new idea rather than an imaginary PCB", () => {
  const snapshot = { ...state(), activeProjectId: null, workspaceArea: "boards" as const, boardTab: "pcb" as const };
  const context = captureAssistantContext(snapshot, undefined, false);
  expect(context.projectId).toBeNull();
  expect(context.label).toBe("New idea");
  expect(context.details).not.toContain("Boards / PCB");
});
