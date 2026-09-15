/**
 * fabPlane account on this phone. Independent of pairing: the token talks to fabplane.com, not
 * the daemon. Signing in turns on cloud settings; later it is also how the backend will find
 * this device.
 */
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { create } from "zustand";
import {
  fetchCloudSettings,
  overlayCloudSettings,
  putCloudSettings,
  type PasswordCredentials,
} from "@fabdesk/auth-client/browser";
import type { CloudSettings } from "@fabdesk/protocol";
import { fabplaneApiOrigin } from "@/lib/api-origin";
import {
  AccountSession,
  type AccountSnapshot,
  type AccountTokenStore,
  type StoredAccount,
} from "@/lib/account-session";
import { prefsToCloud, reconcilePrefs, type LocalPrefs } from "@/lib/cloud-prefs";
import { isApplyingCloud, usePrefs } from "./prefs";

const ACCOUNT_KEY = "fabdesk.account";

const tokenStore: AccountTokenStore = {
  async read() {
    try {
      const raw = await SecureStore.getItemAsync(ACCOUNT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredAccount;
      return parsed?.version === 1 && typeof parsed.token === "string" ? parsed : null;
    } catch {
      return null;
    }
  },
  async write(account) {
    await SecureStore.setItemAsync(ACCOUNT_KEY, JSON.stringify(account));
  },
  async clear() {
    await SecureStore.deleteItemAsync(ACCOUNT_KEY);
  },
};

function currentPrefs(): LocalPrefs {
  const s = usePrefs.getState();
  return {
    appearance: s.appearance,
    haptics: s.haptics,
    keepAwake: s.keepAwake,
    updatedAt: s.updatedAt,
  };
}

let lastCloud: CloudSettings | null = null;

async function syncPrefsFromCloud(session: AccountSession): Promise<"on" | "local" | "error"> {
  const token = session.token();
  if (!token) return "local";
  try {
    const got = await fetchCloudSettings(fetch, fabplaneApiOrigin(), token);
    if (!got.ok) {
      if (got.status === 401 || got.status === 403) await session.logout();
      return "error";
    }
    lastCloud = got.settings;
    const { next, push } = reconcilePrefs(currentPrefs(), got.settings);
    usePrefs.getState().applyCloud(next);
    if (push) {
      const payload = overlayCloudSettings(lastCloud, prefsToCloud(next));
      const put = await putCloudSettings(fetch, fabplaneApiOrigin(), token, payload);
      if (!put.ok && put.status === 404) return "local";
      if (!put.ok) return "error";
      lastCloud = put.settings;
    }
    return "on";
  } catch {
    return "error";
  }
}

async function pushPrefs(session: AccountSession): Promise<void> {
  const token = session.token();
  if (!token) return;
  try {
    const payload = overlayCloudSettings(lastCloud, prefsToCloud(currentPrefs()));
    const put = await putCloudSettings(fetch, fabplaneApiOrigin(), token, payload);
    if (put.ok) lastCloud = put.settings;
  } catch {
    /* keep the local copy; next sign-in or edit retries */
  }
}

export type CloudStatus = "off" | "on" | "local" | "syncing" | "error";

export interface AccountState {
  snapshot: AccountSnapshot;
  cloud: CloudStatus;
  hydrated: boolean;
  busy: boolean;
  hydrate: () => Promise<void>;
  login: () => Promise<void>;
  loginWithPassword: (credentials: PasswordCredentials) => Promise<void>;
  logout: () => Promise<void>;
  pushPrefs: () => Promise<void>;
}

let session: AccountSession | null = null;
let abortLogin: AbortController | null = null;

function getSession(onState: (snapshot: AccountSnapshot) => void): AccountSession {
  if (session) return session;
  session = new AccountSession({
    apiOrigin: fabplaneApiOrigin(),
    store: tokenStore,
    clientLabel: `fabdesk-mobile ${Platform.OS}`,
    openUrl: (url) => {
      void Linking.openURL(url);
    },
    onState,
  });
  return session;
}

export const useAccount = create<AccountState>((set, get) => ({
  snapshot: { status: "signed_out" },
  cloud: "off",
  hydrated: false,
  busy: false,
  hydrate: async () => {
    const s = getSession((snapshot) => set({ snapshot }));
    const snapshot = await s.load();
    set({ snapshot, hydrated: true, cloud: snapshot.status === "signed_in" ? "syncing" : "off" });
    if (snapshot.status === "signed_in") {
      const cloud = await syncPrefsFromCloud(s);
      set({ cloud: get().snapshot.status === "signed_in" ? cloud : "off" });
    }
  },
  login: async () => {
    abortLogin?.abort();
    abortLogin = new AbortController();
    const s = getSession((snapshot) => set({ snapshot }));
    set({ busy: true, cloud: "off" });
    try {
      const snapshot = await s.login(abortLogin.signal);
      set({ snapshot });
      if (snapshot.status === "signed_in") {
        set({ cloud: "syncing" });
        const cloud = await syncPrefsFromCloud(s);
        set({ cloud });
      }
    } finally {
      set({ busy: false });
    }
  },
  loginWithPassword: async (credentials) => {
    abortLogin?.abort();
    abortLogin = new AbortController();
    const s = getSession((snapshot) => set({ snapshot }));
    set({ busy: true, cloud: "off" });
    try {
      const snapshot = await s.loginWithPassword(credentials, abortLogin.signal);
      set({ snapshot });
      if (snapshot.status === "signed_in") {
        set({ cloud: "syncing" });
        const cloud = await syncPrefsFromCloud(s);
        set({ cloud });
      }
    } finally {
      set({ busy: false });
    }
  },
  logout: async () => {
    abortLogin?.abort();
    abortLogin = null;
    const s = getSession((snapshot) => set({ snapshot }));
    set({ busy: true });
    try {
      set({ snapshot: await s.logout(), cloud: "off" });
    } finally {
      set({ busy: false });
    }
  },
  pushPrefs: async () => {
    const s = session;
    if (!s || s.state().status !== "signed_in") return;
    await pushPrefs(s);
  },
}));

let prefsHooked = false;
export function watchPrefsForCloud(): void {
  if (prefsHooked) return;
  prefsHooked = true;
  usePrefs.subscribe((next, prev) => {
    if (isApplyingCloud()) return;
    if (
      next.appearance === prev.appearance &&
      next.haptics === prev.haptics &&
      next.keepAwake === prev.keepAwake
    ) {
      return;
    }
    void useAccount.getState().pushPrefs();
  });
}
