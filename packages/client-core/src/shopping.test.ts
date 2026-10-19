import { describe, expect, test } from "bun:test";
import type { CartItem, Destination } from "@fabdesk/protocol";
import { CoreHttpError } from "./CoreClient";
import { cloudErrorMessage, createShoppingDraft, destinationOptions, filterShoppingItems, groupByDestination, isCloudSignedOut, itemLabel, rebaseShoppingDraft, shoppingDraftConflicts, shoppingDraftPatch } from "./shopping";

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
  test("editing quantity does not overwrite a teammate's status, supplier or notes", () => {
    const original = item("1", { quantity: 2 });
    const draft = { ...createShoppingDraft(original), quantity: "12" };
    const latest = { ...original, status: "received" as const, notes: "Delivered", destinationId: "u-th" };
    expect(shoppingDraftPatch(draft)).toEqual({ quantity: 12 });
    expect(shoppingDraftConflicts(draft, latest)).toEqual([]);
    expect({ ...latest, ...shoppingDraftPatch(draft) }).toMatchObject({ quantity: 12, status: "received", notes: "Delivered", destinationId: "u-th" });
  });

  test("overlapping edits require a choice, and keeping a draft preserves unrelated updates", () => {
    const original = item("1", { quantity: 2, notes: "Original" });
    const draft = { ...createShoppingDraft(original), quantity: "12", notes: "" };
    const latest = { ...original, quantity: 8, status: "ordered" as const, notes: "From teammate" };
    expect(shoppingDraftConflicts(draft, latest)).toEqual(["quantity", "notes"]);
    const rebased = rebaseShoppingDraft(draft, latest);
    expect(shoppingDraftConflicts(rebased, latest)).toEqual([]);
    expect(shoppingDraftPatch(rebased)).toEqual({ quantity: 12, notes: "" });
    expect(rebased.status).toBe("ordered");
    expect(shoppingDraftPatch(createShoppingDraft(latest))).toEqual({});
  });

  test("equivalent edits and empty optional notes do not create conflicts or writes", () => {
    const original = item("1", {});
    expect(shoppingDraftPatch(createShoppingDraft(original))).toEqual({});
    const draft = { ...createShoppingDraft(original), quantity: "5", notes: "Received" };
    expect(shoppingDraftConflicts(draft, { ...original, quantity: 5, notes: "Received" })).toEqual([]);
  });
  test("search combines terms, details and supplier names with the selected order status", () => {
    const items = [item("capacitor", { value: "100nF", refs: ["C2", "C3"], footprint: "Capacitor_SMD:C_0805", status: "ordered" }), item("chip", { mpn: "ESP32", destinationId: "u-th", notes: "Alternative available", status: "received" })];
    expect(filterShoppingItems(items, "  C2  0805 ", "all").map(i => i.id)).toEqual(["capacitor"]);
    expect(filterShoppingItems(items, "jlcPCB", "ordered").map(i => i.id)).toEqual(["capacitor"]);
    expect(filterShoppingItems(items, "alternative thailand", "received", [thailand]).map(i => i.id)).toEqual(["chip"]);
    expect(filterShoppingItems(items, "ESP32", "needed")).toEqual([]);
    expect(filterShoppingItems(items, "", "all")).toEqual(items);
    expect(items[0]?.status).toBe("ordered");
  });
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
    expect(cloudErrorMessage(e)).toContain("Settings → Account");
    expect(cloudErrorMessage(new CoreHttpError(500, "/x", "boom"))).toContain("share the technical details");
    expect(cloudErrorMessage(new Error("x"))).toBe("x");
  });
});
