import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../plugins/fabplane");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

describe("fabPlane plugin package", () => {
  test("portable and compatibility hosts receive the same identity, UI and local server", () => {
    const portable = json("plugin.json");
    const compatibility = json(".codex-plugin/plugin.json");
    const claude = json(".claude-plugin/plugin.json");
    expect(portable.name).toBe(compatibility.name);
    expect(portable.name).toBe(claude.name);
    expect(portable.version).toBe(compatibility.version);
    expect(portable.version).toBe(claude.version);
    expect(portable.extensions["com.openai"].interface).toEqual(compatibility.interface);
    const server = json("mcp.json").mcpServers;
    expect(server).toEqual(json(".codex.mcp.json").mcpServers);
    expect(server.fabdesk).toEqual({ command: "fabdesk", args: ["mcp", "--apps"] });
    expect(JSON.stringify(portable)).not.toContain("trycloudflare.com");
  });

  test("installed package contains its branding, onboarding and skills", () => {
    const ext = json("plugin.json").extensions["com.openai"];
    for (const path of [
      ext.onboardingSkill,
      ext.interface.composerIcon,
      ext.interface.logo,
      ext.interface.logoDark,
    ]) {
      expect(path.startsWith("./")).toBe(true);
      expect(resolve(root, path).startsWith(root + "/")).toBe(true);
      expect(existsSync(join(root, path))).toBe(true);
    }
    expect(existsSync(join(root, "skills/fabplane/SKILL.md"))).toBe(true);
    expect(readFileSync(join(root, ext.interface.logo)).subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
  });
});
