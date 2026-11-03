import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ReasoningEffort } from "@fabdesk/protocol";

/** Read only public model capabilities from the CLI's locally cached catalog. */
export function parseCodexModelEfforts(value: unknown): Record<string, ReasoningEffort[]> {
  const result: Record<string, ReasoningEffort[]> = Object.create(null);
  const rows = (value as { models?: unknown } | null)?.models;
  if (!Array.isArray(rows)) return result;
  for (const row of rows) {
    if (typeof row?.slug !== "string" || !Array.isArray(row.supported_reasoning_levels)) continue;
    result[row.slug] = row.supported_reasoning_levels.flatMap((level: { effort?: unknown } | null) => {
      const parsed = ReasoningEffort.safeParse(level?.effort);
      return parsed.success ? [parsed.data] : [];
    });
  }
  return result;
}

export function readCodexModelEfforts(env: NodeJS.ProcessEnv = process.env): Record<string, ReasoningEffort[]> {
  const home = resolve(env["CODEX_HOME"] || join(env["HOME"] || env["USERPROFILE"] || homedir(), ".codex"));
  try { return parseCodexModelEfforts(JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8"))); }
  catch { return {}; }
}

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
