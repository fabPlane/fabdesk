/**
 * USB through libusb-1.0 (bun:ffi): the macOS transport, and the preferred one on Linux.
 *
 * macOS needs no driver: the BJJCZ board is a vendor-specific device that macOS leaves unclaimed, so libusb
 * can claim it directly (as galvoplotter / balor do with pyusb). Install libusb once: `brew install libusb`.
 * Linux: install libusb-1.0 (usually present) and allow access to 9588:9899 (udev rule) or run as root.
 *
 * The board logic is written against {@link LibusbApi}, so it is tested with a fake libusb on any machine.
 */
import { LMC_IN_ENDPOINT, LMC_OUT_ENDPOINT, LMC_PID, LMC_VID, LmcUsbError, type LmcTransport, type UsbDeviceInfo } from "./usb";
import { REPLY_BYTES } from "./protocol";

/** One device as libusb lists it; `ref` is libusb's device pointer, valid until `release()`. */
export type LibusbDevice = { vid: number; pid: number; bus: number; address: number; ref: unknown };

/** The few libusb calls fabPlane needs, as plain functions (the real one wraps bun:ffi). */
export type LibusbApi = {
  /** Lists devices; call `release()` when done with the refs. */
  list(): { devices: LibusbDevice[]; release(): void };
  open(device: LibusbDevice): unknown;
  /** Detach a kernel driver if one is attached (Linux), claim the interface. */
  claim(handle: unknown, iface: number): void;
  /** Bytes moved; throws {@link LmcUsbError} on a libusb error (a timeout is "LIBUSB_ERROR_TIMEOUT"). */
  bulk(handle: unknown, endpoint: number, data: Uint8Array, timeoutMs: number): number;
  release(handle: unknown, iface: number): void;
  close(handle: unknown): void;
};

const LIB_PATHS: Record<string, string[]> = {
  darwin: ["/opt/homebrew/lib/libusb-1.0.dylib", "/usr/local/lib/libusb-1.0.dylib", "/opt/local/lib/libusb-1.0.dylib", "libusb-1.0.dylib"],
  linux: ["libusb-1.0.so.0", "/usr/lib/x86_64-linux-gnu/libusb-1.0.so.0", "/usr/lib/aarch64-linux-gnu/libusb-1.0.so.0", "/usr/lib/arm-linux-gnueabihf/libusb-1.0.so.0"],
  win32: ["libusb-1.0.dll"],
};

export const LIBUSB_MISSING = process.platform === "darwin"
  ? "libusb is not installed on this Mac: install Homebrew (brew.sh), run `brew install libusb` in Terminal, then Find laser again"
  : "libusb is not installed: install libusb-1.0 (e.g. `sudo apt install libusb-1.0-0`), then Find laser again";

let api: Promise<LibusbApi> | null = null;

/** The real libusb, loaded once (FABPLANE_LIBUSB may point at the library file). */
export function libusb(): Promise<LibusbApi> {
  api ??= loadLibusb().catch(error => { api = null; throw error; });
  return api;
}

async function loadLibusb(): Promise<LibusbApi> {
  const { dlopen, FFIType, ptr, read } = await import("bun:ffi");
  const symbols = {
    libusb_init: { args: [FFIType.ptr], returns: FFIType.i32 },
    libusb_get_device_list: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
    libusb_free_device_list: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
    libusb_get_device_descriptor: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    libusb_get_bus_number: { args: [FFIType.ptr], returns: FFIType.u8 },
    libusb_get_device_address: { args: [FFIType.ptr], returns: FFIType.u8 },
    libusb_open: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    libusb_close: { args: [FFIType.ptr], returns: FFIType.void },
    libusb_set_auto_detach_kernel_driver: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    libusb_claim_interface: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    libusb_release_interface: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    libusb_bulk_transfer: { args: [FFIType.ptr, FFIType.u8, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    libusb_error_name: { args: [FFIType.i32], returns: FFIType.cstring },
  } as const;
  const candidates = [process.env.FABPLANE_LIBUSB, ...(LIB_PATHS[process.platform] ?? [])].filter((p): p is string => !!p);
  let lib: ReturnType<typeof dlopen<typeof symbols>> | null = null;
  for (const path of candidates) {
    try { lib = dlopen(path, symbols); break; } catch { /* next */ }
  }
  if (!lib) throw new LmcUsbError(LIBUSB_MISSING);
  const s = lib.symbols;
  const check = (rc: number, what: string) => { if (rc < 0) throw new LmcUsbError(`${what}: ${String(s.libusb_error_name(rc))}`); };
  check(s.libusb_init(null), "libusb_init");
  return {
    list() {
      const out = new BigUint64Array(1);
      const count = Number(s.libusb_get_device_list(null, ptr(out)));
      check(count, "libusb_get_device_list");
      const listPtr = Number(out[0]);
      const devices: LibusbDevice[] = [];
      const desc = new Uint8Array(18); // struct libusb_device_descriptor
      for (let i = 0; i < count; i++) {
        const dev = read.ptr(listPtr as never, i * 8);
        if (!dev) continue;
        if (s.libusb_get_device_descriptor(dev as never, ptr(desc)) < 0) continue;
        const v = new DataView(desc.buffer);
        devices.push({ vid: v.getUint16(8, true), pid: v.getUint16(10, true), bus: s.libusb_get_bus_number(dev as never), address: s.libusb_get_device_address(dev as never), ref: dev });
      }
      return { devices, release: () => s.libusb_free_device_list(listPtr as never, 1) };
    },
    open(device) {
      const out = new BigUint64Array(1);
      check(s.libusb_open(device.ref as never, ptr(out)), "could not open the laser board");
      return Number(out[0]);
    },
    claim(handle, iface) {
      s.libusb_set_auto_detach_kernel_driver(handle as never, 1); // Linux only; harmless elsewhere
      check(s.libusb_claim_interface(handle as never, iface), "could not claim the laser board (is another program using it?)");
    },
    bulk(handle, endpoint, data, timeoutMs) {
      const moved = new Int32Array(1);
      check(s.libusb_bulk_transfer(handle as never, endpoint, ptr(data), data.length, ptr(moved), timeoutMs), endpoint & 0x80 ? "USB read" : "USB write");
      return moved[0]!;
    },
    release(handle, iface) { s.libusb_release_interface(handle as never, iface); },
    close(handle) { s.libusb_close(handle as never); },
  };
}

/** USB devices as libusb sees them; on macOS there is no driver to bind, so a found board is ready. */
export async function listLibusbDevices(lib?: LibusbApi): Promise<UsbDeviceInfo[]> {
  const l = lib ?? (await libusb());
  const { devices, release } = l.list();
  try {
    return devices.map(d => ({ vid: d.vid, pid: d.pid, path: `libusb:${d.bus}-${d.address}`, driver: "libusb", name: d.vid === LMC_VID && d.pid === LMC_PID ? "BJJCZ laser board" : null }));
  } finally {
    release();
  }
}

/** Opens the first (or `index`th) BJJCZ board through libusb. */
export async function openLibusbLmc(index = 0, timeoutMs = 500, lib?: LibusbApi): Promise<LmcTransport> {
  const l = lib ?? (await libusb());
  const { devices, release } = l.list();
  let handle: unknown;
  try {
    const board = devices.filter(d => d.vid === LMC_VID && d.pid === LMC_PID)[index];
    if (!board) throw new LmcUsbError("no BJJCZ laser board (USB 9588:9899) found; plug in the laser's USB cable and switch it on");
    handle = l.open(board);
  } finally {
    release();
  }
  try {
    l.claim(handle, 0);
  } catch (error) {
    l.close(handle);
    throw error;
  }
  // Drop replies left over from an earlier connection, so the first answer read is to our first command.
  for (let i = 0; i < 16; i++) {
    try { if (l.bulk(handle, LMC_IN_ENDPOINT, new Uint8Array(REPLY_BYTES), 10) <= 0) break; } catch { break; }
  }
  let closed = false;
  const live = () => { if (closed) throw new LmcUsbError("the USB connection to the laser is closed"); };
  return {
    async write(packet) {
      live();
      const n = l.bulk(handle, LMC_OUT_ENDPOINT, packet, timeoutMs);
      if (n !== packet.length) throw new LmcUsbError(`USB write sent ${n} of ${packet.length} bytes`);
    },
    async read() {
      live();
      const reply = new Uint8Array(REPLY_BYTES);
      const n = l.bulk(handle, LMC_IN_ENDPOINT, reply, timeoutMs);
      if (n !== REPLY_BYTES) throw new LmcUsbError(`USB read got ${n} of ${REPLY_BYTES} bytes`);
      return reply;
    },
    async close() {
      if (closed) return;
      closed = true;
      try { l.release(handle, 0); } finally { l.close(handle); }
    },
  };
}
