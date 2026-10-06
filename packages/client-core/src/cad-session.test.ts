import { expect, test } from "bun:test";
import { CadSession } from "./cad-session";
import type { CadRuntimeBridge, CadRuntimeState } from "@fabdesk/protocol";
const ready: CadRuntimeState = { status: "ready" };
const view = {
  bridgeUrl: "http://127.0.0.1:4030",
  session: "one",
  wsUrl: "ws://127.0.0.1:4030/ws",
  uiUrl: "http://127.0.0.1:4030/",
  document: "model",
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture(status: CadRuntimeState) {
  let views = 0,
    downloads = 0,
    cancels = 0;
  const bridge: CadRuntimeBridge = {
    cadRuntimeState: async () => status,
    prepareCadRuntime: async () => status,
    downloadCadRuntime: async () => {
      downloads++;
      status = ready;
      return ready;
    },
    cancelCadRuntime: async () => {
      cancels++;
    },
    deferCadRuntime: async () => {
      status = { status: "deferred" };
      return status;
    },
  };
  const changes: unknown[] = [];
  const session = new CadSession(
    bridge,
    async () => {
      views++;
      return view;
    },
    (s) => changes.push(s),
  );
  return { session, bridge, changes, counts: () => ({ views, downloads, cancels }) };
}
for (const status of [
  "missing",
  "consent",
  "deferred",
  "unsupported",
  "error",
  "downloading",
  "verifying",
] as const) {
  test(`${status} runtime never requests a CAD session or downloads automatically`, async () => {
    const f = fixture({ status });
    await f.session.refresh();
    expect(f.session.state.runtime?.status).toBe(status);
    expect(f.counts()).toEqual({ views: 0, downloads: 0, cancels: 0 });
    expect(f.session.state.busy).toBe(false);
  });
}
test("ready runtime opens CAD; successful explicit install recovers into CAD", async () => {
  const f = fixture({ status: "consent" });
  await f.session.refresh();
  await f.session.install();
  expect(f.session.state.view).toEqual(view);
  expect(f.session.state.busy).toBe(false);
  expect(f.counts()).toEqual({ views: 1, downloads: 1, cancels: 0 });
});
test("repeated clicks share the active request", async () => {
  const f = fixture(ready),
    wait = deferred<CadRuntimeState>();
  let prepares = 0;
  f.bridge.prepareCadRuntime = () => {
    prepares++;
    return wait.promise;
  };
  const request = f.session.refresh();
  await f.session.refresh();
  await f.session.install();
  expect(prepares).toBe(1);
  expect(f.counts().downloads).toBe(0);
  wait.resolve(ready);
  await request;
  expect(f.counts().views).toBe(1);
});
test("cancellation holds the click lock until consent/install has settled", async () => {
  const f = fixture({ status: "consent" }),
    wait = deferred<CadRuntimeState>();
  let downloads = 0;
  f.bridge.downloadCadRuntime = () => {
    downloads++;
    return wait.promise;
  };
  const request = f.session.install();
  await f.session.install();
  await f.session.cancel();
  await f.session.install();
  expect(downloads).toBe(1);
  expect(f.counts().cancels).toBe(1);
  wait.resolve({ status: "deferred" });
  await request;
  expect(f.session.state.busy).toBe(false);
  expect(f.counts().views).toBe(0);
});
test("navigation discards late project responses", async () => {
  const wait = deferred<unknown>(),
    changes: unknown[] = [];
  const session = new CadSession(
    undefined,
    () => wait.promise,
    (s) => changes.push(s),
  );
  const request = session.refresh();
  session.dispose();
  const count = changes.length;
  wait.resolve(view);
  await request;
  expect(changes.length).toBe(count);
});
test("StrictMode effect replay discards the first request", async () => {
  const wait = deferred<unknown>();
  let calls = 0;
  const session = new CadSession(
    undefined,
    () => (++calls === 1 ? wait.promise : Promise.resolve(view)),
    () => {},
  );
  const old = session.refresh();
  session.dispose();
  session.resume();
  await session.refresh();
  wait.resolve({ ...view, document: "stale" });
  await old;
  expect(session.state.view?.document).toBe("model");
});
test("connection failure hides raw error, keeps installed status, and retries", async () => {
  let fail = true;
  const f = fixture(ready);
  const session = new CadSession(
    f.bridge,
    async () => {
      if (fail) throw new Error('{"error":"secret transport details","code":"unavailable"}');
      return view;
    },
    () => {},
  );
  await session.refresh();
  expect(session.state.runtime?.status).toBe("ready");
  expect(session.state.error).not.toContain("secret");
  await session.poll();
  expect(session.state.error).not.toBeNull();
  fail = false;
  await session.refresh();
  expect(session.state.view).toEqual(view);
  expect(session.state.error).toBeNull();
});
test("reopening during installation polls and opens CAD once ready", async () => {
  const f = fixture({ status: "downloading" });
  await f.session.refresh();
  f.bridge.cadRuntimeState = async () => ready;
  f.bridge.prepareCadRuntime = async () => ready;
  await f.session.poll();
  expect(f.session.state.view).toEqual(view);
});
test("IPC failure clears busy and permits retry", async () => {
  const f = fixture({ status: "consent" });
  f.bridge.downloadCadRuntime = async () => {
    throw new Error("IPC unavailable");
  };
  await f.session.install();
  expect(f.session.state.busy).toBe(false);
  expect(f.session.state.error).toContain("Try again");
  await f.session.refresh();
  expect(f.session.state.error).toBeNull();
});
test("invalid view is recoverable and a bridge with no viewer remains distinct", async () => {
  const session = new CadSession(
    undefined,
    async () => ({}),
    () => {},
  );
  await session.refresh();
  expect(session.state.error).toContain("unexpected");
  const noUi = new CadSession(
    undefined,
    async () => ({ ...view, uiUrl: null }),
    () => {},
  );
  await noUi.refresh();
  expect(noUi.state.view?.uiUrl).toBeNull();
  expect(noUi.state.error).toBeNull();
});

test("explicit connection retry requests installed bridge recovery", async () => {
  const f = fixture(ready);
  let reconnects = 0;
  f.bridge.reconnectCadRuntime = async () => {
    reconnects++;
    return ready;
  };
  await f.session.refresh(true);
  expect(reconnects).toBe(1);
  expect(f.session.state.view).toEqual(view);
});
