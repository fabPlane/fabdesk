import { describe, expect, test } from "bun:test";
import type { ProjectPartsFile } from "@fabdesk/protocol";
import { bomPartsState, planAddOffboard } from "./ProjectBomPanel";

const existing: ProjectPartsFile = {
  schema: 1,
  parts: [{ id: "line_keep", catalogId: "nema-17-stepper", ref: "M1", name: "NEMA 17", kind: "motor", qty: 2 }],
};
const query = (over: Partial<Parameters<typeof bomPartsState>[0]>) => ({
  data: undefined,
  parseError: null,
  isError: false,
  ...over,
});

describe("bomPartsState / planAddOffboard", () => {
  test("a confirmed-absent file starts empty and Add creates it", () => {
    const state = bomPartsState(query({ data: null }));
    expect(state).toMatchObject({ status: "ok", exists: false });
    const next = planAddOffboard(state, "sg90-servo", 1, () => "line_new");
    expect(next?.parts.map((p) => p.id)).toEqual(["line_new"]);
  });

  test("Add appends to an existing schema-1 file", () => {
    const state = bomPartsState(query({ data: existing }));
    const next = planAddOffboard(state, "sg90-servo", 3, () => "line_new");
    expect(next?.parts.map((p) => p.id)).toEqual(["line_keep", "line_new"]);
    expect(next?.parts[1]?.qty).toBe(3);
  });

  test("an existing unsupported-schema file cannot be overwritten by Add", () => {
    const state = bomPartsState(query({ data: { schema: 2, parts: [{ id: "future" }] } }));
    expect(state.status).toBe("error");
    if (state.status === "error") expect(state.message).toContain("unsupported schema 2");
    expect(planAddOffboard(state, "sg90-servo", 1)).toBeNull();
  });

  test("a failed initial read cannot be overwritten by Add", () => {
    const state = bomPartsState(query({ isError: true, error: new Error("500 Internal Server Error") }));
    expect(state.status).toBe("error");
    if (state.status === "error") expect(state.message).toContain("500");
    expect(planAddOffboard(state, "sg90-servo", 1)).toBeNull();
  });

  test("unparsable JSON and schema-1 files with bad lines are errors too", () => {
    expect(bomPartsState(query({ data: null, parseError: "Unexpected token" })).status).toBe("error");
    const bad = bomPartsState(query({ data: { schema: 1, parts: [{ id: 3 }] } }));
    expect(bad.status).toBe("error");
    expect(planAddOffboard(bad, "sg90-servo", 1)).toBeNull();
  });
});
