import { expect, test } from "bun:test";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const hooks = [
  "beforeSanitizeElements",
  "uponSanitizeElement",
  "afterSanitizeElements",
  "beforeSanitizeAttributes",
  "afterSanitizeAttributes",
] as const;

// GHSA-mrv2-3pqr-j5jr: hooks may detach a different node from the one being
// visited. Inspect that detached node too, not just the sanitized return value.
for (const hook of hooks) {
  for (const mode of ["parent", "sibling"] as const) {
    test(`${hook} neutralizes handlers when a hook detaches the ${mode}`, () => {
      const window = new JSDOM("").window;
      try {
        const purifier = createDOMPurify(window);
        const root = window.document.createElement("div");
        root.innerHTML =
          '<figure><img class="drop"><img id="unsafe" onerror="probe()"></figure><p>Safe text</p>';
        const unsafe = root.querySelector("#unsafe")!;
        purifier.addHook(hook, (node) => {
          if (!(node instanceof window.Element) || node.getAttribute("class") !== "drop") return;
          if (mode === "parent") node.parentElement?.remove();
          else node.nextElementSibling?.remove();
        });
        purifier.sanitize(root, { IN_PLACE: true });
        expect(root.contains(unsafe)).toBe(false);
        expect(unsafe.getAttribute("onerror")).toBeNull();
        expect(root.textContent).toContain("Safe text");
      } finally {
        window.close();
      }
    });
  }
}
