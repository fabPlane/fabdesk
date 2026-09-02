import { describe, expect, test } from "bun:test";
import { sentryUserFromAuth } from "./sentry-user";

describe("sentryUserFromAuth", () => {
  test("maps a signed-in fabplane principal to id + username only", () => {
    expect(
      sentryUserFromAuth({
        mode: "fabplane",
        status: "signed_in",
        principal: {
          subject: "usr_1",
          handle: "ada",
          displayName: "Ada",
          email: "ada@example.com",
        },
      }),
    ).toEqual({ id: "usr_1", username: "ada" });
    expect(
      sentryUserFromAuth({
        mode: "fabplane",
        status: "signed_in",
        principal: { subject: "usr_2" },
      }),
    ).toEqual({ id: "usr_2" });
  });

  test("uses local:dev in local mode", () => {
    expect(
      sentryUserFromAuth({
        mode: "local",
        status: "signed_in",
        principal: { subject: "local:dev", handle: "local" },
      }),
    ).toEqual({ id: "local:dev", username: "local" });
  });

  test("clears the user when signed out, pending or unknown", () => {
    expect(sentryUserFromAuth({ mode: "fabplane", status: "signed_out" })).toBeNull();
    expect(sentryUserFromAuth({ mode: "fabplane", status: "pending" })).toBeNull();
    expect(sentryUserFromAuth(null)).toBeNull();
  });
});
