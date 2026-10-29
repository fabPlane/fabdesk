import { expect, test } from "bun:test";
import type { RouterList } from "@fabdesk/protocol";
import { withRouterRuntime } from "./router-runtime";
const catalog = (): RouterList => ({ routers: (["fab_router", "freerouting"] as const).map(id => ({ id, displayName: id, description: "Test router", strengths: [], license: "test", version: "test", homepage: "https://example.com", install: id === "fab_router" ? "bundled" : "download", state: id === "fab_router" ? "bundled" : "not_installed", ready: id === "fab_router", installHint: "Install router" })) });

test("installed router files do not imply an available backend engine", () => {
  const list = catalog();
  const installed = { ...list, routers: list.routers.map(router => ({ ...router, ready: true })) };
  const result = withRouterRuntime(installed, { url: "http://local", ok: true, routers: { fab_router: { ok: false, reason: "Private router module missing" }, freerouting: { ok: true } } });
  expect(result.routers.find(router => router.id === "fab_router")).toMatchObject({ ready: true, runtime: { ready: false, reason: "Private router module missing" } });
  expect(result.routers.find(router => router.id === "freerouting")?.runtime?.ready).toBe(true);
  expect(installed.routers.every(router => !router.runtime)).toBe(true);
});

test("unreachable backend or missing KiCad prevents runtime readiness without erasing installation state", () => {
  const list = catalog();
  for (const status of [{ url: "local", ok: false, reason: "Backend offline" }, { url: "local", ok: true, kicadCliExists: false, routers: { fab_router: { ok: true } } }]) {
    const result = withRouterRuntime(list, status);
    expect(result.routers.every(router => router.runtime?.ready === false)).toBe(true);
    expect(result.routers.find(router => router.id === "fab_router")?.state).toBe("bundled");
  }
});

test("unknown bridge engine capability stays unavailable and missing packages stay missing", () => {
  const list = catalog(), result = withRouterRuntime(list, { url: "local", ok: true });
  expect(result.routers.find(router => router.id === "fab_router")?.runtime?.ready).toBe(false);
  expect(result.routers.find(router => router.id === "freerouting")?.runtime?.ready).toBe(false);
});
