import { expect, test } from "bun:test";
import { act } from "react";
import { CoreClient, CoreProvider, nullHost, useAuthStore, type HostAdapter } from "@fabdesk/client-core";
import type { UpdateCheckResult, UpdateDownloadState } from "@fabdesk/protocol";
// @ts-expect-error The test-only root jsdom dependency has no type declarations.
import { JSDOM } from "jsdom";
import { LoginScreen } from "./LoginScreen";

const update: UpdateCheckResult = {
  checkedAt: "2026-11-26T00:00:00.000Z",
  currentVersion: "0.4.24",
  latest: {
    schema: 1,
    version: "0.4.26",
    tag: "v0.4.26",
    channel: "public",
    commit: "abc",
    publishedAt: "2026-11-26T00:00:00.000Z",
    releaseUrl: "https://github.com/fabPlane/fabdesk/releases/tag/v0.4.26",
    assets: [],
  },
  updateAvailable: true,
  asset: { platform: "win32", arch: "x64", kind: "exe", filename: "setup.exe",
    url: "https://test.invalid/setup.exe", size: 32, sha256: "0".repeat(64) },
  downloadPageUrl: "https://fabplane.com/download",
};

/** Renders the sign-in screen in a DOM and returns its text once the host's update check has answered. */
async function signInScreenText(result: UpdateCheckResult | null, overrides?: Partial<HostAdapter>, interact?: (document: Document) => Promise<void>): Promise<string> {
  const w = new JSDOM("<body><div id='mount'></div></body>", { url: "http://test.invalid", pretendToBeVisual: true }).window;
  const globals = Object.entries({
    window: w, document: w.document, HTMLElement: w.HTMLElement,
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const originals = new Map(globals.map(([key]) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const authBefore = useAuthStore.getState().state;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(w.document.querySelector("#mount"));
  try {
    const client = new CoreClient({ baseUrl: "http://test.invalid", token: "test", fetch: async () => Response.json({}) });
    const host: HostAdapter = { ...nullHost, updateStatus: async () => result, downloadUpdate: async () => ({ state: "idle" }), ...overrides };
    useAuthStore.setState({ state: { status: "signed_out" } as never });
    await act(async () => {
      root.render(
        <CoreProvider client={client} host={host} subscribe={() => ({ close() {} })}>
          <LoginScreen />
        </CoreProvider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await interact?.(w.document);
    return w.document.body.textContent ?? "";
  } finally {
    await act(async () => root.unmount());
    useAuthStore.setState({ state: authBefore });
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test("a signed-out user sees that an update is available", async () => {
  const text = await signInScreenText(update);
  expect(text).toContain("Sign in with fabPlane");
  expect(text).toContain("Update to 0.4.26");
});

test("the sign-in screen shows no update badge when the app is current", async () => {
  const text = await signInScreenText({ ...update, updateAvailable: false });
  expect(text).toContain("Sign in with fabPlane");
  expect(text).not.toContain("Update available");
});

test("one click stages the version and keeps its optional restart visible through a failed feed check or newer offer", async () => {
  let starts = 0, restarts = 0;
  let status: ((result: UpdateCheckResult) => void) | undefined;
  const staged: UpdateDownloadState = { state: "done", version: "0.4.26", filename: "setup.exe", path: "cache/setup.exe", sha256: "0".repeat(64), restart: true };
  await signInScreenText(update, {
    downloadUpdate: async () => { starts++; return staged; },
    openUpdate: async () => { restarts++; return ""; },
    onUpdateStatus: listener => { status = listener; return () => { status = undefined; }; },
  }, async doc => {
    const button = () => doc.querySelector<HTMLButtonElement>('[aria-label="FabDesk update"] button');
    await act(async () => button()!.click());
    expect(starts).toBe(1);
    expect(restarts).toBe(0);
    await act(async () => status!({ ...update, latest: null, updateAvailable: false, error: "offline" }));
    expect(doc.body.textContent).toContain("Ready for next launch");
    await act(async () => status!({ ...update, latest: { ...update.latest!, version: "0.4.27" } }));
    expect(doc.body.textContent).toContain("fabPlane 0.4.26");
    expect(button()?.textContent).toBe("Restart now");
    await act(async () => button()!.click());
    expect(restarts).toBe(1);
  });
});

test("restores the staged status when the desktop starts offline without a feed result", async () => {
  const text = await signInScreenText(null, {
    updateDownloadState: async () => ({
      state: "done", version: "0.4.26", filename: "up.zip", path: "cache/up.zip", sha256: "0".repeat(64), restart: true,
    }), openUpdate: async () => "",
  });
  expect(text).toContain("Ready for next launch");
  expect(text).toContain("Restart now");
});

test.each([
  ["move-to-applications", "Move to Applications"], ["system-package", "Update with package manager"], ["installer", "Download installer"],
] as const)("shows the action the current installation supports (%s)", async (installMode, label) => {
  const text = await signInScreenText({ ...update, installMode });
  expect(text).toContain(label);
  expect(text).not.toContain("Ready for next launch");
});

test("a missing compatible file offers downloads and never invokes the package manager", async () => {
  let url = "";
  await signInScreenText({ ...update, installMode: "system-package", asset: null }, {
    downloadUpdate: () => { throw new Error("No package is available."); },
    openExternal: target => { url = target; },
  }, async doc => {
    const button = doc.querySelector<HTMLButtonElement>('[aria-label="View downloads"]');
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    expect(url).toBe(update.downloadPageUrl);
  });
});

test("a failed periodic check retains the offer and one click rechecks before downloading", async () => {
  let status: ((result: UpdateCheckResult) => void) | undefined;
  let online = false, downloads = 0;
  const failed = { ...update, updateAvailable: false, latest: null, error: "offline" };
  await signInScreenText(update, {
    onUpdateStatus: listener => { status = listener; return () => { status = undefined; }; },
    checkForUpdates: async () => online ? update : failed,
    downloadUpdate: async () => { downloads++; return { state: "verifying", version: "0.4.26", filename: "setup.exe" }; },
  }, async doc => {
    await act(async () => status!(failed));
    const button = doc.querySelector<HTMLButtonElement>('[aria-label="Update to 0.4.26"]')!;
    expect(doc.body.textContent).toContain("Reconnect");
    await act(async () => button.click());
    expect(doc.querySelector('[role="alert"]')?.textContent).toContain("connection");
    expect(downloads).toBe(0);
    online = true;
    await act(async () => button.click());
    expect(downloads).toBe(1);
    expect(doc.body.textContent).toContain("Preparing update");
  });
});

test("an older IPC snapshot cannot clear a staged event that arrived during subscription", async () => {
  const text = await signInScreenText(null, {
    updateDownloadState: async () => ({ state: "idle" }),
    onUpdateDownload: listener => {
      listener({ state: "done", version: "0.4.26", filename: "up.zip", path: "cache/up.zip", sha256: "0".repeat(64), restart: true });
      return () => {};
    },
  });
  expect(text).toContain("Ready for next launch");
});
