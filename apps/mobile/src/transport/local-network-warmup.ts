/**
 * Triggers iOS's Local Network permission prompt on purpose, from a screen where a failed
 * request costs nothing. Which addresses to touch is decided in `lib/local-network` (tested);
 * this is the thin native edge: the phone's own IP from expo-network and a throwaway probe.
 */
import { REMOTE_DEFAULT_PORT } from "@fabdesk/protocol";
import * as Network from "expo-network";
import { Platform } from "react-native";
import { warmupTargets } from "../lib/local-network";
import { probe } from "./connect";

let warmed = false;

/** No-op off iOS and after the first call: one prompt per install is all it can ever produce. */
export async function warmUpLocalNetwork(candidates: string[]): Promise<void> {
  if (Platform.OS !== "ios" || warmed) return;
  warmed = true;
  const deviceIp = await Network.getIpAddressAsync().catch(() => null);
  const targets = warmupTargets({ candidates, deviceIp, port: REMOTE_DEFAULT_PORT });
  // The answers do not matter, only that a connection to a local address was attempted.
  await Promise.all(targets.map((t) => probe(t, { timeoutMs: 1500 })));
}
