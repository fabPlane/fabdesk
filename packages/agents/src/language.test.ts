import { describe, expect, test } from "bun:test";
import { renderAgentsMd } from "./agents-md";
import {
  LANGUAGE_RULE,
  applyReplyLanguage,
  assertToolArgsPreserveIdentifiers,
  detectMessageLanguage,
  extractDesignIdentifiers,
  identifiersUntouched,
  languageHintBlock,
  resolveReplyLanguage,
} from "./language";

describe("detectMessageLanguage", () => {
  test("Korean hangul", () => {
    expect(detectMessageLanguage("이 보드에서 USB_D+ 넷을 확인해주세요")).toBe("ko");
  });
  test("German function words", () => {
    expect(detectMessageLanguage("Bitte die Schaltung zwischen GND und VCC prüfen")).toBe("de");
  });
  test("Thai script", () => {
    expect(detectMessageLanguage("ช่วยตรวจ net USB_D+ บนบอร์ดนี้หน่อย")).toBe("th");
  });
  test("Japanese kana", () => {
    expect(detectMessageLanguage("このネット USB_D+ を確認してください")).toBe("ja");
  });
  test("identifier-only soup stays English", () => {
    expect(detectMessageLanguage("R1 R2 USB_D+ GND VCC")).toBe("en");
  });
});

describe("resolveReplyLanguage", () => {
  test("Korean message sets Korean hint", () => {
    const resolved = resolveReplyLanguage({
      preference: "match",
      message: "VCC 네트와 USB_D+ 라우팅을 확인해주세요",
    });
    expect(resolved.locale).toBe("ko");
    const applied = applyReplyLanguage(resolved.locale && "VCC 네트와 USB_D+ 라우팅을 확인해주세요", resolved.locale);
    expect(applied.hint).toBe(languageHintBlock("ko"));
    expect(applied.prompt.startsWith("[Reply-language: Korean (ko)]")).toBe(true);
    expect(applied.prompt).toContain("USB_D+");
  });

  test("German message sets German hint", () => {
    const resolved = resolveReplyLanguage({
      preference: "match",
      message: "Bitte die Verbindung von USB_D+ und GND prüfen",
    });
    expect(resolved.locale).toBe("de");
    expect(applyReplyLanguage("x", resolved.locale).hint).toContain("German");
  });

  test("always-language setting wins over the message", () => {
    const resolved = resolveReplyLanguage({
      preference: "ja",
      message: "Please check USB_D+ on this board",
    });
    expect(resolved).toEqual({ locale: "ja", source: "setting" });
  });

  test("thread hint is used when the new message is identifier soup", () => {
    const resolved = resolveReplyLanguage({
      preference: "match",
      message: "R12 USB_D+",
      threadHint: "ko",
    });
    expect(resolved).toEqual({ locale: "ko", source: "thread" });
  });
});

describe("identifier preservation", () => {
  test("USB_D+ keeps the plus sign", () => {
    expect(extractDesignIdentifiers("Check USB_D+ and USB_D- on U12")).toEqual(
      expect.arrayContaining(["USB_D+", "USB_D-", "U12"]),
    );
  });

  test("net names stay in the prompt and in mocked tool args", () => {
    const message = "USB_D+ 와 GND, U12 를 확인해주세요";
    const applied = applyReplyLanguage(message, "ko");
    expect(identifiersUntouched(message, applied.prompt)).toEqual([]);
    const toolArgs = { net: "USB_D+", ref: "U12", connected: "GND" };
    expect(assertToolArgsPreserveIdentifiers(message, toolArgs)).toEqual([]);
    expect(extractDesignIdentifiers(message)).toEqual(expect.arrayContaining(["USB_D+", "GND", "U12"]));
  });

  test("a translated tool arg that drops a net is reported", () => {
    const message = "Route USB_D+ to U12";
    expect(assertToolArgsPreserveIdentifiers(message, { net: "USB D plus", ref: "U12" })).toEqual(["USB_D+"]);
  });
});

describe("system prompt language rule", () => {
  test("AGENTS.md includes the language rule", () => {
    const md = renderAgentsMd({
      projectName: "Blinky",
      toolsMarkdown: "",
      sketches: [],
      board: { layers: 2 },
      mcpServerName: "fabdesk",
    });
    expect(md).toContain("## Language");
    expect(md).toContain("Reply-language");
    expect(md).toContain("Never translate part numbers");
    expect(LANGUAGE_RULE).toContain("Tool-call arguments");
  });
});
