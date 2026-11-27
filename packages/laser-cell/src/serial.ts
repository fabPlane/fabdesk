/**
 * Serial links for the arm's bus-servo adapter (Waveshare / Seeed / CH340 / CH343 USB boards).
 *
 * fabdesk-core is a compiled Bun binary with no native add-ons, so:
 * - Windows opens `\\.\COMn` through kernel32 with `bun:ffi` (CreateFileW / SetCommState / ReadFile / WriteFile).
 * - Linux and macOS configure the tty with `stty` and use plain non-blocking file I/O.
 * Both are loaded lazily so tests and non-hardware code never touch `bun:ffi`.
 */
import { closeSync, openSync, readSync, writeSync, constants as fsConstants } from "node:fs";
import type { SerialLink } from "./st3215";

export type SerialPortInfo = { path: string; label: string };

export class SerialError extends Error {
  override name = "SerialError";
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/** List serial ports. Windows reads HKLM\HARDWARE\DEVICEMAP\SERIALCOMM; POSIX lists /dev. */
export async function listSerialPorts(platform: NodeJS.Platform = process.platform): Promise<SerialPortInfo[]> {
  if (platform === "win32") {
    const { code, out } = await run(["reg", "query", "HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM"]);
    if (code !== 0) return [];
    return parseWindowsSerialComm(out);
  }
  const { readdirSync } = await import("node:fs");
  const pattern = platform === "darwin" ? /^cu\.(usbserial|usbmodem|wchusbserial|SLAB)/ : /^tty(USB|ACM)\d+$/;
  return readdirSync("/dev")
    .filter(name => pattern.test(name))
    .sort()
    .map(name => ({ path: `/dev/${name}`, label: name }));
}

/** `reg query` output → ports, e.g. `\Device\wchusbser0    REG_SZ    COM5`. */
export function parseWindowsSerialComm(text: string): SerialPortInfo[] {
  const ports: SerialPortInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_SZ\s+(COM\d+)\s*$/i.exec(line);
    if (!match) continue;
    const device = match[1]!.replace(/^\\Device\\/i, "");
    const kind = /wch|ch34/i.test(device) ? "CH34x USB serial" : /silab|cp210/i.test(device) ? "CP210x USB serial" : /usbser|vcp/i.test(device) ? "USB serial" : device;
    ports.push({ path: match[2]!.toUpperCase(), label: `${match[2]!.toUpperCase()} · ${kind}` });
  }
  return ports.sort((a, b) => Number(a.path.slice(3)) - Number(b.path.slice(3)));
}

export async function openSerial(path: string, baud: number, platform: NodeJS.Platform = process.platform): Promise<SerialLink> {
  if (platform === "win32") return openWindowsSerial(path, baud);
  return openPosixSerial(path, baud, platform);
}

// ---------------------------------------------------------------- POSIX

async function openPosixSerial(path: string, baud: number, platform: NodeJS.Platform): Promise<SerialLink> {
  if (!/^\/dev\/[A-Za-z0-9._-]+$/.test(path)) throw new SerialError(`not a serial device path: ${path}`);
  const flag = platform === "darwin" ? "-f" : "-F";
  const stty = await run(["stty", flag, path, String(baud), "raw", "-echo", "-hupcl", "cs8", "-cstopb", "-parenb"]);
  if (stty.code !== 0) throw new SerialError(`could not configure ${path} at ${baud} baud: ${stty.err.trim() || `stty exited ${stty.code}`}`);
  const fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
  const scratch = new Uint8Array(512);
  const readNow = (): Uint8Array => {
    try {
      const n = readSync(fd, scratch, 0, scratch.length, null);
      return scratch.slice(0, n);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") return new Uint8Array(0);
      throw error;
    }
  };
  let closed = false;
  return {
    async write(bytes) {
      let offset = 0;
      while (offset < bytes.length) {
        try {
          offset += writeSync(fd, bytes, offset);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
          await sleep(1);
        }
      }
    },
    async read(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const chunk = readNow();
        if (chunk.length || Date.now() >= deadline) return chunk;
        await sleep(1);
      }
    },
    async flushInput() {
      while (readNow().length) { /* drain */ }
    },
    async close() {
      if (!closed) closeSync(fd);
      closed = true;
    },
  };
}

// ---------------------------------------------------------------- Windows

const GENERIC_READ_WRITE = 0xc0000000;
const OPEN_EXISTING = 3;
const PURGE_RX = 0x0002 | 0x0008; // RXABORT | RXCLEAR
const MAXDWORD = 0xffffffff;

/** Fill a 28-byte DCB for 8N1, binary, DTR/RTS asserted, no flow control. */
export function windowsDcb(baud: number): Uint8Array {
  const dcb = new Uint8Array(28);
  const view = new DataView(dcb.buffer);
  view.setUint32(0, 28, true); // DCBlength
  view.setUint32(4, baud, true); // BaudRate
  // fBinary (bit 0) | fDtrControl = DTR_CONTROL_ENABLE (bits 4-5 = 1) | fRtsControl = RTS_CONTROL_ENABLE (bits 12-13 = 1)
  view.setUint32(8, 0x1 | (1 << 4) | (1 << 12), true);
  view.setUint16(14, 2048, true); // XonLim
  view.setUint16(16, 512, true); // XoffLim
  dcb[18] = 8; // ByteSize
  dcb[19] = 0; // NOPARITY
  dcb[20] = 0; // ONESTOPBIT
  dcb[21] = 0x11; // XonChar
  dcb[22] = 0x13; // XoffChar
  return dcb;
}

/** COMMTIMEOUTS that return as soon as any byte is waiting, else after `timeoutMs`. */
export function windowsTimeouts(timeoutMs: number): Uint8Array {
  const buf = new Uint8Array(20);
  const view = new DataView(buf.buffer);
  view.setUint32(0, MAXDWORD, true); // ReadIntervalTimeout
  view.setUint32(4, MAXDWORD, true); // ReadTotalTimeoutMultiplier
  view.setUint32(8, Math.max(1, Math.min(MAXDWORD - 1, Math.round(timeoutMs))), true); // ReadTotalTimeoutConstant
  view.setUint32(12, 0, true);
  view.setUint32(16, 500, true); // WriteTotalTimeoutConstant
  return buf;
}

async function openWindowsSerial(path: string, baud: number): Promise<SerialLink> {
  if (!/^COM\d{1,3}$/i.test(path)) throw new SerialError(`not a COM port: ${path}`);
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const k32 = dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    SetCommState: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    SetCommTimeouts: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    SetupComm: { args: [FFIType.i64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    PurgeComm: { args: [FFIType.i64, FFIType.u32], returns: FFIType.i32 },
    ReadFile: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    WriteFile: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const f = k32.symbols;
  const name = Buffer.from(`\\\\.\\${path.toUpperCase()}\0`, "utf16le");
  const handle = BigInt(f.CreateFileW(ptr(name), GENERIC_READ_WRITE, 0, null, OPEN_EXISTING, 0, null) as number | bigint);
  if (handle === -1n || handle === 0n) {
    const code = f.GetLastError();
    k32.close();
    throw new SerialError(code === 5 ? `${path} is in use by another program (close Station, the Feetech tool or any serial monitor)` : code === 2 ? `${path} was not found` : `could not open ${path} (Windows error ${code})`);
  }
  const fail = (what: string): never => {
    const code = f.GetLastError();
    f.CloseHandle(handle);
    k32.close();
    throw new SerialError(`${what} failed on ${path} (Windows error ${code})`);
  };
  if (!f.SetupComm(handle, 4096, 4096)) fail("SetupComm");
  const dcb = windowsDcb(baud);
  if (!f.SetCommState(handle, ptr(dcb))) fail(`setting ${baud} baud`);
  let currentTimeout = -1;
  const setTimeout_ = (ms: number) => {
    const rounded = Math.max(1, Math.round(ms));
    if (rounded === currentTimeout) return;
    const timeouts = windowsTimeouts(rounded);
    if (!f.SetCommTimeouts(handle, ptr(timeouts))) fail("SetCommTimeouts");
    currentTimeout = rounded;
  };
  setTimeout_(20);
  const scratch = new Uint8Array(512);
  const count = new Uint32Array(1);
  let closed = false;
  return {
    async write(bytes) {
      const copy = new Uint8Array(bytes);
      count[0] = 0;
      if (!f.WriteFile(handle, ptr(copy), copy.length, ptr(count), null) || count[0] !== copy.length) fail("WriteFile");
    },
    async read(timeoutMs) {
      setTimeout_(timeoutMs);
      count[0] = 0;
      if (!f.ReadFile(handle, ptr(scratch), scratch.length, ptr(count), null)) fail("ReadFile");
      return scratch.slice(0, count[0]);
    },
    async flushInput() {
      f.PurgeComm(handle, PURGE_RX);
    },
    async close() {
      if (closed) return;
      closed = true;
      f.CloseHandle(handle);
      k32.close();
    },
  };
}
