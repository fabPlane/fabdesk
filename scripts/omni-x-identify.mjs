import { createSocket } from "node:dgram";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";

// Fixed, read-only device-list query from ComMarker Android 0.2.7.
// Return a fresh buffer so callers cannot change subsequent requests.
export function makeIdentificationRequest() {
  return Buffer.from("feff00148000f013000000000000000000000003", "hex");
}

export function parseIdentificationReply(buffer, expectedIp) {
  if (!(buffer instanceof Uint8Array) || !isIPv4(expectedIp)) return null;
  const n = buffer.length;
  // The app reads IPv4 fields through byte 33, followed by the packet trailer.
  if (n < 36 || n > 64) return null;
  if (buffer[0] !== 0xfe || buffer[1] !== 0xff || buffer[2] !== 0 || buffer[3] !== n) return null;
  if (buffer[6] !== 0xf0 || buffer[7] !== 0x13) return null;
  const checksum = (buffer[6] + buffer[7] + buffer[n - 4] + buffer[n - 3]) & 0xff;
  if (buffer[n - 1] !== checksum) return null;
  const address = buffer.subarray(10, 14).join(".");
  if (address !== expectedIp) return null;
  const hardwareAddress = buffer.subarray(22, 28);
  if (hardwareAddress.every(byte => byte === 0) || hardwareAddress.every(byte => byte === 0xff)) return null;
  const mac = Array.from(hardwareAddress, byte => byte.toString(16).padStart(2, "0")).join(":");
  return { address, mac };
}

function validatePeer(address, localAddress, allowLoopback) {
  for (const ip of [address, localAddress]) {
    if (!isIPv4(ip)) throw new Error("Both addresses must be numeric IPv4 addresses.");
    const octets = ip.split(".").map(Number);
    if (octets[0] === 0 || octets[0] >= 224 || octets[3] === 0 || octets[3] === 255) {
      throw new Error("Use an individual host address for each end of the connection.");
    }
    if (octets[0] === 127 && !allowLoopback) throw new Error("Use the Wi-Fi interface connected to the Omni X.");
  }
  const localTest = allowLoopback && address === "127.0.0.1" && localAddress === address;
  const sameSubnet = address.slice(0, address.lastIndexOf(".")) === localAddress.slice(0, localAddress.lastIndexOf("."));
  if ((!localTest && address === localAddress) || !sameSubnet) {
    throw new Error("Use distinct controller and local addresses on the same /24 network.");
  }
  if (!Object.values(networkInterfaces()).flat().some(entry => entry?.address === localAddress)) {
    throw new Error("The local address must be assigned to an interface on this computer.");
  }
}

export async function identifyController({ address, localAddress, timeoutMs = 2000 }) {
  validatePeer(address, localAddress, true);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new Error("Use a positive timeout in milliseconds within the system timer range.");
  }
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    }
    const timer = setTimeout(() => finish(new Error("No matching controller identification reply before timeout.")), timeoutMs);
    socket.on("error", error => finish(error));
    socket.on("message", (message, peer) => {
      if (peer.address !== address) return;
      const result = parseIdentificationReply(message, address);
      if (result) finish(null, result);
    });
    socket.bind(2378, localAddress, () => {
      if (settled) return;
      socket.send(makeIdentificationRequest(), 2000, address, error => {
        if (error) finish(error);
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const usage = "Usage: omni-x-identify.mjs <controller-ipv4> <local-interface-ipv4>";
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
    console.log(usage);
  } else {
    try {
      if (args.length !== 2) throw new Error(usage);
      const [address, localAddress] = args;
      validatePeer(address, localAddress, false);
      const result = await identifyController({ address, localAddress });
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
