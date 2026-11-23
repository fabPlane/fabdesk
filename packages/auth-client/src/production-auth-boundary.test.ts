import { describe, expect, test } from "bun:test";
import {
  PRODUCTION_API_HOST,
  PRODUCTION_API_ORIGIN,
  PRODUCTION_APP_HOST,
  PRODUCTION_DEVICE_PATH,
  PRODUCTION_DEVICE_URI,
  PRODUCTION_PUBLIC_HOST,
  isProductionFabplaneOrigin,
} from "./dev-accounts";

describe("production authentication boundary", () => {
  test("keeps public site, device UI, and API on separate hosts", () => {
    expect(PRODUCTION_PUBLIC_HOST).toBe("fabplane.com");
    expect(PRODUCTION_APP_HOST).toBe("app.fabplane.com");
    expect(PRODUCTION_API_HOST).toBe("api.fabplane.com");
    expect(PRODUCTION_DEVICE_PATH).toBe("/device");
    expect(PRODUCTION_DEVICE_URI).toBe("https://app.fabplane.com/device");
    expect(PRODUCTION_API_ORIGIN).toBe("https://api.fabplane.com");
    expect(isProductionFabplaneOrigin(PRODUCTION_API_ORIGIN)).toBe(true);
    expect(isProductionFabplaneOrigin("https://app.fabplane.com")).toBe(false);
    expect(isProductionFabplaneOrigin("https://fabplane.com")).toBe(false);
  });

  // Password-to-production request prevention is exercised in password-login.test.ts.
  // Website deployment configuration belongs to the independently maintained API/browser repo.
});
