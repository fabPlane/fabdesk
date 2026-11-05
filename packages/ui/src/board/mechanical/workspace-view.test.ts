import { expect, test } from "bun:test";
import { parseWorkspaceView, type WorkspaceView } from "./workspace-view";
test("camera recovery rejects corrupt and degenerate positions", () => {
  for (const v of [
    null,
    {},
    { position: [0, 0, 0], target: [0, 0, 0] },
    { position: [0, NaN, 1], target: [0, 0, 0] },
    { position: [0, 1e20, 1], target: [0, 0, 0] },
    { position: [0, 1], target: [0, 0, 0] },
  ])
    expect(parseWorkspaceView(v)).toBeNull();
  const input: WorkspaceView = { position: [1, 2, 3], target: [4, 5, 6] };
  const view = parseWorkspaceView(input)!;
  expect(view).toEqual(input);
  input.position[0] = 99;
  expect(view.position[0]).toBe(1);
});
