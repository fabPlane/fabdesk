import type { CloudSettings } from "@fabdesk/protocol";
import { mergeCloudSettings } from "@fabdesk/auth-client/browser";
import type { Appearance } from "@/state/prefs";

export type LocalPrefs = {
  appearance: Appearance;
  haptics: boolean;
  keepAwake: boolean;
  updatedAt: number;
};

export function prefsToCloud(prefs: LocalPrefs): CloudSettings {
  return {
    schema: 1,
    updatedAt: prefs.updatedAt,
    appearance: prefs.appearance,
    haptics: prefs.haptics,
    keepAwake: prefs.keepAwake,
  };
}

export function cloudToPrefs(cloud: CloudSettings, fallback: LocalPrefs): LocalPrefs {
  return {
    appearance: cloud.appearance ?? fallback.appearance,
    haptics: typeof cloud.haptics === "boolean" ? cloud.haptics : fallback.haptics,
    keepAwake: typeof cloud.keepAwake === "boolean" ? cloud.keepAwake : fallback.keepAwake,
    updatedAt: cloud.updatedAt,
  };
}

export function reconcilePrefs(
  local: LocalPrefs,
  remote: CloudSettings | null,
): { next: LocalPrefs; push: boolean } {
  const merged = mergeCloudSettings(prefsToCloud(local), remote);
  return { next: cloudToPrefs(merged.next, local), push: merged.push };
}
