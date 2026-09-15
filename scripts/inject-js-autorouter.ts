import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

interface PcbBundleManifest {
  format: number;
  jsAutorouter?: string;
  jsAutorouterCommit?: string;
  [key: string]: unknown;
}

interface RouterPackage {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
}

export function injectJsAutorouter(options: {
  bundleDir: string;
  routerDir: string;
  commit: string;
}): void {
  const bundleDir = resolve(options.bundleDir);
  const routerDir = resolve(options.routerDir);
  const manifestPath = join(bundleDir, "bundle.json");
  const routerPackagePath = join(routerDir, "package.json");
  const routerEntry = join(routerDir, "src", "index.ts");
  if (!existsSync(manifestPath)) throw new Error(`PCB bundle manifest is missing: ${manifestPath}`);
  if (!existsSync(routerEntry))
    throw new Error(`js_autorouter entry point is missing: ${routerEntry}`);
  if (!/^[0-9a-f]{40}$/.test(options.commit))
    throw new Error(`js_autorouter commit must be a full Git SHA: ${options.commit}`);

  const pkg = JSON.parse(readFileSync(routerPackagePath, "utf8")) as RouterPackage;
  if (pkg.name !== "@tensorfleet/js-autorouter" || pkg.private !== true)
    throw new Error("refusing to inject an unexpected or public router package");
  if (Object.keys(pkg.dependencies ?? {}).length > 0)
    throw new Error(
      "js_autorouter has runtime dependencies; the internal bundle would be incomplete",
    );

  const destination = join(bundleDir, "private", "js_autorouter");
  rmSync(destination, { recursive: true, force: true });
  cpSync(join(routerDir, "src"), join(destination, "src"), { recursive: true });
  cpSync(routerPackagePath, join(destination, "package.json"));

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PcbBundleManifest;
  if (manifest.format !== 1) throw new Error(`unsupported PCB bundle format: ${manifest.format}`);
  manifest.jsAutorouter = relative(bundleDir, join(destination, "src", "index.ts")).replaceAll(
    "\\",
    "/",
  );
  manifest.jsAutorouterCommit = options.commit;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) {
  const [bundleDir, routerDir, commit] = process.argv.slice(2);
  if (!bundleDir || !routerDir || !commit)
    throw new Error(
      "usage: bun run scripts/inject-js-autorouter.ts <bundle-dir> <router-dir> <commit>",
    );
  injectJsAutorouter({ bundleDir, routerDir, commit });
  console.log(`Injected private js_autorouter ${commit} into ${resolve(bundleDir)}`);
}
