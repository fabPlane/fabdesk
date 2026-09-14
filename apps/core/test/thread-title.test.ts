import { expect, test } from "bun:test";
import { threadTitleFrom } from "../src/thread-title";

test("short messages are the title", () => {
  expect(threadTitleFrom("  Say hi in three   words ")).toBe("Say hi in three words");
});

test("long messages keep their opening clause", () => {
  expect(
    threadTitleFrom(
      "Design a PS1 serial dev dongle: a USB-C receptacle (USB 2.0 only, 5.1k CC pull-downs) feeding a CP2102N",
    ),
  ).toBe("Design a PS1 serial dev dongle");
  expect(threadTitleFrom("Build the board. Then route it and run DRC with everything on")).toBe(
    "Build the board",
  );
  expect(
    threadTitleFrom(
      "Now build it, route it, run DRC and fix any errors, then render the top view.",
    ),
  ).toBe("Now build it, route it, run DRC and fix any errors, then…");
});

test("a long clause-less message is cut at a word with an ellipsis", () => {
  const t = threadTitleFrom(
    "please make me a very small blinking led board with a coin cell holder and a slide switch on it",
  );
  expect(t).toBe("please make me a very small blinking led board with a coin…");
  expect(t.length).toBeLessThanOrEqual(61);
});
