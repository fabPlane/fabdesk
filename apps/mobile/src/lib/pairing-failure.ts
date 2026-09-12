/**
 * Turns a pairing error into something a person can act on.
 *
 * `claimFirstReachable` reports transport failures as "could not reach <name>" followed by one
 * line per address it tried. Nine times out of ten that means the phone is not on the same
 * network as the computer — off the tailnet, or on cellular — so say that, and keep the raw
 * addresses underneath for the one time it is something else. Daemon-side refusals ("no pairing
 * in progress", "pairing code is not valid") mean the code is stale or used: say that instead.
 */
export interface PairingFailure {
  title: string;
  message: string;
}

const UNREACHABLE = /^could not reach (.+)$/m;

export function describePairingFailure(error: unknown): PairingFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const unreachable = UNREACHABLE.exec(raw);
  if (unreachable) {
    const name = unreachable[1] ?? "your computer";
    const tried = raw
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      title: `Can't reach ${name}`,
      message: [
        `Make sure this phone is on the same Tailscale tailnet as ${name} — open Tailscale and check it is connected — or on the same Wi-Fi.`,
        "Then show a new pairing code on the desktop and scan again.",
        ...(tried.length ? ["", "Tried:", ...tried] : []),
      ].join("\n"),
    };
  }
  if (/no pairing in progress|not valid|expired/i.test(raw)) {
    return {
      title: "That pairing code is no longer valid",
      message:
        "Pairing codes work once and expire after a few minutes. Open Settings › Remote access on the desktop, press Pair a device for a fresh code, and scan it.",
    };
  }
  return { title: "Pairing failed", message: raw };
}
