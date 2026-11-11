import { expect, test } from "bun:test";
import { cinemaPoints } from "../src/tools/route";

test("cinema frames turn KiCad's y-down geometry into y up", () => {
  expect(cinemaPoints("trace", [1, 2, 3, 4])).toEqual([1, -2, 3, -4]);
  // A part at the bottom of the board (large KiCad y) must land below one at the top.
  const bottom = cinemaPoints("pad", [0, 45, 2, 47]), top = cinemaPoints("pad", [0, 2, 2, 4]);
  expect(bottom).toEqual([0, -47, 2, -45]);
  expect(bottom[3]!).toBeLessThan(top[1]!);
  expect(cinemaPoints("via", [1, 1, 2, 3])).toEqual([1, -3, 2, -1]);
});
