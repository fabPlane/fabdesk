import { describe, expect, test } from "bun:test";
import { principalInitials, principalLabel } from "./principal";

describe("principalLabel", () => {
  test("prefers displayName, then handle, then email, then subject", () => {
    expect(
      principalLabel(
        { subject: "u1", displayName: "Matthew Campbell", handle: "hyper" },
        "fabplane",
      ),
    ).toBe("Matthew Campbell");
    expect(principalLabel({ subject: "u1", handle: "hyper" }, "fabplane")).toBe("hyper");
    expect(principalLabel({ subject: "u1", email: "a@b.c" }, "fabplane")).toBe("a@b.c");
    expect(principalLabel({ subject: "u1", displayName: "  " }, "fabplane")).toBe("u1");
  });
  test("names local mode when there is no principal", () => {
    expect(principalLabel(undefined, "local")).toBe("Local user");
    expect(principalLabel(undefined, "fabplane")).toBe("Signed in");
  });
});

describe("principalInitials", () => {
  test("uses first and last word", () => {
    expect(principalInitials("Matthew Campbell")).toBe("MC");
    expect(principalInitials("Ada King Lovelace")).toBe("AL");
  });
  test("single word and email forms", () => {
    expect(principalInitials("hyper")).toBe("H");
    expect(principalInitials("jane.doe@example.com")).toBe("JD");
    expect(principalInitials("")).toBe("?");
  });
});
