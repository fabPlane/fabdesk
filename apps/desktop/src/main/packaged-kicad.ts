import { join } from "node:path";

/** Env so the packaged core finds Resources/kicad without relying only on execPath layout. */
export function packagedKicadEnv(resourcesPath: string): Record<string, string> {
  return { FABDESK_RESOURCES: resourcesPath, FABDESK_BUNDLED_KICAD: join(resourcesPath, "kicad") };
}
