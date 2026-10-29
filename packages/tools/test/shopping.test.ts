import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CartItem, NetlistComponent } from "@fabdesk/protocol";
import {
  BOM_SOURCE,
  CloudService,
  bomLinesFromNetlist,
  bomLinesFromOffboard,
  createRegistry,
  excludedFromBom,
  fieldValue,
  gitRemotes,
  makeContext,
  mergeBomItems,
  parseGitRemotes,
  shoppingListPromptText,
  stripCredentials,
  type ProjectHandle,
} from "../src";
import { fakeCloud } from "./fake-cloud";
import { mockServices, tempProject } from "./mock-services";

const comp = (ref: string, value: string, footprint: string, fields?: Record<string, string>): NetlistComponent => ({
  ref,
  value,
  footprint,
  ...(fields ? { fields } : {}),
});

const R0603 = "Resistor_SMD:R_0603_1608Metric";
const C0402 = "Capacitor_SMD:C_0402_1005Metric";

describe("BOM lines from the netlist", () => {
  test("groups by value + footprint + MPN/manufacturer, counts, sorts refs naturally", () => {
    const lines = bomLinesFromNetlist(
      [
        comp("R10", "10k", R0603),
        comp("R2", "10k", R0603),
        comp("R1", "10k", R0603),
        comp("C1", "100nF", C0402, { mpn: "GRM155R71C104KA88D", Manufacturer: "Murata", LCSC: "C1525" }),
        comp("C2", "100nF", C0402, { MPN: "GRM155R71C104KA88D", manufacturer: "Murata" }),
        comp("C3", "100nF", C0402),
        comp("#PWR01", "GND", ""),
        comp("R3", "10k", R0603, { DNP: "yes" }),
        comp("U1", "RP2040", "Package_DFN_QFN:QFN-56", { in_bom: "no" }),
      ],
      { destinationId: "builtin:jlcpcb" },
    );
    expect(lines.map((l) => [l.refs, l.quantity])).toEqual([
      [["C1", "C2"], 2],
      [["C3"], 1],
      [["R1", "R2", "R10"], 3],
    ]);
    expect(lines[0]).toMatchObject({
      kind: "part",
      mpn: "GRM155R71C104KA88D",
      manufacturer: "Murata",
      sku: "C1525",
      value: "100nF",
      footprint: C0402,
      destinationId: "builtin:jlcpcb",
    });
    expect(lines[1]!.mpn).toBeUndefined();
  });

  test("field lookup is case-insensitive and ignores ~ placeholders", () => {
    expect(fieldValue({ Mpn: " X1 " }, "mpn")).toBe("X1");
    expect(fieldValue({ MPN: "~" }, "mpn")).toBeUndefined();
    expect(excludedFromBom(comp("#FLG1", "PWR_FLAG", ""))).toBe(true);
    expect(excludedFromBom(comp("R1", "1k", R0603, { dnp: "0" }))).toBe(false);
  });
});

const item = (over: Partial<CartItem> & Pick<CartItem, "id">): CartItem => ({
  kind: "part",
  quantity: 1,
  status: "needed",
  destinationId: "builtin:jlcpcb",
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

describe("BOM lines from off-board parts", () => {
  test("keeps qty and a stable offboard footprint for re-sync", () => {
    const lines = bomLinesFromOffboard(
      [
        {
          id: "line_m",
          catalogId: "nema-17-stepper",
          ref: "M1",
          name: "NEMA 17 stepper motor",
          kind: "motor",
          qty: 2,
          mpn: "17HS4401",
        },
      ],
      { destinationId: "builtin:jlcpcb" },
    );
    expect(lines).toEqual([
      {
        kind: "part",
        value: "NEMA 17 stepper motor",
        footprint: "offboard:nema-17-stepper",
        description: "Off-board motor · NEMA 17 stepper motor",
        refs: ["M1"],
        quantity: 2,
        destinationId: "builtin:jlcpcb",
        mpn: "17HS4401",
      },
    ]);
  });
});

describe("BOM merge", () => {
  test("keeps destination/status/notes of matched lines, keeps manual lines, drops removed parts, adds a PCB line", () => {
    const fresh = bomLinesFromNetlist(
      [
        comp("R1", "10k", R0603),
        comp("R2", "10k", R0603),
        comp("U1", "LDO", "SOT-23", { MPN: "AP2112K-3.3" }),
      ],
      { destinationId: "builtin:jlcpcb" },
    );
    const existing: CartItem[] = [
      item({ id: "a", value: "10k", footprint: R0603, refs: ["R1"], destinationId: "builtin:manual", status: "ordered", notes: "from the drawer" }),
      item({ id: "b", mpn: "ap2112k-3.3", value: "old", refs: ["U1"], destinationId: "dest-th", unitPrice: 0.2, currency: "USD" }),
      item({ id: "c", value: "1uF", footprint: C0402, refs: ["C9"] }),
      item({ id: "d", kind: "other", description: "Solder paste", quantity: 1, destinationId: "builtin:amazon" }),
      item({ id: "e", description: "Spare header", refs: [] }),
    ];
    const { items, summary } = mergeBomItems(fresh, existing, { projectName: "Blinky", fabDestinationId: "builtin:jlcpcb" });
    expect(summary).toEqual({ parts: 2, matched: 2, added: 0, removed: 1, kept: 2, pcbAdded: true });
    expect(items[0]).toEqual({ kind: "pcb", description: "PCB – Blinky", quantity: 5, destinationId: "builtin:jlcpcb" });
    expect(items[1]).toMatchObject({ refs: ["R1", "R2"], quantity: 2, destinationId: "builtin:manual", status: "ordered", notes: "from the drawer" });
    expect(items[2]).toMatchObject({ mpn: "AP2112K-3.3", destinationId: "dest-th", unitPrice: 0.2, currency: "USD", status: "needed" });
    expect(items.slice(3).map((i) => i.description)).toEqual(["Solder paste", "Spare header"]);
    expect(items.some((i) => "id" in i)).toBe(false);
  });

  test("an existing PCB line is kept instead of adding another", () => {
    const { items, summary } = mergeBomItems([], [item({ id: "p", kind: "pcb", description: "PCB", quantity: 10 })], {
      projectName: "X",
      fabDestinationId: "builtin:jlcpcb",
    });
    expect(summary.pcbAdded).toBe(false);
    expect(items).toEqual([{ kind: "pcb", description: "PCB", quantity: 10, status: "needed", destinationId: "builtin:jlcpcb" }]);
  });
  test("partial assembly imports retain unmatched saved items and never infer a generic PCB order", () => {
    const existing = [{ id: "old", kind: "part", refs: ["missing:R1"], value: "Unavailable board part", footprint: "old", quantity: 3, destinationId: "builtin:manual", status: "ordered", notes: "Keep this purchase record" }] as CartItem[];
    const result = mergeBomItems([{ kind: "part", refs: ["left:R1", "right:R1"], value: "1k", footprint: R0603, quantity: 2, destinationId: "builtin:lcsc" }], existing, { projectName: "Assembly", fabDestinationId: "builtin:jlcpcb", addPcb: false, keepUnmatched: true });
    expect(result.items.map(item => [item.kind, item.quantity])).toEqual([["part", 2], ["part", 3]]);
    expect(result.items[1]).toMatchObject({ status: "ordered", notes: "Keep this purchase record", destinationId: "builtin:manual", refs: ["missing:R1"] });
    expect(result.summary).toMatchObject({ removed: 0, kept: 1, pcbAdded: false });
  });
});

describe("git remotes", () => {
  test("parses remote urls and strips https credentials", async () => {
    const cfg = `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://user:tok@github.com/fabPlane/blinky.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[remote "up"]\n\turl = git@github.com:acme/blinky.git\n[branch "main"]\n\tremote = origin\n`;
    expect(parseGitRemotes(cfg)).toEqual(["https://github.com/fabPlane/blinky.git", "git@github.com:acme/blinky.git"]);
    expect(stripCredentials("ssh://git@host/x")).toBe("ssh://git@host/x");
    const project = await tempProject("git");
    await mkdir(join(project.dir, ".git"), { recursive: true });
    await writeFile(join(project.dir, ".git", "config"), cfg);
    expect(await gitRemotes(project.dir)).toHaveLength(2);
    expect(await gitRemotes(join(project.dir, "nope"))).toEqual([]);
  });
});

async function setup(opts: { token?: string | null; cloud?: boolean; orgSetting?: string | null } = {}) {
  const project = await tempProject("shop");
  const api = fakeCloud();
  const token = opts.token === undefined ? "fpd_test" : opts.token;
  const cloud = new CloudService({
    apiOrigin: "https://api.fabplane.com",
    token: () => token,
    orgSetting: () => opts.orgSetting ?? null,
    api: api.factory,
  });
  const services = mockServices([project], opts.cloud === false ? {} : { cloud });
  const registry = createRegistry();
  const invoke = (name: string, args: unknown = {}, p: ProjectHandle | null = project) =>
    registry.invoke(name, args, () => makeContext({ services, project: p }));
  return { project, api, cloud, invoke, registry };
}

describe("shopping toolset", () => {
  test("registers the shopping tools outside core", async () => {
    const { registry } = await setup();
    expect(registry.byToolset("shopping").map((t) => t.name)).toEqual([
      "shopping_list_get",
      "shopping_list_add",
      "shopping_list_update",
      "shopping_list_remove",
      "shopping_list_sync_bom",
      "shopping_list_destinations",
      "inventory_search",
      "inventory_add",
    ]);
    expect(registry.get("shopping_list_remove")!.annotations.destructiveHint).toBe(true);
    expect(registry.get("inventory_search")!.scope).toBe("global");
  });

  test("get before creation, sync from the BOM, edit, re-sync keeps edits", async () => {
    const { invoke, api, project } = await setup();
    const empty = await invoke("shopping_list_get");
    expect((empty.json as { cart: unknown }).cart).toBeNull();
    expect(empty.text).toContain("no shopping list yet");

    const synced = await invoke("shopping_list_sync_bom", { allowPartial: true });
    const cart = (synced.json as { cart: { id: string; name: string; projectId: string; items: CartItem[] } }).cart;
    expect(cart.name).toBe("shop");
    expect(cart.projectId).toBe(project.id);
    expect(api.lastReplaceSource).toBe(BOM_SOURCE);
    expect(cart.items.map((i) => [i.kind, i.quantity])).toEqual([
      ["pcb", 5],
      ["part", 1],
    ]);
    expect(synced.text).toContain("https://app.fabplane.com/dashboard/carts/");

    const part = cart.items.find((i) => i.kind === "part")!;
    const moved = await invoke("shopping_list_update", { itemId: part.id, destination: "manual", status: "ordered", notes: "have some" });
    expect((moved.json as { item: CartItem }).item).toMatchObject({ destinationId: "builtin:manual", status: "ordered" });

    const again = await invoke("shopping_list_sync_bom", { allowPartial: true });
    const items = (again.json as { cart: { items: CartItem[] } }).cart.items;
    expect(items.filter((i) => i.kind === "pcb")).toHaveLength(1);
    expect(items.find((i) => i.kind === "part")).toMatchObject({ destinationId: "builtin:manual", status: "ordered", notes: "have some", refs: ["R1"] });
    expect(api.calls.filter((c) => c.startsWith("createCart"))).toHaveLength(1);
  });

  test("BOM sync includes off-board motors next to netlist parts", async () => {
    const { invoke, project } = await setup();
    await writeFile(
      join(project.dir, "project.parts.json"),
      JSON.stringify({
        schema: 1,
        parts: [
          {
            id: "line_m",
            catalogId: "nema-17-stepper",
            ref: "M1",
            name: "NEMA 17 stepper motor",
            kind: "motor",
            qty: 2,
            mpn: "17HS4401",
          },
        ],
      }),
    );
    const synced = await invoke("shopping_list_sync_bom", { allowPartial: true });
    const items = (synced.json as { cart: { items: CartItem[] } }).cart.items;
    expect(items.map((i) => [i.kind, i.refs?.[0], i.quantity])).toEqual([
      ["pcb", undefined, 5],
      ["part", "R1", 1],
      ["part", "M1", 2],
    ]);
    expect(items.find((i) => i.refs?.[0] === "M1")).toMatchObject({
      mpn: "17HS4401",
      footprint: "offboard:nema-17-stepper",
      description: "Off-board motor · NEMA 17 stepper motor",
    });
  });

  test("assembly sync reviews source coverage before creating a cloud list and uses declared instance quantities", async () => {
    const { project, invoke, api } = await setup();
    await mkdir(join(project.dir, "boards/io"), { recursive: true });
    await writeFile(join(project.dir, "boards/io/board.kicad_pcb"), "isolated source");
    await writeFile(join(project.dir, "boards/io/circuit.netlist.json"), JSON.stringify({ netlist: { components: [comp("R2", "10k", R0603), comp("#PWR1", "GND", ""), comp("R3", "DNP", R0603, { DNP: "yes" })], nets: [] } }));
    await writeFile(join(project.dir, "fabplane.assembly.json"), JSON.stringify({ contract: "fabplane.assembly.v1", sources: [{ id: "io", name: "I/O", location: "project", directory: "boards/io" }, { id: "missing", name: "Missing", location: "unresolved", provenance: { repository: "https://example.com/test", path: "missing" } }], instances: [{ id: "left", sourceId: "io", name: "Left" }, { id: "right", sourceId: "io", name: "Right" }, { id: "missing", sourceId: "missing", name: "Missing" }], connections: [] }));
    await expect(invoke("shopping_list_sync_bom")).rejects.toThrow("coverage");
    await expect(invoke("shopping_list_sync_bom", { allowPartial: true, expectedRevision: "0".repeat(64) })).rejects.toThrow("changed");
    expect(api.calls.some(call => call.startsWith("createCart"))).toBe(false);
    const result = await invoke("shopping_list_sync_bom", { allowPartial: true });
    const items = (result.json as { cart: { items: CartItem[] } }).cart.items;
    expect(items.map(item => [item.kind, item.refs, item.quantity])).toEqual([["part", ["left:R2", "right:R2"], 2]]);
    expect((result.json as { summary: { pcbAdded: boolean } }).summary.pcbAdded).toBe(false);
  });

  test("add resolves destination names, custom destinations, remove", async () => {
    const { invoke, api } = await setup();
    const added = await invoke("shopping_list_destinations", {
      add: { name: "DigiKey Thailand", url: "https://www.digikey.co.th", baseId: "builtin:digikey" },
    });
    expect(added.text).toContain("Added destination DigiKey Thailand");
    const custom = api.custom[0]!;
    const res = await invoke("shopping_list_add", {
      items: [
        { mpn: "ESP32-C3-MINI-1", quantity: 2, destination: "digikey thailand" },
        { kind: "other", description: "Flux pen", quantity: 1, destination: "amazon" },
      ],
    });
    const out = res.json as { added: CartItem[] };
    expect(out.added.map((i) => i.destinationId)).toEqual([custom.id, "builtin:amazon"]);
    expect(res.text).toContain("DigiKey Thailand");
    await expect(invoke("shopping_list_add", { items: [{ quantity: 1, destination: "Nowhere" }] })).rejects.toThrow(/unknown destination "Nowhere"/);
    await invoke("shopping_list_remove", { itemId: out.added[1]!.id });
    const after = await invoke("shopping_list_get");
    expect((after.json as { cart: { items: CartItem[] } }).cart.items).toHaveLength(1);
    await expect(invoke("shopping_list_remove", { itemId: "missing" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("uses Settings.cloudOrgId when the caller belongs to it", async () => {
    const { invoke, api } = await setup({ orgSetting: "org-team" });
    await invoke("shopping_list_add", { items: [{ description: "x", quantity: 1 }] });
    expect([...api.carts.values()][0]!.orgId).toBe("org-team");
    const other = await setup({ orgSetting: "org-gone" });
    await other.invoke("shopping_list_add", { items: [{ description: "x", quantity: 1 }] });
    expect([...other.api.carts.values()][0]!.orgId).toBe("org-personal");
  });

  test("inventory add never asks for server AI and search finds it", async () => {
    const { invoke, api } = await setup();
    await expect(invoke("inventory_add", { name: "x", serverAiProcessing: true })).rejects.toThrow(/invalid arguments/);
    const added = await invoke("inventory_add", {
      name: "AMS1117-3.3",
      mpn: "AMS1117-3.3",
      quantity: 40,
      location: "drawer A3",
      attributes: { package: "SOT-223", vout: 3.3 },
    });
    expect((added.json as { item: { source: string; quantity: number } }).item).toMatchObject({ source: "fabdesk", quantity: 40 });
    const found = await invoke("inventory_search", { q: "ams1117" });
    expect((found.json as { items: unknown[] }).items).toHaveLength(1);
    expect(found.text).toContain("drawer A3");
    expect(api.calls).toContain("listInventory org-personal ams1117");
  });

  test("signed out or not wired: unavailable with a sign-in hint", async () => {
    const signedOut = await setup({ token: null });
    await expect(signedOut.invoke("shopping_list_get")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("Sign in to fabplane") });
    const none = await setup({ cloud: false });
    await expect(none.invoke("inventory_search", {})).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("Sign in to fabplane") });
  });

  test("the shopping_list prompt text names the tools and the request", () => {
    const text = shoppingListPromptText("move passives to LCSC", "blinky");
    expect(text).toContain('load_toolset {"toolset":"shopping"}');
    expect(text).toContain("shopping_list_sync_bom");
    expect(text).toContain('project="blinky"');
    expect(text).toContain("Request: move passives to LCSC");
  });
});
