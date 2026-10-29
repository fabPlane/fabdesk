import { describe, expect, test } from "bun:test";
import type { RouterSnapshot } from "@fabdesk/protocol";
import {
  canCancel,
  canRecheck,
  formatBytes,
  installProgressView,
  withoutRouterDefault,
  canInstall,
  canUninstall,
  isPreferred,
  primaryAction,
  primaryActionLabel,
  routerPickerOptions,
  stateLabel,
  routerUsable,
} from "./routers";

const router = (over: Partial<RouterSnapshot>): RouterSnapshot => ({
  id: "tracemaker",
  displayName: "TraceMaker",
  description: "Native KiCad autorouter",
  strengths: ["whole-board routing"],
  license: "GPL-3.0-or-later",
  version: "0.8.0",
  homepage: "https://github.com/DingoOz/TraceMaker",
  install: "download",
  state: "not_installed",
  ready: false,
  installHint: "TraceMaker is not installed.",
  ...over,
});

describe("router settings helpers", () => {
  test("runtime failures disable engines and automatic defaults while retaining their installation actions", () => {
    const unavailable = router({ id: "fab_router", state: "bundled", install: "bundled", ready: true, runtime: { ready: false, reason: "Missing router module" } });
    expect(routerUsable(unavailable)).toBe(false);
    expect(stateLabel(unavailable)).toBe("bundled · unavailable");
    expect(routerPickerOptions([unavailable])[0]?.disabled).toBe(true);
    expect(routerPickerOptions([unavailable]).find(option => option.id === "fab_router")).toMatchObject({ disabled: true, note: "engine unavailable", hint: "Missing router module" });
    const ready = router({ id: "freerouting", ready: true, state: "installed", runtime: { ready: true } });
    expect(routerPickerOptions([unavailable, ready])[0]?.disabled).toBe(false);
    // TraceMaker is selected automatically only when it is the configured preference.
    const trace = router({ ready: true, state: "installed", runtime: { ready: true } });
    expect(routerPickerOptions([trace])[0]?.disabled).toBe(true);
    expect(routerPickerOptions([trace], "tracemaker")[0]?.disabled).toBe(false);
  });
  test("install / uninstall / cancel follow the registry states", () => {
    const missing = router({});
    expect(canInstall(missing)).toBe(true);
    expect(canUninstall(missing)).toBe(false);
    expect(primaryAction(missing)).toBe("install");
    expect(primaryActionLabel("install")).toBe("Install");

    const installed = router({ state: "installed", ready: true, path: "/tmp/tracemaker" });
    expect(canInstall(installed)).toBe(false);
    expect(canUninstall(installed)).toBe(true);
    expect(primaryAction(installed)).toBe("uninstall");
    expect(stateLabel(installed)).toBe("installed 0.8.0");

    const bundled = router({
      id: "fab_router",
      displayName: "fab_router",
      install: "bundled",
      state: "bundled",
      ready: true,
    });
    expect(canInstall(bundled)).toBe(false);
    expect(canUninstall(bundled)).toBe(false);
    expect(primaryAction(bundled)).toBeNull();
    expect(stateLabel(bundled)).toBe("bundled");

    const installing = router({
      state: "installing",
      progress: { received: 50, total: 100 },
    });
    expect(canCancel(installing)).toBe(true);
    expect(primaryAction(installing)).toBe("cancel");
    expect(stateLabel(installing)).toBe("installing 50%");

    const failed = router({ state: "failed", error: "offline" });
    expect(canInstall(failed)).toBe(true);
    expect(canUninstall(failed)).toBe(true);
    expect(stateLabel(failed)).toBe("failed");
  });

  test("the route picker keeps an explicit default that does not force a router", () => {
    const options = routerPickerOptions(
      [
        router({
          id: "fab_router",
          displayName: "fab_router",
          install: "bundled",
          state: "bundled",
          ready: true,
        }),
        router({ state: "not_installed", ready: false }),
      ],
      undefined,
    );
    expect(options[0]).toMatchObject({
      id: "default",
      disabled: false,
      label: "Default (Freerouting → fab_router)",
    });
    expect(options.find((row) => row.id === "tracemaker")?.disabled).toBe(true);
    expect(isPreferred(router({ id: "freerouting" }), "freerouting")).toBe(true);
  });

  test("source-only installs are not ready, labelled as such, and offer a recheck instead of looking installed", () => {
    const source = router({
      state: "installed",
      ready: false,
      sourceOnly: true,
      path: "/data/routers/tracemaker",
      notice: "Only the source package was downloaded",
    });
    expect(stateLabel(source)).toBe("source only · not built");
    expect(canRecheck(source)).toBe(true);
    expect(canUninstall(source)).toBe(true);
    const options = routerPickerOptions([source], undefined);
    expect(options.find((row) => row.id === "tracemaker")).toMatchObject({ disabled: true, note: "not built" });
  });

  test("a failed install says Retry; an env-supplied router has no Uninstall and shows its env var", () => {
    const failed = router({ state: "failed", error: "checksum mismatch" });
    expect(primaryActionLabel(primaryAction(failed), failed)).toBe("Retry");
    expect(primaryActionLabel("install", router({}))).toBe("Install");
    expect(routerPickerOptions([failed], undefined).find((row) => row.id === "tracemaker")?.note).toBe("install failed");

    const env = router({ state: "installed", ready: true, overriddenBy: "TRACEMAKER_BIN", versionInstalled: "1.2.3" });
    expect(canUninstall(env)).toBe(false);
    expect(primaryAction(env)).toBeNull();
    expect(canRecheck(env)).toBe(false);
    expect(stateLabel(env)).toBe("installed 1.2.3 (TRACEMAKER_BIN)");
  });

  test("bundled routers do not repeat the word bundled", () => {
    const bundled = router({
      id: "fab_router",
      install: "bundled",
      state: "bundled",
      ready: true,
      versionInstalled: "bundled",
    });
    expect(stateLabel(bundled)).toBe("bundled");
    expect(stateLabel({ ...bundled, versionInstalled: "2.4.1" })).toBe("bundled 2.4.1");
  });

  test("progress view is determinate while downloading and names the verify/extract phases", () => {
    const downloading = router({
      state: "installing",
      progress: { received: 5 * 1024 * 1024, total: 20 * 1024 * 1024, phase: "downloading" },
    });
    expect(installProgressView(downloading)).toEqual({ fraction: 0.25, text: "Downloading 5.0 MB / 20.0 MB" });
    expect(stateLabel(downloading)).toBe("installing 25%");
    expect(installProgressView(router({ state: "installing", progress: { received: 1, total: 1, phase: "verifying" } }))).toEqual({
      fraction: 1,
      text: "Verifying checksum…",
    });
    expect(installProgressView(router({ state: "installing", progress: { received: 1, total: 1, phase: "extracting" } }))?.text).toBe(
      "Extracting…",
    );
    expect(installProgressView(router({ state: "installing", progress: { received: 0, total: 0, phase: "resolving" } }))?.fraction).toBeNull();
    expect(installProgressView(router({}))).toBeNull();
    expect(formatBytes(2048)).toBe("2 KB");
  });

  test("the Settings draft never carries the router default, so Save cannot revert Set default", () => {
    const stale = { theme: "dark", preferredRouter: "freerouting", tracemakerManifestUrl: "https://a.test/m.json" } as const;
    const fresh = { theme: "dark", preferredRouter: "tracemaker", tracemakerManifestUrl: "https://b.test/m.json" } as const;
    expect(withoutRouterDefault(stale)).toEqual({ theme: "dark" });
    expect(JSON.stringify(withoutRouterDefault(stale))).toBe(JSON.stringify(withoutRouterDefault(fresh)));
    expect("preferredRouter" in withoutRouterDefault(stale)).toBe(false);
    expect("tracemakerManifestUrl" in withoutRouterDefault(stale)).toBe(false);
  });

  test("a saved default that is not ready is called out in the picker", () => {
    const options = routerPickerOptions([router({ state: "not_installed" })], "tracemaker");
    const ready = routerPickerOptions([router({ state: "installed", ready: true })], "tracemaker");
    expect(ready[0]?.label).toBe("Default (TraceMaker)");
    expect(options[0]?.label).toBe("Default (TraceMaker not ready → Freerouting → fab_router)");
  });
});
