import { describe, expect, test } from "bun:test";
import type { Credentials } from "@fabdesk/auth-client";
import { storedCredentialToken } from "../src/cloud";

const creds = (over: Partial<Credentials> = {}): Credentials => ({
  version: 1,
  apiOrigin: "http://staging.example:4000",
  token: "fpd_stored",
  subject: "password:maya@fabplane.dev",
  obtainedAt: "2026-09-28T00:00:00.000Z",
  expiresAt: "2026-10-28T00:00:00.000Z",
  ...over,
});
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("storedCredentialToken (local auth mode)", () => {
  const now = () => Date.parse("2026-09-29T00:00:00.000Z");

  test("uses stored credentials for the same origin", async () => {
    const token = storedCredentialToken({ home: "/h", apiOrigin: "http://staging.example:4000/", now, read: async () => creds() });
    await settle();
    expect(token()).toBe("fpd_stored");
  });

  test("ignores another origin, expired credentials and a missing file", async () => {
    for (const read of [
      async () => creds({ apiOrigin: "https://api.fabplane.com" }),
      async () => creds({ expiresAt: "2026-09-01T00:00:00.000Z" }),
      async () => undefined,
      async () => {
        throw new Error("EACCES");
      },
    ]) {
      const token = storedCredentialToken({ home: "/h", apiOrigin: "http://staging.example:4000", now, read });
      await settle();
      expect(token()).toBeNull();
    }
  });

  test("re-reads after the refresh window so a later `fabdesk-core login` is picked up", async () => {
    let t = now();
    let stored: Credentials | undefined;
    const token = storedCredentialToken({ home: "/h", apiOrigin: "http://staging.example:4000", now: () => t, read: async () => stored });
    await settle();
    expect(token()).toBeNull();
    stored = creds();
    t += 16_000;
    token();
    await settle();
    expect(token()).toBe("fpd_stored");
  });
});
