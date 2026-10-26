import { describe, expect, test } from "bun:test";
import { transcriptsFromEvent, webSpeechAvailable } from "./web-speech";

describe("web speech helpers", () => {
  test("is absent without a constructor", () => {
    expect(webSpeechAvailable({} as typeof globalThis)).toBe(false);
  });

  test("joins interim and final results", () => {
    expect(
      transcriptsFromEvent({
        resultIndex: 0,
        results: [
          { isFinal: true, 0: { transcript: "add a" } },
          { isFinal: false, 0: { transcript: "USB-C jack" } },
        ],
      }),
    ).toEqual({ final: "add a", partial: "USB-C jack" });
  });
});
