/** Deep links from fabplane.com Explore into the desktop catalog / remix flow. */

export const FABPLANE_APP_PROTOCOL = "fabplane";

export type OpenCatalogIntent = {
  catalogId: string;
  remix: boolean;
};

const CATALOG_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}$/;

export function isCatalogDeepLinkId(value: string): boolean {
  return CATALOG_ID_RE.test(value);
}

export function openCatalogHref(catalogId: string, remix = false): string {
  const url = `${FABPLANE_APP_PROTOCOL}://open?catalog=${encodeURIComponent(catalogId)}`;
  return remix ? `${url}&remix=1` : url;
}

/**
 * Accepts `fabplane://open?catalog=owner/slug`, `fabplane://open/owner/slug`,
 * and the public web path `/open/owner/slug`.
 */
export function parseOpenCatalogHref(raw: string): OpenCatalogIntent | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    if (value.startsWith(`${FABPLANE_APP_PROTOCOL}:`)) {
      const url = new URL(value);
      const fromQuery = url.searchParams.get("catalog")?.trim() ?? "";
      const pathParts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
      const fromPath =
        pathParts[0] === "open" && pathParts[1] && pathParts[2]
          ? `${pathParts[1]}/${pathParts[2]}`
          : pathParts.length === 2
            ? `${pathParts[0]}/${pathParts[1]}`
            : "";
      const catalogId = (fromQuery || fromPath).toLowerCase();
      if (!CATALOG_ID_RE.test(catalogId)) return null;
      return { catalogId, remix: url.searchParams.get("remix") === "1" };
    }
    const url = new URL(value, "https://fabplane.com");
    const match = url.pathname.match(
      /^\/open\/([a-z0-9][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9-]{0,62})\/?$/i,
    );
    if (!match?.[1] || !match[2]) return null;
    return {
      catalogId: `${match[1].toLowerCase()}/${match[2].toLowerCase()}`,
      remix: url.searchParams.get("remix") === "1",
    };
  } catch {
    return null;
  }
}

export function findOpenCatalogArg(argv: readonly string[]): OpenCatalogIntent | null {
  for (const arg of argv) {
    const intent = parseOpenCatalogHref(arg);
    if (intent) return intent;
  }
  return null;
}
