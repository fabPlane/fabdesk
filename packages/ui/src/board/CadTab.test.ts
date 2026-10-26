import { describe, expect, test } from "bun:test";
import {
  CAD_FRAME_SANDBOX,
  CAD_KERNEL_TREE_POLL_MS,
  CadKernelTree,
  shouldShowCadKernelTree,
} from "./CadTab";

describe("CAD frame sandbox", () => {
  test("polls cad_kernels infrequently to avoid repeated SMLib probes", () => {
    expect(CAD_KERNEL_TREE_POLL_MS).toBeGreaterThanOrEqual(10_000);
  });

  test("kernel tree is shown only when a project is selected and data is loaded", () => {
    const model = { kernels: [], store: { parts: [], assembly: null } };
    expect(shouldShowCadKernelTree(null, model)).toBe(false);
    expect(shouldShowCadKernelTree("", model)).toBe(false);
    expect(shouldShowCadKernelTree("proj-1", null)).toBe(false);
    expect(shouldShowCadKernelTree("proj-1", model)).toBe(true);
  });

  test("lets the fab_cad SPA run at its own origin and nothing that escapes the frame", () => {
    const tokens = CAD_FRAME_SANDBOX.split(" ");
    for (const needed of ["allow-scripts", "allow-same-origin"]) expect(tokens).toContain(needed);
    for (const t of tokens) expect(t).not.toMatch(/top-navigation|popups-to-escape-sandbox/);
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CadScreen } from "./CadTab";
import type { CadSessionState } from "@fabdesk/client-core";
const offer = {
  version: "test-runtime",
  target: "darwin-arm64",
  minimumOS: "15.0",
  downloadBytes: 104857600,
  installedBytes: 524288000,
  sourceUrl: "https://github.com/fabPlane/FreeCAD/releases",
};
const session = { refresh: async () => {}, install: async () => {}, cancel: async () => {} };
const screen = (state: Partial<CadSessionState>, projectSelected = true) =>
  renderToStaticMarkup(
    createElement(CadScreen, {
      projectSelected,
      session,
      state: { runtime: null, busy: false, view: null, error: null, ...state },
    }),
  );
test("missing CAD shows installation with sizes and explicit consent", () => {
  const html = screen({ runtime: { status: "consent", offer } });
  expect(html).toContain("Install CAD bridge");
  expect(html).toContain("100.0 MiB");
  expect(html).toContain("500.0 MiB");
  expect(html).toContain("approve the download");
  expect(html).not.toContain("bun run");
});
test("failed and unsupported runtimes do not claim to be missing", () => {
  for (const status of ["error", "unsupported"] as const) {
    const html = screen({ runtime: { status, message: "Runtime unavailable" } });
    expect(html).not.toContain("Install CAD bridge");
    expect(html).not.toContain("not installed");
  }
});
test("download progress and verification have cancellation", () => {
  const html = screen({ runtime: { status: "downloading", offer, received: 52428800 } });
  expect(html).toContain('value="50"');
  expect(html).toContain("Cancel");
  expect(html).not.toContain("Install CAD bridge");
  expect(screen({ runtime: { status: "verifying", offer } })).toContain("Checking signature");
});
test("installed connection failure offers retry; running and no-project states remain separate", () => {
  const html = screen({ runtime: { status: "ready" }, error: "Connection failed" });
  expect(html).toContain("runtime is installed");
  expect(html).toContain("Retry connection");
  expect(html).not.toContain("Install CAD bridge");
  expect(screen({}, false)).toContain("No project selected");
  expect(screen({ busy: true })).toContain("Connecting to CAD");
  expect(
    screen({
      view: {
        bridgeUrl: "http://localhost",
        session: "one",
        wsUrl: "ws://localhost",
        uiUrl: "http://localhost",
        document: "model",
      },
    }),
  ).toContain('data-testid="cad-frame"');
});
test("kernel tree names the kernel that built each part and any fallback", () => {
  const html = renderToStaticMarkup(
    createElement(CadKernelTree, {
      model: {
        kernels: [
          { id: "opencascade", label: "OpenCascade (FreeCAD)", available: true },
          { id: "smlib", label: "SMLib (NVIDIA USD BRep)", available: true, experimental: true },
        ],
        store: {
          parts: [
            {
              id: "Grip",
              name: "Grip",
              kernel: "smlib",
              reason: "fell back to smlib",
              fallbacks: [{ from: "opencascade", to: "smlib", featureKind: "fillet", error: "G2" }],
              step: "cad/parts/Grip.step",
            },
          ],
          assembly: { step: "cad/assembly.step", partIds: ["Grip"] },
        },
      },
    }),
  );
  expect(html).toContain("data-testid=\"cad-kernel-tree\"");
  expect(html).toContain("kernel smlib");
  expect(html).toContain("opencascade→smlib");
  expect(html).toContain("cad/assembly.step");
  expect(html).toContain("experimental");
});
