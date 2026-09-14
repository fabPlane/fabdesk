import { describe, expect, test } from "bun:test";
import { layoutMode } from "./layout-mode";

describe("layoutMode", () => {
  test("phones are single-pane in both orientations", () => {
    expect(layoutMode({ width: 440, height: 956 })).toBe("phone"); // iPhone 17 Pro Max portrait
    expect(layoutMode({ width: 956, height: 440 })).toBe("phone"); // … landscape
    expect(layoutMode({ width: 538, height: 300 })).toBe("phone"); // AYN Thor landscape
    expect(layoutMode({ width: 375, height: 812 })).toBe("phone");
  });

  test("tablets are two-pane in both orientations", () => {
    expect(layoutMode({ width: 744, height: 1133 })).toBe("wide"); // iPad mini portrait
    expect(layoutMode({ width: 1133, height: 744 })).toBe("wide");
    expect(layoutMode({ width: 1024, height: 1366 })).toBe("wide"); // iPad Pro 12.9
  });

  test("a narrow split-view slot on a tablet goes back to one pane", () => {
    expect(layoutMode({ width: 320, height: 1133 })).toBe("phone");
    expect(layoutMode({ width: 699, height: 1133 })).toBe("phone");
    expect(layoutMode({ width: 700, height: 1133 })).toBe("wide");
  });

  test("a short, wide window (Stage Manager) stays single-pane", () => {
    expect(layoutMode({ width: 900, height: 500 })).toBe("phone");
    expect(layoutMode({ width: 900, height: 600 })).toBe("wide");
  });

  test("nonsense sizes are phones", () => {
    expect(layoutMode({ width: 0, height: 0 })).toBe("phone");
    expect(layoutMode({ width: Number.NaN, height: 1000 })).toBe("phone");
  });
});
