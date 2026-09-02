/** Fabplane local/staging password accounts. Kept here so auth-client does not import vendor/fabplane. */

/** Public/static site. Not an API or device-approval host. */
export const PRODUCTION_PUBLIC_HOST = "fabplane.com";
/** React editor; hosts `/device` browser approval. Deployed separately from the API. */
export const PRODUCTION_APP_HOST = "app.fabplane.com";
export const PRODUCTION_DEVICE_PATH = "/device";
/** Device-code API. Password login stays disabled here. */
export const PRODUCTION_API_HOST = "api.fabplane.com";

export const PRODUCTION_API_ORIGIN = `https://${PRODUCTION_API_HOST}`;
export const PRODUCTION_DEVICE_URI = `https://${PRODUCTION_APP_HOST}${PRODUCTION_DEVICE_PATH}`;

/** Shared seed password. Publicly documented; never send it to production. */
export const DEV_PASSWORD = "fabplane-dev";

export const PRODUCTION_PASSWORD_LOGIN_BLOCKED =
  "Password login is not available on production. Sign in with the browser at app.fabplane.com/device, or point FABPLANE_API_ORIGIN at a staging or local API.";

export const DEV_PASSWORD_ACCOUNTS = [
  {
    email: "demo@fabplane.dev",
    handle: "demo",
    displayName: "Demo Engineer",
    password: DEV_PASSWORD,
  },
  {
    email: "maya@fabplane.dev",
    handle: "maya",
    displayName: "Maya Chen",
    password: DEV_PASSWORD,
  },
] as const;

export type DevPasswordAccount = (typeof DEV_PASSWORD_ACCOUNTS)[number];

export function passwordSubjectFor(email: string): string {
  return `password:${email.trim().toLowerCase()}`;
}

/** Accepts a full email or the short handle (`maya`, `demo`). */
export function resolveDevAccount(login: string): DevPasswordAccount | undefined {
  const key = login.trim().toLowerCase();
  if (!key) return undefined;
  return DEV_PASSWORD_ACCOUNTS.find((account) => account.email === key || account.handle === key);
}

export function isProductionFabplaneOrigin(origin: string): boolean {
  try {
    const href = origin.includes("://") ? origin : `https://${origin}`;
    return new URL(href).hostname === PRODUCTION_API_HOST;
  } catch {
    return false;
  }
}

/** True when the caller is using the publicly documented seed accounts. */
export function isSharedDevPasswordLogin(login: string, password: string): boolean {
  const account = resolveDevAccount(login);
  return Boolean(account && password === account.password);
}
