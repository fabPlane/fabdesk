/** Claiming a pairing payload and turning it into a saved connection. */
import { claimFirstReachable } from "@fabdesk/client-core";
import type { DevicePlatform, PairingPayload } from "@fabdesk/protocol";
import { candidateBaseUrls } from "@fabdesk/protocol";
import { relayUrlFromPayload } from "./connect";
import { Platform } from "react-native";
import * as Device from "expo-constants";
import { useConnections, type Connection } from "./connections";
import { warmUpLocalNetwork } from "./local-network-warmup";

function devicePlatform(): DevicePlatform {
  return Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "other";
}

/** What the desktop lists this phone as. Best-effort: the OS name is enough to tell two apart. */
export function deviceLabel(): string {
  const name = Device.default.deviceName?.trim();
  if (name) return name;
  return Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android phone" : "Phone";
}

export async function claimAndSave(payload: PairingPayload): Promise<Connection> {
  // A deep link can arrive before the Connections screen has ever been shown; if the Local
  // Network prompt is still owed, take it now rather than on the claim (no-op once done).
  await warmUpLocalNetwork(candidateBaseUrls(payload));
  const { baseUrl, result } = await claimFirstReachable(payload, {
    label: deviceLabel(),
    platform: devicePlatform(),
  });
  // Daemons that mint a `coreId` (docs/mobile-notifications.md §4.4) return it in `core`; older
  // ones do not, and the protocol schema may strip it until it lists the field. Either way the
  // first `/health` on connect fills it in.
  const coreId = (result.core as { coreId?: unknown }).coreId;
  const connection: Connection = {
    // One connection per paired device: re-pairing the same machine makes a new one, which is
    // right — the old device token is still listed (and revocable) on the desktop.
    id: result.device.id,
    name: result.core.name || payload.name,
    baseUrl,
    candidates: candidateBaseUrls(payload),
    // A relay listed in the QR is kept apart from the direct addresses (`connect.ts`).
    ...(relayUrlFromPayload(payload) ? { relayUrl: relayUrlFromPayload(payload)! } : {}),
    deviceId: result.device.id,
    platform: result.device.platform,
    pairedAt: result.device.createdAt,
    lastConnectedAt: new Date().toISOString(),
    ...(typeof coreId === "string" && coreId ? { coreId } : {}),
  };
  await useConnections.getState().add(connection, result.deviceToken);
  return connection;
}
