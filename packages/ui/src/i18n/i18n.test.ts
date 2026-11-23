import { describe, expect, test } from "bun:test";
import { APP_LOCALES, detectAppLocale, matchAppLocale, resolveUiLocale } from "@fabdesk/protocol";
import { messages as en, type MessageKey } from "./catalogs/en";
import { formatMessage } from "./format";
import { GLOSSARY, glossaryCoverage, glossaryTerm } from "./glossary";
import { loadCatalog } from "./load";
import { toPseudoCatalog, toPseudoString } from "./pseudo";
import { applyCommentTranslation, buildTranslateCommentPrompt, translationKeepsOriginal } from "./translate-comment";

const keys = Object.keys(en) as MessageKey[];

function placeholders(template: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let token = "";
  for (const ch of template) {
    if (ch === "{") {
      if (depth === 0) token = "";
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        const name = token.split(",")[0]?.trim();
        if (name) names.push(name);
      }
      continue;
    }
    if (depth === 1) token += ch;
  }
  return names.sort();
}

describe("catalog key parity", () => {
  test("every shipped locale has the same keys and ICU placeholders as English", async () => {
    for (const locale of APP_LOCALES) {
      const catalog = await loadCatalog(locale);
      expect(Object.keys(catalog).sort()).toEqual(keys.slice().sort());
      for (const key of keys) {
        expect(placeholders(catalog[key])).toEqual(placeholders(en[key]));
      }
    }
  });

  test("pseudo-locale keeps keys and tokens", () => {
    const catalog = toPseudoCatalog(en);
    expect(Object.keys(catalog).sort()).toEqual(keys.slice().sort());
    expect(catalog["common.settings"].startsWith("[[[")).toBe(true);
    expect(placeholders(catalog["board.pinCount"])).toEqual(placeholders(en["board.pinCount"]));
  });
});

describe("glossary", () => {
  test("every term has a non-empty translation in every locale", () => {
    expect(glossaryCoverage()).toEqual([]);
  });

  test("a glossary term uses one official form in each catalog", async () => {
    for (const locale of APP_LOCALES) {
      const catalog = await loadCatalog(locale);
      const blob = Object.values(catalog).join("\n");
      for (const entry of GLOSSARY) {
        const official = entry.translations[locale];
        expect(official.length).toBeGreaterThan(0);
        const english = entry.en;
        if (official === english) continue;
        const wrong = unofficialVariants(entry.id, locale);
        for (const variant of wrong) {
          expect(blob.includes(variant), `${locale} ${entry.id} should not use ${variant}`).toBe(false);
        }
      }
    }
  });

  test("glossaryTerm is stable", () => {
    expect(glossaryTerm("de", "net")).toBe("Netz");
    expect(glossaryTerm("ja", "footprint")).toBe("フットプリント");
    expect(glossaryTerm("th", "drc")).toBe("DRC");
  });
});

function unofficialVariants(id: string, locale: string): string[] {
  if (id === "net" && locale === "ja") return ["ネットワーク"];
  if (id === "net" && locale === "de") return ["Netzwerkname"];
  if (id === "footprint" && locale === "zh-Hans") return ["脚印"];
  return [];
}

describe("ICU format", () => {
  test("plural and select", () => {
    expect(formatMessage("{count, plural, one {# pin} other {# pins}}", { count: 1 }, "en")).toBe("1 pin");
    expect(formatMessage("{count, plural, one {# pin} other {# pins}}", { count: 3 }, "en")).toBe("3 pins");
    expect(formatMessage("{status, select, resolved {Resolved} other {Pending}}", { status: "resolved" })).toBe("Resolved");
    expect(formatMessage("{status, select, resolved {Resolved} other {Pending}}", { status: "open" })).toBe("Pending");
  });
});

describe("locale auto-detect", () => {
  test("maps OS tags onto shipped locales", () => {
    expect(matchAppLocale("ja-JP")).toBe("ja");
    expect(matchAppLocale("zh-TW")).toBe("zh-Hant");
    expect(matchAppLocale("zh-CN")).toBe("zh-Hans");
    expect(matchAppLocale("pt-BR")).toBe("pt-BR");
    expect(matchAppLocale("th_TH.UTF-8")).toBe("th");
    expect(matchAppLocale("de-AT")).toBe("de");
    expect(detectAppLocale({ languages: ["xx-YY", "ko-KR"] })).toBe("ko");
    expect(detectAppLocale({ languages: [] })).toBe("en");
  });

  test("system choice follows the host; a saved locale wins", () => {
    expect(resolveUiLocale("system", "th")).toBe("th");
    expect(resolveUiLocale("de", "th")).toBe("de");
    expect(resolveUiLocale(null, "ja")).toBe("ja");
  });
});

describe("translate comment", () => {
  test("keeps the original and identifiers", () => {
    const result = applyCommentTranslation("Check USB_D+ on U12", "U12 の USB_D+ を確認", "ja");
    expect(result.original).toBe("Check USB_D+ on U12");
    expect(result.translated).toContain("USB_D+");
    expect(result.identifiers).toEqual(expect.arrayContaining(["USB_D+", "U12"]));
    expect(translationKeepsOriginal(result)).toBe(true);
    const prompt = buildTranslateCommentPrompt(
      {
        question: "Why is USB_D+ shorted to GND?",
        anchor: { view: "pcb", ref: "U12", net: "USB_D+" },
      },
      "de",
    );
    expect(prompt).toContain("USB_D+");
    expect(prompt).toContain("U12");
    expect(prompt).toContain("German");
    expect(prompt).toContain("Do not replace the original");
  });
});

describe("pseudo-locale overflow", () => {
  const screens: MessageKey[] = [
    "settings.title",
    "shell.whatsNew",
    "sidebar.projects",
    "chat.placeholder",
    "board.workspace",
    "privacy.title",
    "whatsNew.title",
    "order.title",
  ];

  test("key screens expand in the pseudo-locale so layout overflow is visible", () => {
    for (const key of screens) {
      const pseudo = toPseudoString(en[key]);
      expect(pseudo.length).toBeGreaterThan(en[key].length + 6);
    }
  });
});
