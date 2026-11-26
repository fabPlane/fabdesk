import { expect, test } from "bun:test";
import { act } from "react";
import { CoreClient, CoreProvider, nullHost, useAuthStore, type HostAdapter } from "@fabdesk/client-core";
import type { UpdateCheckResult } from "@fabdesk/protocol";
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
  asset: null,
  downloadPageUrl: "https://fabplane.com/download",
};

/** Renders the sign-in screen in a DOM and returns its text once the host's update check has answered. */
async function signInScreenText(result: UpdateCheckResult | null): Promise<string> {
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
    const host: HostAdapter = { ...nullHost, updateStatus: async () => result };
    useAuthStore.setState({ state: { status: "signed_out" } as never });
    await act(async () => {
      root.render(
        <CoreProvider client={client} host={host} subscribe={() => ({ close() {} })}>
          <LoginScreen />
        </CoreProvider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
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
  expect(text).toContain("Update 0.4.26");
});

test("the sign-in screen shows no update badge when the app is current", async () => {
  const text = await signInScreenText({ ...update, updateAvailable: false });
  expect(text).toContain("Sign in with fabPlane");
  expect(text).not.toContain("Update 0.4.26");
});
