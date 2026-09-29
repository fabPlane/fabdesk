import { expect, test } from "bun:test";
import { Store, openDatabase } from "../src/db";

test("paged search ranks titles and returns message snippets with archived chat context", () => {
  const store = new Store(openDatabase(":memory:"));
  try {
    const exact = store.threads.create({ agentId: "claude", title: "resistor" });
    const prefix = store.threads.create({ agentId: "claude", title: "Resistor board" });
    const contains = store.threads.create({ agentId: "claude", title: "Find resistor" });
    store.threads.patch(prefix.id, { archived: true });
    store.threads.addMessage({ threadId: exact.id, role: "user", contentMd: "Place a resistor near the LED" });
    store.threads.addMessage({ threadId: prefix.id, role: "user", contentMd: "Check the resistor footprint" });
    store.threads.addMessage({ threadId: contains.id, role: "assistant", contentMd: "The resistor is placed" });
    const first = store.threads.searchResults("resistor", 1);
    expect(first.titles.map((thread) => thread.id).slice(0, 3)).toEqual([exact.id, prefix.id, contains.id]);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]!.snippet.toLowerCase()).toContain("resistor");
    expect(first.nextOffset).toBe(1);
    const second = store.threads.searchResults("resistor", 2, first.nextOffset!);
    expect(second.messages).toHaveLength(2);
    expect(second.nextOffset).toBeNull();
    expect([first, second].flatMap((page) => page.messages).some((hit) => hit.thread.id === prefix.id && hit.thread.archived)).toBe(true);
  } finally { store.close(); }
});
