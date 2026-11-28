import { resolveProjectsDirectory } from "@fabdesk/auth-client";
import { resolve } from "node:path";

/** Both native bridges report their workspace in the form returned by path.resolve. */
export function desktopProjectsDirectory(env: NodeJS.ProcessEnv): string {
  return resolve(resolveProjectsDirectory(env));
}

/** An installer may reopen the app from a different working directory. */
export function pinCustomProjectsDirectory(env: NodeJS.ProcessEnv): void {
  if (env.FABDESK_PROJECTS_DIR?.trim()) {
    env.FABDESK_PROJECTS_DIR = desktopProjectsDirectory(env);
  }
}
