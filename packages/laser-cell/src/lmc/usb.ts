/**
 * USB transports for BJJCZ LMC boards: a Windows WinUSB transport (bun:ffi, no native add-on, so it works in
 * the compiled core) and an in-memory mock for tests and dry runs.
 *
 * The board is VID 0x9588 / PID 0x9899 with a bulk OUT endpoint 0x02 and a bulk IN endpoint 0x88
 * (galvoplotter, MIT). Windows only lets one driver own a USB device: LightBurn and galvoplotter use a
 * WinUSB/libusb driver, while ComMarker Studio installs Cypress's driver. fabPlane needs WinUSB, so the
 * board cannot be used by Studio and fabPlane at the same time.
 */
import { Cmd, COMMAND_BYTES, LIST_PACKET_BYTES, REPLY_BYTES, Status, command, decodeList, parseReply } from "./protocol";

export const LMC_VID = 0x9588;
export const LMC_PID = 0x9899;
export const LMC_OUT_ENDPOINT = 0x02;
export const LMC_IN_ENDPOINT = 0x88;

export class LmcUsbError extends Error {
  override name = "LmcUsbError";
}

export interface LmcTransport {
  /** Set by the Wi-Fi bridge client: the board is on another computer, reached over the network. */
  readonly remote?: boolean;
  /** True once the link is gone (e.g. a heartbeat timed out); the driver reconnects instead of using it. */
  readonly closed?: boolean;
  /** The bridge can run whole jobs itself (job mode): see ./bridge.ts. */
  readonly jobs?: boolean;
  /** Job-mode request to the bridge; resolves with the JSON answer (or null for a plain OK). */
  rpc?(type: "J" | "Q" | "S" | "U" | "V", body?: unknown, timeoutMs?: number): Promise<unknown>;
  /** 12-byte single command or 3072-byte list packet. */
  write(packet: Uint8Array): Promise<void>;
  /** 8-byte reply to the last single command. */
  read(): Promise<Uint8Array>;
  /** Optional: write a single command and return its reply in one step (one round trip over a network). */
  transact?(packet: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
}

export type UsbDeviceInfo = { vid: number; pid: number; path: string };

/** `\\?\usb#vid_9588&pid_9899#...` → ids. */
export function parseUsbPath(path: string): { vid: number; pid: number } | null {
  const m = /vid_([0-9a-f]{4})&pid_([0-9a-f]{4})/i.exec(path);
  return m ? { vid: Number.parseInt(m[1]!, 16), pid: Number.parseInt(m[2]!, 16) } : null;
}

// ---------------------------------------------------------------- Windows: SetupAPI + WinUSB

// GUID_DEVINTERFACE_USB_DEVICE {A5DCBF10-6530-11D2-901F-00C04FB951ED}
const USB_DEVICE_GUID = new Uint8Array([0x10, 0xbf, 0xdc, 0xa5, 0x30, 0x65, 0xd2, 0x11, 0x90, 0x1f, 0x00, 0xc0, 0x4f, 0xb9, 0x51, 0xed]);
const DIGCF_PRESENT = 0x2, DIGCF_DEVICEINTERFACE = 0x10;

let win32Libs: ReturnType<typeof loadWin32> | null = null;
/** The Windows libraries, loaded once per process (status polling reconnects often while the laser is off). */
function win32() {
  win32Libs ??= loadWin32();
  return win32Libs;
}

async function loadWin32() {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const setup = dlopen("setupapi.dll", {
    SetupDiGetClassDevsW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i64 },
    SetupDiEnumDeviceInterfaces: { args: [FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    SetupDiGetDeviceInterfaceDetailW: { args: [FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SetupDiDestroyDeviceInfoList: { args: [FFIType.i64], returns: FFIType.i32 },
  });
  const k32 = dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const wu = dlopen("winusb.dll", {
    WinUsb_Initialize: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    WinUsb_Free: { args: [FFIType.i64], returns: FFIType.i32 },
    WinUsb_SetPipePolicy: { args: [FFIType.i64, FFIType.u8, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    WinUsb_WritePipe: { args: [FFIType.i64, FFIType.u8, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    WinUsb_ReadPipe: { args: [FFIType.i64, FFIType.u8, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    WinUsb_FlushPipe: { args: [FFIType.i64, FFIType.u8], returns: FFIType.i32 },
  });
  return { setup: setup.symbols, k32: k32.symbols, wu: wu.symbols, ptr };
}

/** All present USB devices (vendor/product ids and device paths). Windows only. */
export async function listUsbDevices(): Promise<UsbDeviceInfo[]> {
  if (process.platform !== "win32") throw new LmcUsbError("USB device listing is implemented for Windows");
  const { setup, ptr } = await win32();
  const info = BigInt(setup.SetupDiGetClassDevsW(ptr(USB_DEVICE_GUID), null, null, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE) as number | bigint);
  if (info === -1n) throw new LmcUsbError("SetupDiGetClassDevs failed");
  const out: UsbDeviceInfo[] = [];
  try {
    for (let i = 0; i < 256; i++) {
      // SP_DEVICE_INTERFACE_DATA (x64): cbSize u32, GUID, Flags u32, Reserved u64 = 32 bytes
      const iface = new Uint8Array(32);
      new DataView(iface.buffer).setUint32(0, 32, true);
      if (!setup.SetupDiEnumDeviceInterfaces(info, null, ptr(USB_DEVICE_GUID), i, ptr(iface))) break;
      const need = new Uint32Array(1);
      setup.SetupDiGetDeviceInterfaceDetailW(info, ptr(iface), null, 0, ptr(need), null);
      if (!need[0]) continue;
      // SP_DEVICE_INTERFACE_DETAIL_DATA_W (x64): cbSize u32 = 8, then WCHAR DevicePath[]
      const detail = new Uint8Array(need[0]);
      new DataView(detail.buffer).setUint32(0, 8, true);
      if (!setup.SetupDiGetDeviceInterfaceDetailW(info, ptr(iface), ptr(detail), need[0], null, null)) continue;
      let path = Buffer.from(detail.buffer, 4, need[0] - 4).toString("utf16le");
      path = path.slice(0, Math.max(0, path.indexOf("\0")) || path.length);
      const ids = parseUsbPath(path);
      if (ids) out.push({ ...ids, path });
    }
  } finally {
    setup.SetupDiDestroyDeviceInfoList(info);
  }
  return out;
}

/** Opens the first (or `index`th) LMC board through WinUSB. */
export async function openWinUsbLmc(index = 0, timeoutMs = 500): Promise<LmcTransport> {
  if (process.platform !== "win32") throw new LmcUsbError("the fabPlane USB driver currently supports Windows");
  const boards = (await listUsbDevices()).filter(d => d.vid === LMC_VID && d.pid === LMC_PID);
  const board = boards[index];
  if (!board) throw new LmcUsbError("no BJJCZ laser board (USB 9588:9899) found; plug in the laser and switch it on");
  const { k32, wu, ptr } = await win32();
  const path = new Uint8Array(Buffer.from(`${board.path}\0`, "utf16le"));
  // GENERIC_READ|GENERIC_WRITE, share read/write, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OVERLAPPED
  const file = BigInt(k32.CreateFileW(ptr(path), 0xc0000000, 3, null, 3, 0x40000080, null) as number | bigint);
  if (file === -1n) {
    const err = k32.GetLastError();
    throw new LmcUsbError(err === 5 ? "the laser board is in use by another program (close ComMarker Studio or LightBurn)" : `could not open the laser board (Windows error ${err})`);
  }
  const handle = new BigUint64Array(1);
  if (!wu.WinUsb_Initialize(file, ptr(handle))) {
    const err = k32.GetLastError();
    k32.CloseHandle(file);
    throw new LmcUsbError(err === 1 || err === 50
      ? "the laser board uses another USB driver (ComMarker's). Install the WinUSB driver for it (Zadig or LightBurn's galvo driver) to use fabPlane's USB driver; Studio then cannot use it until the driver is switched back"
      : `WinUSB could not open the laser board (Windows error ${err})`);
  }
  const h = handle[0]!;
  const timeout = new Uint32Array([timeoutMs]);
  wu.WinUsb_SetPipePolicy(h, LMC_OUT_ENDPOINT, 3 /* PIPE_TRANSFER_TIMEOUT */, 4, ptr(timeout));
  wu.WinUsb_SetPipePolicy(h, LMC_IN_ENDPOINT, 3, 4, ptr(timeout));
  // Drop replies left over from an earlier connection, so the first answer read is to our first command.
  wu.WinUsb_FlushPipe(h, LMC_IN_ENDPOINT);
  let closed = false;
  const open = () => { if (closed) throw new LmcUsbError("the USB link to the laser is closed"); };
  return {
    async write(packet) {
      open();
      if (packet.length !== COMMAND_BYTES && packet.length !== LIST_PACKET_BYTES) throw new LmcUsbError(`bad packet size ${packet.length}`);
      const done = new Uint32Array(1);
      const copy = new Uint8Array(packet);
      if (!wu.WinUsb_WritePipe(h, LMC_OUT_ENDPOINT, ptr(copy), copy.length, ptr(done), null) || done[0] !== copy.length) {
        throw new LmcUsbError(`USB write failed (Windows error ${k32.GetLastError()})`);
      }
    },
    async read() {
      open();
      const buf = new Uint8Array(REPLY_BYTES);
      const done = new Uint32Array(1);
      if (!wu.WinUsb_ReadPipe(h, LMC_IN_ENDPOINT, ptr(buf), buf.length, ptr(done), null)) {
        throw new LmcUsbError(`USB read failed (Windows error ${k32.GetLastError()})`);
      }
      return buf.subarray(0, done[0]);
    },
    async close() {
      if (closed) return;
      closed = true;
      wu.WinUsb_Free(h);
      k32.CloseHandle(file);
    },
  };
}

// ---------------------------------------------------------------- mock

/**
 * Simulated board: records every packet, answers single commands with a status word, and stays busy for
 * `busyReads` status reads after ExecuteList. StopExecute ends a run at once.
 */
export class MockLmcTransport implements LmcTransport {
  readonly singles: Array<{ op: number; params: number[] }> = [];
  readonly lists: Uint8Array[] = [];
  private busyLeft = 0;
  private reply: Uint8Array | null = null;
  /** Optional hook awaited before each reply is handed out (tests: slow boards, races). */
  replyDelay: ((op: number) => Promise<void>) | null = null;
  private lastOp = 0;
  constructor(private readonly busyReads = 3, readonly version = [0x0001, 0x0002, 0x0003]) {}

  async write(packet: Uint8Array): Promise<void> {
    if (packet.length === LIST_PACKET_BYTES) { this.lists.push(new Uint8Array(packet)); return; }
    if (packet.length !== COMMAND_BYTES) throw new LmcUsbError(`bad packet size ${packet.length}`);
    const [cmd] = decodeList([packet]);
    this.singles.push(cmd!);
    this.lastOp = cmd!.op;
    if (cmd!.op === Cmd.ExecuteList) this.busyLeft = this.busyReads;
    if (cmd!.op === Cmd.StopExecute) this.busyLeft = 0;
    const status = Status.READY | (this.busyLeft > 0 ? Status.BUSY : 0);
    if (cmd!.op === Cmd.GetVersion && this.busyLeft > 0) this.busyLeft--;
    const words = cmd!.op === Cmd.GetVersion ? [...this.version, status] : [0, 0, 0, status];
    const out = new Uint8Array(REPLY_BYTES);
    const v = new DataView(out.buffer);
    words.forEach((w, i) => v.setUint16(i * 2, w, true));
    this.reply = out;
  }

  async read(): Promise<Uint8Array> {
    if (this.replyDelay) await this.replyDelay(this.lastOp);
    if (!this.reply) throw new LmcUsbError("no reply pending");
    const r = this.reply;
    this.reply = null;
    return r;
  }

  async close(): Promise<void> {}

  /** Commands of every list packet received so far, without padding. */
  listCommands() {
    const all = decodeList(this.lists);
    let end = all.length;
    while (end > 0 && all[end - 1]!.op === 0x8002) end--;
    return all.slice(0, end + 1);
  }
}

export { command, parseReply };

// ---------------------------------------------------------------- Linux (Raspberry Pi bridge): usbfs

/**
 * Linux transport through usbfs ioctls (libc via bun:ffi), for running the Wi-Fi bridge on a Raspberry Pi.
 * Needs permission on /dev/bus/usb (run as root or add a udev rule for 9588:9899).
 * NOT YET TESTED on Linux hardware.
 */
export async function openLinuxUsbLmc(index = 0, timeoutMs = 500): Promise<LmcTransport> {
  if (process.platform !== "linux") throw new LmcUsbError("the usbfs transport is for Linux");
  const { readdirSync, readFileSync, openSync, closeSync } = await import("node:fs");
  const read = (p: string) => { try { return readFileSync(p, "utf8").trim(); } catch { return ""; } };
  const boards: string[] = [];
  for (const d of readdirSync("/sys/bus/usb/devices")) {
    const base = `/sys/bus/usb/devices/${d}`;
    if (read(`${base}/idVendor`) === "9588" && read(`${base}/idProduct`) === "9899") {
      boards.push(`/dev/bus/usb/${read(`${base}/busnum`).padStart(3, "0")}/${read(`${base}/devnum`).padStart(3, "0")}`);
    }
  }
  const path = boards[index];
  if (!path) throw new LmcUsbError("no BJJCZ laser board (USB 9588:9899) found; plug in the laser and switch it on");
  let fd: number;
  try { fd = openSync(path, "r+"); } catch (e) {
    throw new LmcUsbError(`cannot open ${path} (${e instanceof Error ? e.message : String(e)}); run the bridge as root or add a udev rule for 9588:9899`);
  }
  const { ptr } = await import("bun:ffi");
  const libc = await linuxLibc();
  const USBDEVFS_CLAIMINTERFACE = 0x8004550fn, USBDEVFS_RELEASEINTERFACE = 0x80045510n, USBDEVFS_BULK = 0xc0185502n;
  const iface = new Uint32Array([0]);
  if (libc.ioctl(fd, USBDEVFS_CLAIMINTERFACE, ptr(iface)) < 0) { closeSync(fd); throw new LmcUsbError(`could not claim the laser board's USB interface at ${path} (in use?)`); }
  // struct usbdevfs_bulktransfer (64-bit): u32 ep, u32 len, u32 timeout, u32 pad, void* data = 24 bytes
  const bulk = (ep: number, data: Uint8Array, ms = timeoutMs) => {
    const req = new Uint8Array(24);
    const v = new DataView(req.buffer);
    v.setUint32(0, ep, true); v.setUint32(4, data.length, true); v.setUint32(8, ms, true);
    v.setBigUint64(16, BigInt(ptr(data)), true);
    return libc.ioctl(fd, USBDEVFS_BULK, ptr(req));
  };
  // Drain replies left over from an earlier connection (short reads until none are waiting).
  for (let i = 0; i < 16 && bulk(LMC_IN_ENDPOINT, new Uint8Array(REPLY_BYTES), 10) > 0; i++) { /* discard */ }
  let closed = false;
  const open = () => { if (closed) throw new LmcUsbError("the USB link to the laser is closed"); };
  return {
    async write(packet) {
      open();
      const copy = new Uint8Array(packet);
      if (bulk(LMC_OUT_ENDPOINT, copy) !== copy.length) throw new LmcUsbError("USB write to the laser board failed");
    },
    async read() {
      open();
      const buf = new Uint8Array(REPLY_BYTES);
      const n = bulk(LMC_IN_ENDPOINT, buf);
      if (n < 0) throw new LmcUsbError("USB read from the laser board failed");
      return buf.subarray(0, n);
    },
    async close() {
      if (closed) return; // never close a reused fd number twice
      closed = true;
      libc.ioctl(fd, USBDEVFS_RELEASEINTERFACE, ptr(iface));
      closeSync(fd);
    },
  };
}

let libcSymbols: Promise<{ ioctl: (fd: number, request: bigint, arg: unknown) => number }> | null = null;
function linuxLibc() {
  libcSymbols ??= import("bun:ffi").then(({ dlopen, FFIType }) =>
    dlopen("libc.so.6", { ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 } }).symbols as unknown as { ioctl: (fd: number, request: bigint, arg: unknown) => number });
  return libcSymbols;
}

/** The USB transport for this platform. */
export function openUsbLmc(index = 0): Promise<LmcTransport> {
  return process.platform === "linux" ? openLinuxUsbLmc(index) : openWinUsbLmc(index);
}
