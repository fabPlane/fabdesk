import { describe, expect, test } from "bun:test";
import type { CartItem, Destination } from "@fabdesk/protocol";
import { CoreHttpError } from "./CoreClient";
import { cloudErrorMessage, destinationOptions, groupByDestination, isCloudSignedOut, itemLabel } from "./shopping";

const item = (id: string, over: Partial<CartItem>): CartItem => ({
  id,
  kind: "part",
  quantity: 1,
  status: "needed",
  destinationId: "builtin:jlcpcb",
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

const thailand: Destination = {
  id: "u-th",
  name: "DigiKey Thailand",
  kind: "distributor",
  url: "https://www.digikey.co.th",
  builtin: false,
  baseId: "builtin:digikey",
};

describe("shopping list grouping", () => {
  test("groups by destination: fab, distributors, manual, unknown; PCB first, refs natural", () => {
    const groups = groupByDestination(
      [
        item("1", { value: "10k", refs: ["R10"], quantity: 2 }),
        item("2", { kind: "pcb", description: "PCB – X", quantity: 5 }),
        item("3", { value: "1k", refs: ["R2"] }),
        item("4", { mpn: "ESP32", destinationId: "u-th", quantity: 3 }),
        item("5", { description: "Flux", kind: "other", destinationId: "builtin:manual" }),
        item("6", { description: "?", destinationId: "gone" }),
      ],
      [thailand],
    );
    expect(groups.map((g) => [g.name, g.kind, g.items.map((i) => i.id), g.totalQuantity])).toEqual([
      ["JLCPCB", "fab", ["2", "3", "1"], 8],
      ["DigiKey Thailand", "distributor", ["4"], 3],
      ["Manual purchase", "manual", ["5"], 1],
      ["gone", "unknown", ["6"], 1],
    ]);
    expect(groupByDestination([])).toEqual([]);
  });

  test("labels and destination picker order", () => {
    expect(itemLabel({ kind: "part", value: "10k" })).toBe("10k");
    expect(itemLabel({ kind: "part", mpn: "X", value: "10k" })).toBe("X");
    expect(itemLabel({ kind: "pcb" })).toBe("pcb");
    const opts = destinationOptions([thailand]);
    expect(opts.map((d) => d.id)).toEqual(["u-th"]);
    const builtins = destinationOptions([]);
    expect(builtins[0]!.kind).toBe("fab");
    expect(builtins.at(-1)!.id).toBe("builtin:manual");
  });

  test("signed-out detection and error messages", () => {
    const e = new CoreHttpError(401, "/cloud/inventory", '{"error":"cloud_signed_out","message":"Not signed in"}');
    expect(isCloudSignedOut(e)).toBe(true);
    expect(isCloudSignedOut(new CoreHttpError(401, "/x", "unauthorized"))).toBe(false);
    expect(cloudErrorMessage(e)).toBe("Not signed in");
    expect(cloudErrorMessage(new CoreHttpError(500, "/x", "boom"))).toBe("boom");
    expect(cloudErrorMessage(new Error("x"))).toBe("x");
  });
});
