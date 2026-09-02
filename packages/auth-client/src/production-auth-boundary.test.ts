import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRODUCTION_API_HOST,
  PRODUCTION_API_ORIGIN,
  PRODUCTION_APP_HOST,
  PRODUCTION_DEVICE_PATH,
  PRODUCTION_DEVICE_URI,
  PRODUCTION_PUBLIC_HOST,
  isProductionFabplaneOrigin,
} from "./dev-accounts";

const FABPLANE_ROOT = join(import.meta.dir, "../../../vendor/fabplane");

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

  test("editor production deploy never enables password / dev login", () => {
    const workflow = readFileSync(join(FABPLANE_ROOT, ".github/workflows/deploy-app.yml"), "utf8");
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toMatch(/VITE_DEV_LOGIN=false/);
    const productionBlock = workflow.split('deployment_target }}" = "production"')[1] ?? "";
    const stagingBlock = productionBlock.split("else")[1] ?? "";
    expect(productionBlock).toContain("VITE_DEV_LOGIN=false");
    expect(productionBlock.split("else")[0]).not.toContain("VITE_DEV_LOGIN=true");
    expect(productionBlock.split("else")[0]).not.toMatch(/AUTH_PASSWORD_LOGIN=true/);
    expect(stagingBlock).toContain("VITE_DEV_LOGIN=true");
    expect(workflow).not.toMatch(/vars\.AUTH_PASSWORD_LOGIN/);
    expect(workflow).not.toMatch(/VITE_DEV_LOGIN=\$\{\{\s*vars\./);
  });
});
