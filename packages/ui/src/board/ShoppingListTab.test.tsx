import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CartItem } from "@fabdesk/protocol";
import { createShoppingDraft } from "@fabdesk/client-core";
import { ShoppingItemRow } from "./ShoppingListTab";

const item: CartItem = { id: "1", kind: "other", description: "Solder paste", quantity: 1, destinationId: "builtin:manual", status: "needed", createdAt: "t", updatedAt: "t", footprint: "0805", manufacturer: "Maker", sku: "PART-1", refs: ["C1"] };
const actions = { options: [], onPatch: async () => {}, onRemove: async () => {} };

test("collapsed rows retain identifying details and a labelled status control outside the expansion button", () => {
  const html = renderToStaticMarkup(<ShoppingItemRow item={item} {...actions} />);
  expect(html).toContain("Other item");
  expect(html).toContain("0805");
  expect(html).toContain("Maker");
  expect(html).toContain("PART-1");
  expect(html).toContain('aria-label="Order status for Solder paste"');
  expect(html.indexOf("</button>")).toBeLessThan(html.indexOf("<select"));
});

test("restored drafts expose unsaved state and cannot be bypassed with the quick status control", () => {
  const value = { ...createShoppingDraft(item), quantity: "4" };
  const html = renderToStaticMarkup(<ShoppingItemRow item={item} {...actions} draftState={{ value, set() {} }} />);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("Unsaved changes");
  expect(html).toContain("Discard changes");
  expect(html).toMatch(/shopping-quick-status[^>]*disabled=""/);
  expect(html).toContain('value="4"');
});

test("concurrent changes display a choice and block saving until resolved", () => {
  const value = { ...createShoppingDraft(item), quantity: "4" };
  const html = renderToStaticMarkup(<ShoppingItemRow item={{ ...item, quantity: 7 }} {...actions} draftState={{ value, set() {} }} />);
  expect(html).toContain("Latest: quantity 7");
  expect(html).toContain("Keep my changes");
  expect(html).toContain("Use latest values");
  expect(html).toMatch(/type="submit"[^>]*disabled=""/);
});
