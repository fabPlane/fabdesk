import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");

describe("shipped product names", () => {
  test("package.json productName is fabPlane; package name stays @fabdesk/desktop", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
      name: string;
      productName: string;
    };
    expect(pkg.productName).toBe("fabPlane");
    expect(pkg.name).toBe("@fabdesk/desktop");
  });

  test("electron-builder keeps appId and ships fabplane", () => {
    const yml = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");
    expect(yml).toMatch(/^appId: com\.tensorfleet\.fabdesk$/m);
    expect(yml).toMatch(/^productName: fabPlane$/m);
    expect(yml).toMatch(/^artifactName: fabplane-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}$/m);
    expect(yml.match(/executableName: fabplane/g)?.length).toBe(2);
    expect(yml).not.toMatch(/executableName: fabdesk/);
    expect(yml).not.toMatch(/productName: Fabplane/);
    expect(yml).not.toMatch(/productName: Fabdesk/);
  });
});
