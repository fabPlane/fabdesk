import { describe, expect, test } from "bun:test";
import { FpPcbSessions, type ProjectSession } from "./fp-pcb-session";

function sessionsWithSchematic(state: boolean | undefined | null) {
  const sessions = new FpPcbSessions(() => ({}) as never);
  sessions.session = async () =>
    ({
      kicad: {
        currentSchematic: async () => (state === null ? null : { modified: async () => state }),
      },
    }) as unknown as ProjectSession;
  return sessions;
}

describe("placement schematic guard", () => {
  test("allows a saved schematic or no open schematic", async () => {
    await sessionsWithSchematic(false).assertSchematicSaved("/p");
    await sessionsWithSchematic(null).assertSchematicSaved("/p");
  });
  test("rejects unsaved or unmeasurable state without saving or closing the schematic", async () => {
    for (const state of [true, undefined])
      await expect(sessionsWithSchematic(state).assertSchematicSaved("/p")).rejects.toThrow(
        "save the open schematic",
      );
  });
});
