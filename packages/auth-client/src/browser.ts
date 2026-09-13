/**
 * Node-free surface for React Native / the browser. Do not re-export `client`, `home`, or
 * `credential-store` from here — those import `node:os` / `node:fs`.
 */
export {
  AuthHttpError,
  CLIENT_ID,
  DEVICE_GRANT,
  DeviceCodeResponse,
  TokenResponse,
  MeUser,
  startDeviceAuth,
  pollDeviceToken,
  fetchMe,
  revokeSession,
  normalizeOrigin,
} from "./device-flow";
export type { PollOutcome, MeResult } from "./device-flow";
export {
  DEV_PASSWORD,
  DEV_PASSWORD_ACCOUNTS,
  PRODUCTION_API_HOST,
  PRODUCTION_API_ORIGIN,
  PRODUCTION_APP_HOST,
  PRODUCTION_DEVICE_PATH,
  PRODUCTION_DEVICE_URI,
  PRODUCTION_PASSWORD_LOGIN_BLOCKED,
  PRODUCTION_PUBLIC_HOST,
  isProductionFabplaneOrigin,
  isSharedDevPasswordLogin,
  passwordSubjectFor,
  resolveDevAccount,
} from "./dev-accounts";
export type { DevPasswordAccount } from "./dev-accounts";
export {
  AUTH_SESSION_COOKIE,
  InvalidCredentialsError,
  approveDeviceCode,
  authErrorFromLocation,
  cookiesFromResponse,
  loginWithPasswordSession,
} from "./password-login";
export type { PasswordCredentials } from "./password-login";
export {
  fetchCloudSettings,
  putCloudSettings,
  mergeCloudSettings,
} from "./cloud-settings";
export type { CloudSettingsGet, CloudSettingsPut } from "./cloud-settings";
