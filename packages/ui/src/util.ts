import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function isMac(platform?: string): boolean {
  if (platform) return platform === "darwin";
  const p = typeof navigator !== "undefined" ? navigator.platform : "";
  return /Mac|iPhone|iPad/.test(p);
}

export function modKey(platform?: string): string {
  return isMac(platform) ? "⌘" : "Ctrl";
}

export function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString();
}

export type DateGroup = "Today" | "Yesterday" | "Older";

export function dateGroup(iso: string, now = new Date()): DateGroup {
  const d = new Date(iso);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return "Today";
  if (d.getTime() >= start - 86_400_000) return "Yesterday";
  return "Older";
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function stringifyPretty(v: unknown, max = 20_000): string {
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v, null, 2) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}

export function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const table: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    pdf: "application/pdf",
    json: "application/json",
    md: "text/markdown",
    txt: "text/plain",
    tsx: "text/plain",
    ts: "text/plain",
    kicad_pcb: "text/plain",
    kicad_sch: "text/plain",
    glb: "model/gltf-binary",
  };
  return table[ext] ?? "application/octet-stream";
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}
