import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import {
  copperBoard,
  projectPairs,
  quality,
  compareQuality,
  netFacts,
} from "../src/routing-quality";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const seg = (net: string, length = 1, width = 0.3, locked = false) =>
  `(segment ${locked ? "locked" : ""} (start 0 0) (end ${length} 0) (width ${width}) (layer "F.Cu") (net "${net}") (uuid "${net}"))`;
const pcb = (length = 1, other = 1, p = "D_P", n = "D_N", locked = false) =>
  `(kicad_pcb (net "${p}") (net "${n}") (net "LED") ${seg(p, length, 0.3, locked)} ${seg(n)} ${seg("LED", other)})`;
const summary = (extra: any = {}) => ({
  tracks: 2,
  vias: 0,
  claimedVias: 0,
  routed: 2,
  total: 2,
  trackLengthNm: 2e6,
  elapsedMs: 1,
  wallMs: 1,
  timedOut: false,
  message: "route",
  unrouted: [],
  log: [],
  ...extra,
});
async function fixture(name: string, start = pcb(), settings: any = {}) {
  const project = await tempProject(name);
  await writeFile(join(project.dir, "board.kicad_pcb"), start);
  await writeFile(join(project.dir, "board.kicad_pro"), JSON.stringify(settings));
  return project;
}
async function invoke(project: any, services: any, args: any = {}) {
  const registry = createRegistry(),
    factory = contextFactory(services, project);
  const response = await registry.invoke(
    "route_run",
    { router: "fab_router", waitMs: 1000, ...args },
    (ref) =>
      factory({
        def: registry.get("route_run")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
  );
  return { response, run: services.routeRuns.get((response.json as any).run.id)! };
}
for (const missing of [false, true])
  test(`#1 router failure cannot complete a scoped run; missing TraceMaker=${missing}`, async () => {
    const project = await fixture(`review-error-${missing}`),
      base = mockServices([project]);
    const services = mockServices([project], {
      design: {
        ...base.design,
        query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
        route: async () => {
          throw Error("missing router binary");
        },
      },
    });
    if (missing) {
      await expect(
        invoke(project, services, { router: "tracemaker", onlyConnections: ["LED"] }),
      ).rejects.toThrow("not installed");
      return;
    }
    const { run } = await invoke(project, services, { onlyConnections: ["LED"] });
    expect(run.state).toBe("failed");
    expect(run.candidate.available).toBe(false);
    expect(run.application.state).toBe("not_available");
  });
test("#2 Power assignments with KiCad default pair fields do not constrain VBAT rails", async () => {
  const project = await fixture("review-power", pcb(1, 1, "VBAT+", "VBAT-"), {
    net_settings: {
      classes: [{ name: "Power", track_width: 0.5, diff_pair_width: 0.2, diff_pair_gap: 0.15 }],
      netclass_assignments: { "VBAT+": "Power", "VBAT-": "Power" },
      netclass_patterns: [{ pattern: "*", netclass: "Power" }],
    },
  });
  const pairs = await projectPairs(project.dir, copperBoard(pcb(1, 1, "VBAT+", "VBAT-")));
  expect(pairs).toEqual([{ p: "VBAT+", n: "VBAT-", source: "identified by name" }]);
});
test("#3 automatic whole-board fallback must not erase first-pass copper in a pair retry", async () => {
  const project = await fixture("review-fallback-pair"),
    base = mockServices([project]);
  project.manifest().router = undefined;
  let calls = 0;
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
      unroute: async (dir) => {
        await writeFile(join(dir, "board.kicad_pcb"), pcb(0, 2));
        return { tracks: 2, vias: 0 };
      },
      route: async (dir, opts) => {
        calls++;
        if (calls === 1) {
          await writeFile(join(dir, "board.kicad_pcb"), pcb(3, 2));
          return summary();
        }
        if (opts.router === "freerouting") {
          await writeFile(join(dir, "board.kicad_pcb"), pcb(9));
          throw Error("freerouting failed");
        }
        expect(await readFile(join(dir, "board.kicad_pcb"), "utf8")).toBe(pcb(0, 2));
        return summary();
      },
    },
  });
  const { run } = await invoke(project, services, {
    router: undefined,
    rules: { pairs: [{ p: "D_P", n: "D_N" }] },
  });
  expect(run.router).toBe("freerouting");
  expect(
    await readFile(join(project.dir, run.artifacts.runDir, "router.log"), "utf8"),
  ).not.toContain("Expected:");
  expect(run.attempts).toHaveLength(1);
});
for (const mode of ["never", "whole", "locked"] as const)
  test(`#4 pair retry respects ${mode} copper retention`, async () => {
    const project = await fixture(
        `review-mode-${mode}`,
        pcb(1, 1, "D_P", "D_N", mode === "locked"),
      ),
      base = mockServices([project]);
    let clean = 0,
      calls = 0;
    const services = mockServices([project], {
      design: {
        ...base.design,
        query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
        unroute: async () => {
          clean++;
          return { tracks: 2, vias: 0 };
        },
        route: async (dir) => {
          calls++;
          await writeFile(join(dir, "board.kicad_pcb"), pcb(3, 1, "D_P", "D_N", mode === "locked"));
          return summary();
        },
      },
    });
    await invoke(project, services, {
      ...(mode !== "whole" ? { onlyConnections: ["D_P", "D_N"] } : {}),
      ...(mode === "never" ? { rerouteMode: "never" } : {}),
      rules: { pairs: [{ p: "D_P", n: "D_N" }] },
    });
    expect(clean).toBe(0);
    expect(calls).toBe(1);
  });
test("#5 scoped LED quality excludes an unrelated USB pair", async () => {
  const project = await fixture("review-quality-scope", pcb(3)),
    base = mockServices([project]);
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
      route: async () => summary(),
    },
  });
  const { run } = await invoke(project, services, {
    onlyConnections: ["LED"],
    rules: { pairs: [{ p: "D_P", n: "D_N" }] },
  });
  const q = JSON.parse(
    await readFile(join(project.dir, run.artifacts.runDir, "quality.json"), "utf8"),
  );
  expect(q.nets.map((n: any) => n.net)).toEqual(["LED"]);
  expect(q.pairs).toEqual([]);
});
test("#6 name-only rail skew remains measurable without holding application", async () => {
  const project = await fixture("review-rail-skew", pcb(1, 1, "VBAT+", "VBAT-")),
    base = mockServices([project]);
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
      route: async (dir) => {
        await writeFile(join(dir, "board.kicad_pcb"), pcb(3, 1, "VBAT+", "VBAT-"));
        return summary();
      },
    },
  });
  const { run } = await invoke(project, services);
  expect(run.application.state).toBe("applied");
  expect(run.result.quality.warnings).toEqual([]);
  const q = JSON.parse(
    await readFile(join(project.dir, run.artifacts.runDir, "quality.json"), "utf8"),
  );
  expect(q.pairs[0].skewMm).toBe(2);
});
test("#7 selected pair trial retains main-route log, diagnostics and measured board counts", async () => {
  const project = await fixture("review-pair-summary"),
    base = mockServices([project]);
  let calls = 0;
  const diagnostics = { text: "main route warning", nets: [] };
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
      unroute: async () => ({ tracks: 2, vias: 0 }),
      route: async (dir) => {
        calls++;
        await writeFile(join(dir, "board.kicad_pcb"), pcb(calls === 1 ? 3 : 1));
        return summary(
          calls === 1
            ? { tracks: 10, log: ["main route log"], diagnostics }
            : { tracks: 2, log: ["pair log"] },
        );
      },
    },
  });
  const { run } = await invoke(project, services, {
    onlyConnections: ["D_P", "D_N", "LED"],
    rules: { pairs: [{ p: "D_P", n: "D_N" }] },
  });
  expect(calls).toBe(2);
  expect(run.result.diagnostics).toEqual(diagnostics);
  expect(await readFile(join(project.dir, run.artifacts.runDir, "router.log"), "utf8")).toContain(
    "main route log",
  );
  expect(run.result.stats.segments).toBe(3);
});
test("#8 public quality text stays within 1800 UTF-8 bytes on 300 nets", async () => {
  const text = `(kicad_pcb ${Array.from({ length: 300 }, (_, i) => `(net "net-${i}-µ") ${seg(`net-${i}-µ`)}`).join(" ")})`;
  const project = await fixture("review-text-bound", text),
    base = mockServices([project]);
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
      route: async () => summary(),
    },
  });
  const { run } = await invoke(project, services);
  expect(Buffer.byteLength(run.result.quality.text)).toBeLessThanOrEqual(1800);
  const q = JSON.parse(
    await readFile(join(project.dir, run.artifacts.runDir, "quality.json"), "utf8"),
  );
  expect(q.nets).toHaveLength(300);
});
test("#9 narrowest retained width is the shared per-net floor", async () => {
  const project = await fixture(
      "review-width-floor",
      `(kicad_pcb (net "GND") ${seg("GND", 2, 0.2)} ${seg("GND", 1, 1.5)})`,
    ),
    base = mockServices([project]);
  let width: number | undefined;
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
      route: async (_dir, opts) => {
        width = (opts.settings as any).perNet[0].widthMm;
        return summary();
      },
    },
  });
  await invoke(project, services);
  expect(width).toBe(0.2);
});
test("#10 KiCad net patterns match hierarchical USB members", async () => {
  const text = pcb(1, 1, "/usb/USB_DP", "/usb/USB_DN");
  const project = await fixture("review-hierarchical-pair", text, {
    net_settings: {
      classes: [{ name: "Signals", diff_pair_width: 0.2, diff_pair_gap: 0.15 }],
      netclass_patterns: [{ pattern: "*USB_D*", netclass: "Signals" }],
    },
  });
  expect(await projectPairs(project.dir, copperBoard(text))).toEqual([
    { p: "/usb/USB_DP", n: "/usb/USB_DN", source: "native netclass", widthMm: 0.2, gapMm: 0.15 },
  ]);
});

test("#2 explicit KiCad pair rules mark the measured pair as constrained", async () => {
  const project = await fixture("review-native-pair-rule");
  await writeFile(
    join(project.dir, "board.kicad_dru"),
    `(version 1) (rule "USB pair" (condition "A.NetName == 'D_*'") (constraint diff_pair_gap (min 0.15mm)))`,
  );
  expect((await projectPairs(project.dir, copperBoard(pcb())))[0]?.source).toBe(
    "native diff-pair rule",
  );
});

test("pair intent excludes generic Power even when the net stem is POWER", async () => {
  const text = pcb(1, 1, "POWER+", "POWER-");
  const project = await fixture("review-generic-power", text, {
    net_settings: {
      classes: [{ name: "Power", diff_pair_width: 0.2, diff_pair_gap: 0.15 }],
      netclass_assignments: { "POWER+": "Power", "POWER-": "Power" },
    },
  });
  expect((await projectPairs(project.dir, copperBoard(text)))[0]?.source).toBe(
    "identified by name",
  );
});

test("ordinary Repair class is not an explicit pair class", async () => {
  const project = await fixture("review-repair-class", pcb(), {
    net_settings: {
      classes: [{ name: "Repair", diff_pair_width: 0.2 }],
      netclass_assignments: { D_P: "Repair", D_N: "Repair" },
    },
  });
  expect((await projectPairs(project.dir, copperBoard(pcb())))[0]?.source).toBe(
    "identified by name",
  );
});

test("native rule comments may contain parentheses and quoted net names may contain #", async () => {
  const text = pcb(1, 1, "USB#1_DP", "USB#1_DN");
  const project = await fixture("review-native-rule-comments", text);
  await writeFile(
    join(project.dir, "board.kicad_dru"),
    `(version 1)\n# a human comment (intentional unmatched parenthesis\n(rule "USB #1" (condition "A.NetName == 'USB#1_D*'") (constraint diff_pair_gap (min 0.15mm)))`,
  );
  expect((await projectPairs(project.dir, copperBoard(text)))[0]?.source).toBe(
    "native diff-pair rule",
  );
});

test("fresh review: hierarchy-only Power pattern is not pair intent", async () => {
  const text = pcb(1, 1, "/power/VBAT+", "/power/VBAT-");
  const project = await fixture("review-hierarchy-power", text, {
    net_settings: {
      classes: [{ name: "Power", track_width: 0.5, diff_pair_width: 0.2, diff_pair_gap: 0.15 }],
      netclass_patterns: [{ pattern: "/power/*", netclass: "Power" }],
    },
  });
  expect((await projectPairs(project.dir, copperBoard(text)))[0]?.source).toBe(
    "identified by name",
  );
});
for (const explicitPair of [false, true])
  test(`fresh review: explicit width precedence; declared pair=${explicitPair}`, async () => {
    const text = '(kicad_pcb (net "USB_DP") (net "USB_DN"))';
    const project = await fixture(`review-global-width-${explicitPair}`, text, {
        net_settings: {
          classes: [{ name: "USB", diff_pair_width: 0.2, diff_pair_gap: 0.15 }],
          netclass_patterns: [{ pattern: "USB_D*", netclass: "USB" }],
        },
      }),
      base = mockServices([project]);
    let options: any;
    const services = mockServices([project], {
      design: {
        ...base.design,
        query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
        route: async (_dir, opts) => {
          options = opts;
          return summary();
        },
      },
    });
    await invoke(project, services, {
      rules: {
        widthMm: 0.4,
        ...(explicitPair ? { pairs: [{ p: "USB_DP", n: "USB_DN", widthMm: 0.25 }] } : {}),
      },
    });
    expect(options.settings.perNet.map((p: any) => p.widthMm)).toEqual([
      explicitPair ? 0.25 : 0.4,
      explicitPair ? 0.25 : 0.4,
    ]);
    expect(options.settings.differentialPairs[0].widthMm).toBe(explicitPair ? 0.25 : 0.4);
  });
test("fresh review: native Default selector sees implicit class membership", async () => {
  const project = await fixture("review-native-default");
  await writeFile(
    join(project.dir, "board.kicad_dru"),
    `(version 1) (rule "Default pairs" (condition "A.NetClass == 'Default'") (constraint diff_pair_gap (min 0.2mm)))`,
  );
  expect((await projectPairs(project.dir, copperBoard(pcb())))[0]?.source).toBe(
    "native diff-pair rule",
  );
});
test("fresh review: entirely removed copper still supplies a narrowing baseline", () => {
  const original = copperBoard(`(kicad_pcb (net "GND") ${seg("GND", 1, 0.3)})`);
  const empty = copperBoard('(kicad_pcb (net "GND"))');
  const after = copperBoard(`(kicad_pcb (net "GND") ${seg("GND", 1, 0.2)})`);
  const comparison = compareQuality(
    quality(empty, ["GND"], [], netFacts(original)),
    quality(after, ["GND"]),
    { before: 1, after: 0 },
    0,
  );
  expect(comparison.warnings.map((w) => w.kind)).toContain("narrowing");
});

test("fresh review follow-up: explicit per-net widths outrank the global width", async () => {
  const project = await fixture(
      "review-per-net-precedence",
      '(kicad_pcb (net "USB_DP") (net "USB_DN"))',
      {
        net_settings: {
          classes: [{ name: "USB", diff_pair_width: 0.2 }],
          netclass_patterns: [{ pattern: "USB_D*", netclass: "USB" }],
        },
      },
    ),
    base = mockServices([project]);
  let options: any;
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
      route: async (_dir, opts) => {
        options = opts;
        return summary();
      },
    },
  });
  await invoke(project, services, {
    rules: {
      widthMm: 0.4,
      perNet: [
        { net: "USB_DP", widthMm: 0.25 },
        { net: "USB_DN", widthMm: 0.25 },
      ],
    },
  });
  expect(options.settings.perNet.map((p: any) => p.widthMm)).toEqual([0.25, 0.25]);
  expect(options.settings.differentialPairs[0].widthMm).toBe(0.25);
});
