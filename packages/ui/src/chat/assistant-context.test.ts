import { expect, test } from "bun:test";
import { captureAssistantContext, selectAssistantState } from "./assistant-context";
import { useUiStore } from "../stores/ui";
const now = "2026-10-29T00:00:00Z";
const state = () => ({ ...selectAssistantState(useUiStore.getState()), activeProjectId: "p", workspaceArea: "outputs" as const, boardTab: "renders" as const, assistantSurfaces: {}, settingsOpen: false, sketchOpen: false, inventoryOpen: false, orderFlowOpen: false, activeOpenSourceId: null });
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
