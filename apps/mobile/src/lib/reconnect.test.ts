import { describe, expect, test } from "bun:test";
import {
  isForegroundReturn,
  nextStaleSince,
  planAfterReprobe,
  shouldReprobeOnNetwork,
} from "./reconnect";

describe("nextStaleSince", () => {
  test("is null on a cold start that has never been open", () => {
    expect(nextStaleSince(null, "connecting", null, 1000)).toBeNull();
    expect(nextStaleSince("connecting", "reconnecting", null, 1000)).toBeNull();
  });

  test("stamps the moment the stream leaves open, and keeps it while it stays down", () => {
    const left = nextStaleSince("open", "reconnecting", null, 5000);
    expect(left).toBe(5000);
    expect(nextStaleSince("reconnecting", "connecting", left, 9000)).toBe(5000);
    expect(nextStaleSince("connecting", "reconnecting", left, 12000)).toBe(5000);
  });

  test("clears when the stream is open again", () => {
    expect(nextStaleSince("reconnecting", "open", 5000, 9000)).toBeNull();
  });

  test("a closed-then-reopened transport (address switch) counts from the close", () => {
    const closed = nextStaleSince("open", "closed", null, 100);
    expect(nextStaleSince("closed", "connecting", closed, 150)).toBe(100);
    expect(nextStaleSince("connecting", "open", closed, 300)).toBeNull();
  });
});

describe("isForegroundReturn", () => {
  test("fires on background → active and inactive → active", () => {
    expect(isForegroundReturn("background", "active")).toBe(true);
    expect(isForegroundReturn("inactive", "active")).toBe(true);
  });

  test("does not fire on the first observation, on staying active, or on leaving", () => {
    expect(isForegroundReturn(null, "active")).toBe(false);
    expect(isForegroundReturn("active", "active")).toBe(false);
    expect(isForegroundReturn("active", "background")).toBe(false);
    expect(isForegroundReturn("active", "inactive")).toBe(false);
  });
});

describe("shouldReprobeOnNetwork", () => {
  test("Wi-Fi → cellular re-probes", () => {
    expect(
      shouldReprobeOnNetwork(
        { type: "WIFI", isConnected: true },
        { type: "CELLULAR", isConnected: true },
      ),
    ).toBe(true);
  });

  test("losing the network does not", () => {
    expect(
      shouldReprobeOnNetwork(
        { type: "WIFI", isConnected: true },
        { type: "NONE", isConnected: false },
      ),
    ).toBe(false);
  });

  test("getting it back does", () => {
    expect(
      shouldReprobeOnNetwork(
        { type: "NONE", isConnected: false },
        { type: "WIFI", isConnected: true },
      ),
    ).toBe(true);
  });

  test("a captive portal clearing does; an unchanged state does not", () => {
    const wifi = { type: "WIFI", isConnected: true };
    expect(
      shouldReprobeOnNetwork(
        { ...wifi, isInternetReachable: false },
        { ...wifi, isInternetReachable: true },
      ),
    ).toBe(true);
    expect(
      shouldReprobeOnNetwork(
        { ...wifi, isInternetReachable: true },
        { ...wifi, isInternetReachable: true },
      ),
    ).toBe(false);
    expect(shouldReprobeOnNetwork(wifi, wifi)).toBe(false);
  });

  test("the first event is worth a probe unless it says offline", () => {
    expect(shouldReprobeOnNetwork(null, { type: "WIFI", isConnected: true })).toBe(true);
    expect(shouldReprobeOnNetwork(null, {})).toBe(true);
    expect(shouldReprobeOnNetwork(null, { isConnected: false })).toBe(false);
  });
});

describe("planAfterReprobe", () => {
  const lan = "http://192.168.1.24:47820";
  const tailnet = "http://100.64.0.1:47820";

  test("keeps an open stream on the address that still answers", () => {
    expect(planAfterReprobe({ found: lan, currentBaseUrl: lan, streamStatus: "open" })).toEqual({
      kind: "keep",
    });
  });

  test("reopens a dead stream on the same address without waiting out the backoff", () => {
    expect(
      planAfterReprobe({ found: lan, currentBaseUrl: lan, streamStatus: "reconnecting" }),
    ).toEqual({ kind: "reopen" });
    expect(
      planAfterReprobe({ found: lan, currentBaseUrl: lan, streamStatus: "connecting" }),
    ).toEqual({ kind: "reopen" });
  });

  test("switches when a different address answers, even if the stream claims to be open", () => {
    expect(planAfterReprobe({ found: tailnet, currentBaseUrl: lan, streamStatus: "open" })).toEqual(
      {
        kind: "switch",
        baseUrl: tailnet,
      },
    );
  });

  test("back on Wi-Fi: a direct address answering while on the relay is a switch to it", () => {
    // `findReachable` probes direct addresses first and only falls back to the relay, so once
    // the tailnet answers again the re-probe reports it — and the plan leaves the relay even
    // though the relayed stream is still open. The extra hop is not worth keeping.
    const viaRelay = "https://relay.fabplane.com/c/core_abc";
    expect(
      planAfterReprobe({ found: tailnet, currentBaseUrl: viaRelay, streamStatus: "open" }),
    ).toEqual({ kind: "switch", baseUrl: tailnet });
    // Off Wi-Fi again: nothing direct answers, the relay does — a switch the other way.
    expect(
      planAfterReprobe({ found: viaRelay, currentBaseUrl: tailnet, streamStatus: "reconnecting" }),
    ).toEqual({ kind: "switch", baseUrl: viaRelay });
    // Still on the relay and it still answers: nothing to do.
    expect(
      planAfterReprobe({ found: viaRelay, currentBaseUrl: viaRelay, streamStatus: "open" }),
    ).toEqual({ kind: "keep" });
  });

  test("nothing answers: keep an open stream, but dial a dead one again", () => {
    expect(planAfterReprobe({ found: null, currentBaseUrl: lan, streamStatus: "open" })).toEqual({
      kind: "keep",
    });
    expect(
      planAfterReprobe({ found: null, currentBaseUrl: lan, streamStatus: "reconnecting" }),
    ).toEqual({ kind: "reopen" });
  });

  test("with no transport at all, start locating from scratch", () => {
    expect(planAfterReprobe({ found: null, currentBaseUrl: null, streamStatus: "closed" })).toEqual(
      { kind: "relocate" },
    );
    expect(planAfterReprobe({ found: lan, currentBaseUrl: null, streamStatus: "closed" })).toEqual({
      kind: "relocate",
    });
  });
});
