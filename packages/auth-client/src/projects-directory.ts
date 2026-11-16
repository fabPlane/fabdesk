import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function isSourceCheckout(path: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    return (
      pkg.name === "fabdesk" &&
      existsSync(join(path, "apps", "core")) &&
      existsSync(join(path, "apps", "desktop"))
    );
  } catch {
    return false;
  }
}

/** Preserve existing workspaces, but never implicitly adopt the app's source checkout. */
export function resolveProjectsDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const explicit = env["FABDESK_PROJECTS_DIR"]?.trim();
  if (explicit) return explicit;
  for (const name of ["fabdesk", "Fabdesk"]) {
    const path = join(home, name);
    try {
      if (statSync(path).isDirectory() && !isSourceCheckout(path)) return path;
    } catch {
      /* No existing workspace at this spelling. */
    }
  }
  const fallback = join(home, "Fabdesk Projects");
  if (isSourceCheckout(fallback))
    throw new Error(
      "The default projects directory is a Fabdesk source checkout. Set FABDESK_PROJECTS_DIR to your projects folder.",
    );
  return fallback;
}
