import { expect, test } from "bun:test";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

// GHSA-cg2g-xh64-v4q7: removing a forbidden element joins harmless-looking
// fragments into a template expression. Sanitization must scrub shadow roots
// after that join too. Never evaluate the resulting text in this regression.
for (const fragments of [
  ["$", "{probe}"],
  ["{", "{probe}", "}"],
  ["<", "%probe%", ">"],
]) {
  for (const nested of [false, true]) {
    test(`scrubs split ${fragments.join("")} from ${nested ? "nested" : "attached"} shadow roots`, () => {
      const window = new JSDOM("").window;
      try {
        const purifier = createDOMPurify(window);
        const host = window.document.createElement("div");
        let shadow = host.attachShadow({ mode: "open" });
        if (nested) {
          const child = window.document.createElement("div");
          shadow.append(child);
          shadow = child.attachShadow({ mode: "open" });
        }
        for (const [index, fragment] of fragments.entries()) {
          if (index > 0) shadow.append(window.document.createElement("object"));
          shadow.append(window.document.createTextNode(fragment));
        }
        purifier.sanitize(host, { IN_PLACE: true, SAFE_FOR_TEMPLATES: true });
        shadow.normalize();
        expect(shadow.querySelector("object")).toBeNull();
        expect(shadow.textContent).not.toContain(fragments.join(""));
      } finally {
        window.close();
      }
    });
  }
}

test("ordinary diagram labels survive while executable markup is removed", () => {
  const window = new JSDOM("").window;
  try {
    const purifier = createDOMPurify(window);
    const clean = purifier.sanitize(
      '<svg><text>R1 · 1k</text><path d="M0 0L10 10"/></svg><img onerror="probe()"><script>probe()</script>',
    );
    expect(clean).toContain("R1 · 1k");
    expect(clean).toContain("<path");
    expect(clean).not.toContain("onerror");
    expect(clean).not.toContain("<script");
  } finally {
    window.close();
  }
});
