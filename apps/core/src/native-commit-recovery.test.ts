import { expect, test } from "bun:test";
import { CommitDroppedError, CommitRecoveryError } from "@fp-pcb/client";
import { createFpPcbDesign } from "./fp-pcb-design";

for (const recoverable of [true, false])
  test(`native commit error reports ${recoverable ? "confirmed live rollback" : "saved-copy recovery with original session retained"}`, async () => {
    const original = new Error("finalization failed");
    const error = recoverable
      ? new CommitDroppedError("edit", original, "undone")
      : new CommitRecoveryError("edit", original, new Error("newer edit"));
    let calls = 0;
    const design = createFpPcbDesign({
      bridge: () => ({}) as never,
      sessions: {
        ensureProject: async () => {
          calls++;
          throw error;
        },
      } as never,
    });
    let result: unknown;
    try {
      await design.schematicInspect("/original/project");
    } catch (e) {
      result = e;
    }
    expect(calls).toBe(1);
    if (recoverable) expect(result).toBe(error);
    else {
      expect((result as Error).message).toContain("Rollback could not be confirmed");
      expect((result as Error).message).toContain("capability_call");
      expect((result as Error).message).toContain("/original/project/board.kicad_pcb");
      expect((result as Error).message).toContain("does not recover unsaved edits");
    }
  });
