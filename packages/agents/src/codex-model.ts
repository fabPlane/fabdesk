import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Display metadata only: do not pin, rewrite, or change the CLI's model selection. */
export function parseCodexConfiguredModel(toml: string): string | undefined {
  try {
    const config = Bun.TOML.parse(toml) as Record<string, unknown>;
    let model = config["model"];
    const profile = config["profile"];
    if (typeof profile === "string" && profile) {
      const profiles = config["profiles"] as Record<string, Record<string, unknown>> | undefined;
      const selected = profiles?.[profile];
      // An invalid selected profile is not a usable default.
      if (!selected || typeof selected !== "object") return undefined;
      model = selected["model"] ?? model;
    }
    return typeof model === "string" && model.trim() ? model.trim() : undefined;
  } catch { return undefined; }
}

/** Same inherited home precedence as codexEnv; no account/session data is read. */
export function readCodexConfiguredModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = resolve(env["CODEX_HOME"] || join(env["HOME"] || env["USERPROFILE"] || homedir(), ".codex"));
  try { return parseCodexConfiguredModel(readFileSync(join(home, "config.toml"), "utf8")); }
  catch { return undefined; }
}
