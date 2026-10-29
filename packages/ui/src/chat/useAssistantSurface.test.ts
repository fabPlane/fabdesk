import { expect, test } from "bun:test";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { askAboutSurface } from "./useAssistantSurface";

test("requested questions retain each captured source separately from readable prose", () => {
  const before = useUiStore.getState();
  try {
    useUiStore.setState({ activeProjectId: "context-test", activeThreadId: null, drafts: {}, draftBoardContexts: {} });
    const key = newChatDraftKey("context-test"), first = { projectId: "context-test", label: "I/O / PCB finding", details: JSON.stringify({ sourceId: "io", manifestSha256: "a".repeat(64), pointMm: { x: 3, y: 4 } }), priority: 25 };
    const second = { ...first, label: "LCD / Missing schematic", details: JSON.stringify({ sourceId: "lcd", manifestSha256: "b".repeat(64), candidates: ["boards/lcd/main.kicad_sch"] }) };
    useUiStore.getState().setDraft(key, "Keep my question");
    askAboutSurface(first, "Explain this PCB finding.");
    askAboutSurface(second, "Find the matching schematic.");
    askAboutSurface(second, "Find the matching schematic.");
    const state = useUiStore.getState();
    expect(state.drafts[key]).toBe("Keep my question\n\nExplain this PCB finding.\n\nFind the matching schematic.");
    expect(state.draftBoardContexts[key]).toHaveLength(2);
    expect(state.draftBoardContexts[key]?.map(context => JSON.parse(context.instruction).sourceId)).toEqual(["io", "lcd"]);
    expect(state.assistantOpen).toBe(true);
    useUiStore.setState({ activeProjectId: "different-project" });
    askAboutSurface(first, "Stale request");
    expect(useUiStore.getState().drafts[key]).toBe("Keep my question\n\nExplain this PCB finding.\n\nFind the matching schematic.");
  } finally { useUiStore.setState(before); }
});
