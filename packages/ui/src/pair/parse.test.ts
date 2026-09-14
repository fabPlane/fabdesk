import { describe, expect, test } from "bun:test";
import { browserLabel, buildPairLink, isPairPath, normalizeHost, parsePairLink } from "./parse";

describe("isPairPath", () => {
  test("matches /pair with or without a trailing slash and nothing else", () => {
    expect(isPairPath("/pair")).toBe(true);
    expect(isPairPath("/pair/")).toBe(true);
    expect(isPairPath("/")).toBe(false);
    expect(isPairPath("/pairing")).toBe(false);
    expect(isPairPath("/app/pair")).toBe(false);
  });
});

describe("normalizeHost", () => {
  test("keeps only the origin", () => {
    expect(normalizeHost("https://mac.tailnet.ts.net/")).toBe("https://mac.tailnet.ts.net");
    expect(normalizeHost("https://mac.tailnet.ts.net/v1/health?x=1")).toBe(
      "https://mac.tailnet.ts.net",
    );
    expect(normalizeHost("http://100.64.0.1:47820")).toBe("http://100.64.0.1:47820");
  });

  test("rejects non-http schemes, junk and embedded credentials", () => {
    expect(normalizeHost("ftp://x")).toBeNull();
    expect(normalizeHost("not a url")).toBeNull();
    expect(normalizeHost("javascript:alert(1)")).toBeNull();
    expect(normalizeHost("https://user:pw@mac.tailnet.ts.net")).toBeNull();
  });
});

describe("parsePairLink", () => {
  const https = (search: string, hash: string) =>
    parsePairLink({ search, hash, pageProtocol: "https:" });

  test("reads the host from the query and the token from the fragment", () => {
    expect(https("?host=https%3A%2F%2Fmac.tailnet.ts.net", "#token=abc123")).toEqual({
      ok: true,
      host: "https://mac.tailnet.ts.net",
      token: "abc123",
    });
  });

  test("accepts the leading ? and # being absent", () => {
    expect(https("host=https://mac.tailnet.ts.net", "token=abc")).toMatchObject({
      ok: true,
      token: "abc",
    });
  });

  test("refuses a plain-http computer from an https page, with a mixed-content explanation", () => {
    const r = https("?host=http://100.64.0.1:47820", "#token=abc");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("insecure-host");
      expect(r.message).toMatch(/HTTPS/);
    }
  });

  test("allows a plain-http computer when the page itself is http (local development)", () => {
    expect(
      parsePairLink({
        search: "?host=http://127.0.0.1:47820",
        hash: "#token=abc",
        pageProtocol: "http:",
      }),
    ).toEqual({
      ok: true,
      host: "http://127.0.0.1:47820",
      token: "abc",
    });
  });

  test("names what is missing", () => {
    expect(https("", "#token=abc")).toMatchObject({ ok: false, reason: "missing-host" });
    expect(https("?host=nope", "#token=abc")).toMatchObject({ ok: false, reason: "invalid-host" });
    expect(https("?host=https://mac.tailnet.ts.net", "")).toMatchObject({
      ok: false,
      reason: "missing-token",
    });
    expect(https("?host=https://mac.tailnet.ts.net", "#token=")).toMatchObject({
      ok: false,
      reason: "missing-token",
    });
  });

  test("a token in the query is ignored: it belongs in the fragment", () => {
    // The fragment is the one part of the URL a server never sees; a link that leaks the code
    // into the query is malformed and must not pair.
    expect(https("?host=https://mac.tailnet.ts.net&token=abc", "")).toMatchObject({
      ok: false,
      reason: "missing-token",
    });
  });
});

describe("buildPairLink", () => {
  test("round-trips through parsePairLink", () => {
    const link = buildPairLink("https://fabplane.com/", "https://mac.tailnet.ts.net", "t0k/en+x");
    expect(link).toBe(
      "https://fabplane.com/pair?host=https%3A%2F%2Fmac.tailnet.ts.net#token=t0k%2Fen%2Bx",
    );
    const u = new URL(link);
    expect(parsePairLink({ search: u.search, hash: u.hash, pageProtocol: u.protocol })).toEqual({
      ok: true,
      host: "https://mac.tailnet.ts.net",
      token: "t0k/en+x",
    });
  });
});

describe("browserLabel", () => {
  test("names the browser and platform", () => {
    expect(
      browserLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
    expect(
      browserLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
    expect(
      browserLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
      ),
    ).toBe("Firefox on Windows");
    expect(
      browserLabel(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
      ),
    ).toBe("Edge on Linux");
  });

  test("falls back rather than failing on an unknown agent", () => {
    expect(browserLabel("curl/8.0")).toBe("Browser");
  });
});
