export { AuthClient, defaultSleep } from "./client";
export type { AuthClientOptions } from "./client";
export { fabdeskHome, localModeAllowed, LOCAL_PRINCIPAL } from "./home";
export {
  Credentials,
  CREDENTIALS_FILE,
  credentialsPath,
  readCredentials,
  writeCredentials,
  deleteCredentials,
} from "./credential-store";
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
