import { describe, expect, test } from "bun:test";
import {
  SAVED_HOSTS_KEY,
  activeHost,
  readSavedHosts,
  withActive,
  withHost,
  withoutHost,
  writeSavedHosts,
  type SavedHost,
  type StorageLike,
} from "./hosts";

function memoryStorage(
  initial: Record<string, string> = {},
): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

const mac: SavedHost = {
  host: "https://mac.tailnet.ts.net",
  deviceToken: "tok-mac",
  coreName: "mac",
  coreId: "core-1",
  deviceId: "dev-1",
  pairedAt: "2026-09-13T10:00:00Z",
};
const mini: SavedHost = {
  ...mac,
  host: "https://mini.tailnet.ts.net",
  deviceToken: "tok-mini",
  coreName: "mini",
  coreId: null,
};

describe("readSavedHosts", () => {
  test("an empty or broken store reads as no computers", () => {
    expect(readSavedHosts(memoryStorage())).toEqual({ v: 1, active: null, hosts: [] });
    expect(readSavedHosts(memoryStorage({ [SAVED_HOSTS_KEY]: "{not json" }))).toEqual({
      v: 1,
      active: null,
      hosts: [],
    });
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readSavedHosts(throwing).hosts).toEqual([]);
  });

  test("drops entries that are not hosts and an active that names none of them", () => {
    const s = memoryStorage({
      [SAVED_HOSTS_KEY]: JSON.stringify({
        v: 1,
        active: "https://gone",
        hosts: [mac, { host: "x" }, null],
      }),
    });
    expect(readSavedHosts(s)).toEqual({ v: 1, active: null, hosts: [mac] });
  });

  test("round-trips through writeSavedHosts", () => {
    const s = memoryStorage();
    writeSavedHosts(s, withHost({ v: 1, active: null, hosts: [] }, mac));
    expect(readSavedHosts(s)).toEqual({ v: 1, active: mac.host, hosts: [mac] });
  });
});

describe("withHost / withoutHost / withActive", () => {
  test("a new computer goes first and becomes active", () => {
    const one = withHost({ v: 1, active: null, hosts: [] }, mac);
    const two = withHost(one, mini);
    expect(two.active).toBe(mini.host);
    expect(two.hosts.map((h) => h.host)).toEqual([mini.host, mac.host]);
  });

  test("re-pairing the same computer replaces its token instead of duplicating it", () => {
    const one = withHost({ v: 1, active: null, hosts: [] }, mac);
    const again = withHost(one, { ...mac, deviceToken: "tok-mac-2" });
    expect(again.hosts).toHaveLength(1);
    expect(again.hosts[0]?.deviceToken).toBe("tok-mac-2");
  });

  test("removing the active computer hands over to the next one; removing another leaves it", () => {
    const both = withHost(withHost({ v: 1, active: null, hosts: [] }, mac), mini);
    expect(withoutHost(both, mini.host)).toEqual({ v: 1, active: mac.host, hosts: [mac] });
    expect(withoutHost(both, mac.host)).toEqual({ v: 1, active: mini.host, hosts: [mini] });
    expect(withoutHost(withoutHost(both, mac.host), mini.host)).toEqual({
      v: 1,
      active: null,
      hosts: [],
    });
  });

  test("withActive only accepts a saved computer", () => {
    const both = withHost(withHost({ v: 1, active: null, hosts: [] }, mac), mini);
    expect(withActive(both, mac.host).active).toBe(mac.host);
    expect(withActive(both, "https://nope").active).toBe(mini.host);
    expect(withActive(both, null).active).toBeNull();
    expect(activeHost(withActive(both, mac.host))).toEqual(mac);
    expect(activeHost(withActive(both, null))).toBeNull();
  });
});
