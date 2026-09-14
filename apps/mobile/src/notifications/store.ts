/**
 * What the phone remembers about notifications: the master switch, the four §4.1 prefs, the Expo
 * push token it last obtained, which paired daemons hold that token, and the dedupe window.
 *
 * Separate from `state/prefs.ts` because this state is not purely cosmetic — `registered` is a
 * ledger of what other machines were told, and `seenKeys` is what keeps a run that arrives both
 * by push and by the live socket from showing twice.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_NOTIFICATION_PREFS,
  rememberKey,
  type NotificationPrefs,
} from "../lib/notification-payload";
import { jsonStorage } from "../state/storage";

export interface NotificationState {
  /** "Notify me when runs finish". Off until the user turns it on; the OS prompt happens then. */
  enabled: boolean;
  prefs: NotificationPrefs;
  /** `ExponentPushToken[…]`, or null when this build cannot get one (no EAS project, simulator). */
  pushToken: string | null;
  /** Connection id → fingerprint of the registration that daemon last accepted. */
  registered: Record<string, string>;
  /** Dedupe keys of notifications already shown, oldest first, capped at 100. */
  seenKeys: string[];
  setEnabled: (enabled: boolean) => void;
  setPref: <K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K]) => void;
  setPushToken: (token: string | null) => void;
  noteRegistered: (connectionId: string, fingerprint: string | null) => void;
  /** Records a key; false when it was already there (show nothing). */
  markSeen: (key: string) => boolean;
}

export function registrationFingerprint(token: string, prefs: NotificationPrefs): string {
  return `${token}|${Number(prefs.onDone)}${Number(prefs.onFailed)}${Number(prefs.onNeedsInput)}${Number(prefs.onJobs)}`;
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set, get) => ({
      enabled: false,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS },
      pushToken: null,
      registered: {},
      seenKeys: [],
      setEnabled: (enabled) => set({ enabled }),
      setPref: (key, value) => set((s) => ({ prefs: { ...s.prefs, [key]: value } })),
      setPushToken: (pushToken) => set({ pushToken }),
      noteRegistered: (connectionId, fingerprint) =>
        set((s) => {
          const { [connectionId]: _old, ...rest } = s.registered;
          void _old;
          return { registered: fingerprint ? { ...rest, [connectionId]: fingerprint } : rest };
        }),
      markSeen: (key) => {
        if (get().seenKeys.includes(key)) return false;
        set((s) => ({ seenKeys: rememberKey(s.seenKeys, key) }));
        return true;
      },
    }),
    {
      name: "fabdesk.notifications",
      storage: jsonStorage(),
      partialize: ({ enabled, prefs, pushToken, registered, seenKeys }) => ({
        enabled,
        prefs,
        pushToken,
        registered,
        seenKeys,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<NotificationState>;
        const prefs = { ...current.prefs };
        for (const k of Object.keys(prefs) as Array<keyof NotificationPrefs>) {
          if (typeof p.prefs?.[k] === "boolean") prefs[k] = p.prefs[k];
        }
        return {
          ...current,
          enabled: typeof p.enabled === "boolean" ? p.enabled : current.enabled,
          prefs,
          pushToken: typeof p.pushToken === "string" ? p.pushToken : null,
          registered:
            p.registered && typeof p.registered === "object"
              ? Object.fromEntries(
                  Object.entries(p.registered).filter(([, v]) => typeof v === "string"),
                )
              : {},
          seenKeys: Array.isArray(p.seenKeys)
            ? p.seenKeys.filter((k): k is string => typeof k === "string").slice(-100)
            : [],
        };
      },
    },
  ),
);
