import { describe, expect, test } from "bun:test";
import {
  isSlashDraft,
  parseSlashCommand,
  slashBlockedReason,
  slashSuggestions,
  slashToast,
  SLASH_COMMANDS,
} from "./slash-commands";

describe("isSlashDraft", () => {
  test("a leading slash on one line", () => {
    expect(isSlashDraft("/")).toBe(true);
    expect(isSlashDraft("/render top")).toBe(true);
    expect(isSlashDraft("render")).toBe(false);
    expect(isSlashDraft(" /render")).toBe(false);
    expect(isSlashDraft("/render\nand more")).toBe(false);
  });
});

describe("parseSlashCommand", () => {
  test("render defaults to top and accepts bottom", () => {
    const top = parseSlashCommand("/render");
    expect(top.ok && top.command).toMatchObject({
      tool: "render",
      args: { view: "top" },
      text: "/render top",
      progressLabel: "Rendering top…",
    });
    const bottom = parseSlashCommand("/render bottom");
    expect(bottom.ok && bottom.command.args).toEqual({ view: "bottom" });
  });

  test("argument-less commands map to their tool kinds", () => {
    for (const [text, tool] of [
      ["/route", "route"],
      ["/drc", "drc"],
      ["/erc", "erc"],
      ["/build", "build"],
    ] as const) {
      const r = parseSlashCommand(text);
      expect(r.ok && r.command.tool).toBe(tool);
      expect(r.ok && r.command.args).toEqual({});
    }
  });

  test("export needs a kind and spells the tool name out", () => {
    const r = parseSlashCommand("/export gerbers");
    expect(r.ok && r.command).toMatchObject({
      tool: "export_gerbers",
      doneLabel: "Exported gerbers",
    });
    const stencil = parseSlashCommand("/export stencil");
    expect(stencil.ok && stencil.command).toMatchObject({
      tool: "export_stencil",
      doneLabel: "Exported stencil",
    });
    const laser = parseSlashCommand("/export laser_stencil");
    expect(laser.ok && laser.command).toMatchObject({
      tool: "export_laser_stencil",
      doneLabel: "Exported laser_stencil",
    });
    const missing = parseSlashCommand("/export");
    expect(missing).toMatchObject({ ok: false, partial: true });
    expect(!missing.ok && missing.error).toContain("gerbers");
  });

  test("case does not matter, extra whitespace does not matter", () => {
    const r = parseSlashCommand("/Render   BOTTOM ");
    expect(r.ok && r.command.text).toBe("/render bottom");
  });

  test("rejects unknown commands, telling partial from hopeless", () => {
    expect(parseSlashCommand("/ren")).toMatchObject({ ok: false, partial: true });
    expect(parseSlashCommand("/zzz")).toMatchObject({ ok: false, partial: false });
    expect(parseSlashCommand("/")).toMatchObject({ ok: false, partial: true });
    expect(parseSlashCommand("hello")).toMatchObject({ ok: false, partial: false });
  });

  test("rejects bad or surplus arguments", () => {
    expect(parseSlashCommand("/route now")).toMatchObject({ ok: false, partial: false });
    expect(parseSlashCommand("/render side")).toMatchObject({ ok: false, partial: false });
    expect(parseSlashCommand("/render bo")).toMatchObject({ ok: false, partial: true });
    expect(parseSlashCommand("/export gerbers zip")).toMatchObject({ ok: false, partial: false });
  });
});

describe("slashSuggestions", () => {
  test("a bare slash lists every command, defaults filled in", () => {
    const s = slashSuggestions("/");
    expect(s.map((x) => x.usage)).toEqual(SLASH_COMMANDS.map((c) => c.usage));
    expect(s[0]!.command.text).toBe("/render top");
    expect(s.find((x) => x.usage.startsWith("/export"))!.command.arg).toBeNull();
  });

  test("filters by the typed prefix", () => {
    expect(slashSuggestions("/r").map((x) => x.command.name)).toEqual(["render", "route"]);
    expect(slashSuggestions("/ro").map((x) => x.command.name)).toEqual(["route"]);
    expect(slashSuggestions("/x")).toEqual([]);
  });

  test("a complete name followed by a space lists its arguments, filtered as they are typed", () => {
    expect(slashSuggestions("/render ").map((x) => x.usage)).toEqual([
      "/render top",
      "/render bottom",
    ]);
    expect(slashSuggestions("/render ").map((x) => x.description)).toEqual([
      "Render the board to a PNG (default)",
      "Render the board to a PNG",
    ]);
    expect(slashSuggestions("/export g").map((x) => x.usage)).toEqual(["/export gerbers"]);
    expect(slashSuggestions("/export q")).toEqual([]);
  });

  test("a command without arguments still offers itself once typed in full", () => {
    expect(slashSuggestions("/route").map((x) => x.usage)).toEqual(["/route"]);
    expect(slashSuggestions("/route ").map((x) => x.usage)).toEqual(["/route"]);
    expect(slashSuggestions("/route x")).toEqual([]);
  });

  test("nothing for plain text or a third word", () => {
    expect(slashSuggestions("hi")).toEqual([]);
    expect(slashSuggestions("/render top extra")).toEqual([]);
  });
});

describe("slashToast", () => {
  const cmd = parseSlashCommand("/render top");
  const command = cmd.ok ? cmd.command : (undefined as never);

  test("running points at Jobs, done ticks, failed carries the first line of the error", () => {
    expect(slashToast(command, { status: "running" })).toEqual({
      text: "Rendering top… · watch in Jobs",
      tone: "muted",
      jobsHint: true,
    });
    expect(slashToast(command, { status: "done" })).toMatchObject({
      text: "Rendered top ✓",
      tone: "success",
    });
    expect(
      slashToast(command, { status: "failed", error: "kicad-cli not found\nstack" }),
    ).toMatchObject({
      text: "/render top failed: kicad-cli not found",
      tone: "danger",
    });
    expect(slashToast(command, { status: "idle" })).toBeNull();
  });
});

test("slashBlockedReason only allows project threads", () => {
  expect(slashBlockedReason(undefined)).toContain("Loading");
  expect(slashBlockedReason({ projectId: null })).toContain("no project");
  expect(slashBlockedReason({ projectId: "p1" })).toBeNull();
});
