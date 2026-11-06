import { describe, expect, test } from "bun:test";
import {
  BUILTIN_DESTINATIONS,
  CartItemInput,
  Settings,
  cartDashboardUrl,
  dashboardUrlFor,
  matchDestination,
} from "../src";

describe("fabplane dashboard URL", () => {
  test("supports a separate viewer origin and refuses credential-bearing or executable URLs", () => {
    expect(dashboardUrlFor("http://127.0.0.1:4196", "http://127.0.0.1:5185")).toBe(
      "http://127.0.0.1:5185/dashboard",
    );
    expect(() => dashboardUrlFor("https://api.example", "javascript:alert(1)")).toThrow();
    expect(() => dashboardUrlFor("https://api.example", "https://secret@example.com")).toThrow();
  });
  test("follows the contract rule", () => {
    expect(dashboardUrlFor("https://api.fabplane.com")).toBe("https://app.fabplane.com/dashboard");
    expect(dashboardUrlFor("https://api.fabplane.com/")).toBe("https://app.fabplane.com/dashboard");
    expect(dashboardUrlFor("http://fabplane-staging.tail4f6a7.ts.net:4000")).toBe(
      "http://fabplane-staging.tail4f6a7.ts.net:5173/dashboard",
    );
    expect(dashboardUrlFor("https://box.example:4000")).toBe("https://box.example:5173/dashboard");
    expect(dashboardUrlFor("http://localhost:8787")).toBe("http://localhost:5173/dashboard");
    expect(dashboardUrlFor("https://api.staging.fabplane.dev")).toBe(
      "https://app.staging.fabplane.dev/dashboard",
    );
    expect(dashboardUrlFor("https://fabplane.internal")).toBe(
      "https://fabplane.internal/dashboard",
    );
    expect(dashboardUrlFor("not a url")).toBe("https://app.fabplane.com/dashboard");
    expect(cartDashboardUrl("https://app.fabplane.com/dashboard/", "c1")).toBe(
      "https://app.fabplane.com/dashboard/carts/c1",
    );
  });
});

describe("destinations", () => {
  const custom = {
    id: "u-1",
    name: "DigiKey Thailand",
    kind: "distributor" as const,
    url: "https://www.digikey.co.th",
    builtin: false,
    baseId: "builtin:digikey",
  };
  const all = [...BUILTIN_DESTINATIONS, custom];
  test("match by id, built-in key or name", () => {
    expect(BUILTIN_DESTINATIONS).toHaveLength(11);
    expect(matchDestination("builtin:lcsc", all)?.name).toBe("LCSC");
    expect(matchDestination("JLCPCB", all)?.id).toBe("builtin:jlcpcb");
    expect(matchDestination("manual", all)?.id).toBe("builtin:manual");
    expect(matchDestination("digikey thailand", all)?.id).toBe("u-1");
    expect(matchDestination("u-1", all)?.id).toBe("u-1");
    expect(matchDestination("nowhere", all)).toBeNull();
    expect(matchDestination(" ", all)).toBeNull();
  });
});

describe("schemas", () => {
  test("cart item input and the cloudOrgId setting", () => {
    expect(CartItemInput.safeParse({ quantity: -1 }).success).toBe(false);
    expect(CartItemInput.parse({ quantity: 2, status: "ordered" })).toEqual({
      quantity: 2,
      status: "ordered",
    });
    expect(Settings.parse({}).cloudOrgId).toBeNull();
  });
});
