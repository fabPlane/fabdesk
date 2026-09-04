import { describe, expect, test } from "bun:test";
import { CoreClient } from "./CoreClient";

describe("CoreClient open-source preview URL", () => {
  test("openSourcePreviewUrl is a loopback img src with the query token", () => {
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:47831", token: "tok", fetch: async () => new Response("x") });
    expect(client.openSourcePreviewUrl("tensorfleet/koyomi-lvds-hat")).toBe(
      "http://127.0.0.1:47831/opensource/preview/tensorfleet/koyomi-lvds-hat?token=tok",
    );
    expect(client.openSourcePreviewUrl("bad")).toBe("");
  });
});
