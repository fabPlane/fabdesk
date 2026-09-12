import { describe, expect, test } from "bun:test";
import { createShortcutRegistry } from "./shortcut-registry";

describe("createShortcutRegistry", () => {
  test("dispatches to the registered handler by canonical id", () => {
    const r = createShortcutRegistry();
    const calls: string[] = [];
    r.register("Cmd+N", () => calls.push("new"));
    expect(r.dispatch("cmd+n")).toBe(true);
    expect(calls).toEqual(["new"]);
    expect(r.dispatch("cmd+k")).toBe(false);
  });

  test("the newest handler wins and the older one returns when it is removed", () => {
    const r = createShortcutRegistry();
    const calls: string[] = [];
    r.register("cmd+k", () => calls.push("list"));
    const offThread = r.register("cmd+k", () => calls.push("thread"))!;
    r.dispatch("cmd+k");
    offThread();
    r.dispatch("cmd+k");
    expect(calls).toEqual(["thread", "list"]);
  });

  test("removing the older handler keeps the newer one active", () => {
    const r = createShortcutRegistry();
    const calls: string[] = [];
    const offA = r.register("cmd+k", () => calls.push("a"))!;
    r.register("cmd+k", () => calls.push("b"));
    offA();
    r.dispatch("cmd+k");
    expect(calls).toEqual(["b"]);
  });

  test("reports the id set only when it changes", () => {
    const changes: string[][] = [];
    const r = createShortcutRegistry((ids) => changes.push(ids));
    const off1 = r.register("cmd+n", () => {})!;
    const off2 = r.register("n+cmd", () => {})!;
    r.register("cmd+k", () => {});
    expect(changes).toEqual([["cmd+n"], ["cmd+n", "cmd+k"]]);
    off1();
    expect(changes.length).toBe(2);
    off2();
    expect(changes).toEqual([["cmd+n"], ["cmd+n", "cmd+k"], ["cmd+k"]]);
    expect(r.ids()).toEqual(["cmd+k"]);
  });

  test("rejects an invalid combo and unregistering twice is harmless", () => {
    const r = createShortcutRegistry();
    expect(r.register("cmd", () => {})).toBeNull();
    const off = r.register("cmd+n", () => {})!;
    off();
    off();
    expect(r.ids()).toEqual([]);
  });

  test("the same function registered twice is removed one at a time", () => {
    const r = createShortcutRegistry();
    let n = 0;
    const fn = () => n++;
    const off1 = r.register("cmd+n", fn)!;
    r.register("cmd+n", fn);
    off1();
    expect(r.dispatch("cmd+n")).toBe(true);
    expect(n).toBe(1);
  });
});
