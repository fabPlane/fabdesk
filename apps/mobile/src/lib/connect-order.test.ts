import { describe, expect, test } from "bun:test";
import { connectOrder } from "./connect-order";

describe("connectOrder", () => {
  test("tries the last address that worked first", () => {
    expect(
      connectOrder({ baseUrl: "http://192.168.1.24:47820", candidates: ["http://100.64.0.1:47820", "http://192.168.1.24:47820"] }),
    ).toEqual(["http://192.168.1.24:47820", "http://100.64.0.1:47820"]);
  });

  test("does not repeat the last-known-good address", () => {
    const order = connectOrder({ baseUrl: "http://a", candidates: ["http://a", "http://b"] });
    expect(order).toEqual(["http://a", "http://b"]);
    expect(new Set(order).size).toBe(order.length);
  });

  test("keeps an address that is no longer among the candidates", () => {
    // The daemon may have moved networks since pairing; the address that last worked is still the
    // best first guess.
    expect(connectOrder({ baseUrl: "http://old", candidates: ["http://new"] })).toEqual(["http://old", "http://new"]);
  });
});
