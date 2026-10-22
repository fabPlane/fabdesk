import { describe, expect, test } from "bun:test";
import { expandSlashCommand, slashSuggestions } from "./slash-commands";

describe("slash commands", () => {
  test("/parts expands into an off-board parts instruction", () => {
    const out = expandSlashCommand("/parts add a NEMA 17 and an OLED")!;
    expect(out).toContain('load_toolset {"toolset":"project"}');
    expect(out).toContain("parts_search");
    expect(out).toContain("parts_add");
    expect(out).toContain("Request: add a NEMA 17 and an OLED");
  });

  test("/shopping-list expands into a shopping-tools instruction with the request", () => {
    const out = expandSlashCommand("/shopping-list move all passives to LCSC")!;
    expect(out).toContain('load_toolset {"toolset":"shopping"}');
    expect(out).toContain("shopping_list_update");
    expect(out).toContain("Request: move all passives to LCSC");
    const bare = expandSlashCommand("  /shopping-list  ")!;
    expect(bare).toContain("sync it from the BOM");
    expect(expandSlashCommand("/shopping-list\nline two")).toContain("Request: line two");
  });

  test("other text is left alone", () => {
    expect(expandSlashCommand("please /shopping-list")).toBeNull();
    expect(expandSlashCommand("/unknown thing")).toBeNull();
    expect(expandSlashCommand("/shopping-listing")).toBeNull();
    expect(expandSlashCommand("")).toBeNull();
  });

  test("suggestions while typing the command name", () => {
    expect(slashSuggestions("/sh").map((c) => c.name)).toEqual(["shopping-list"]);
    expect(slashSuggestions("/").map((c) => c.name)).toEqual(["parts", "shopping-list"]);
    expect(slashSuggestions("/pa").map((c) => c.name)).toEqual(["parts"]);
    expect(slashSuggestions("/shopping-list x")).toEqual([]);
    expect(slashSuggestions("hello")).toEqual([]);
  });
});
