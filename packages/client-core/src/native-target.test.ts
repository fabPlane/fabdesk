import { expect, test } from "bun:test";
import { nudgeNativePoint, snapNativePoint } from "./native-target";
test("keyboard nudges preserve sub-grid coordinates and never move the other axis", () => {
  expect(nudgeNativePoint({ x: 105.123, y: 100.456789 }, "right", false)).toEqual({ x: 105.223, y: 100.456789 });
  expect(nudgeNativePoint({ x: 105.123456, y: 100.456 }, "up", true)).toEqual({ x: 105.123456, y: 100.446 });
});
test("negative coordinates and opposite keyboard nudges retain exact native precision", () => {
  const point = { x: -10.123456, y: -5.987654 };
  expect(nudgeNativePoint(nudgeNativePoint(point, "left", false), "right", false)).toEqual(point);
  expect(nudgeNativePoint(nudgeNativePoint(point, "up", true), "down", true)).toEqual(point);
});
test("pointer proposals snap both axes to the requested absolute grid", () => {
  expect(snapNativePoint({ x: 105.123, y: 100.456 }, false)).toEqual({ x: 105.1, y: 100.5 });
  expect(snapNativePoint({ x: 105.123, y: 100.456 }, true)).toEqual({ x: 105.12, y: 100.46 });
});

test("dimension snapping uses the fixed board corner as its grid origin", () => {
  expect(snapNativePoint({ x: 115.201, y: 110.876 }, false, { x: 100.123, y: 95.456 })).toEqual({ x: 115.223, y: 110.856 });
});
