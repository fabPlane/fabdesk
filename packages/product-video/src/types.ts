import type { Aabb, Vec3 } from "./math";

export const VIDEO_PRESETS = ["orbit", "explode", "flip", "push_in", "review"] as const;
export type VideoPreset = (typeof VIDEO_PRESETS)[number];

export const VIDEO_ASPECTS = ["landscape", "square", "vertical"] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];

export const VIDEO_RESOLUTIONS = ["720p", "1080p"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export const VIDEO_BACKGROUNDS = ["light", "dark", "transparent"] as const;
export type VideoBackground = (typeof VIDEO_BACKGROUNDS)[number];

export const VIDEO_FORMATS = ["mp4", "webm", "gif"] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

export const PRESET_INFO: Record<VideoPreset, { label: string; blurb: string }> = {
  orbit: { label: "Orbit", blurb: "Turntable around the assembled product" },
  explode: { label: "Exploded → assembled", blurb: "Parts start separated and settle into place" },
  flip: { label: "Top / bottom", blurb: "Board flips from the top face to the bottom" },
  push_in: { label: "Push-in", blurb: "Slow dolly toward the board" },
  review: { label: "Review", blurb: "Title, orbit, flip, explode-to-assemble, then specs" },
};

export type ProductSpecs = {
  name: string;
  lines: string[];
};

export type CameraState = {
  eye: Vec3;
  target: Vec3;
  up: Vec3;
  fovY: number;
};

export type FramePose = {
  camera: CameraState;
  /** 0 = assembled, 1 = fully exploded. */
  explode: number;
  /** 0 = live 3D, 1 = solid title/specs card. */
  card: number;
  cardKind: "none" | "title" | "specs";
};

export type SceneTriangle = {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  na: Vec3;
  nb: Vec3;
  nc: Vec3;
  color: [number, number, number, number];
};

export type ScenePart = {
  /** Hash of the exact mesh bytes decoded, when loaded from a saved project file. */
  sourceSha256?: string;
  id: string;
  path: string;
  role: "board" | "mechanical";
  triangles: SceneTriangle[];
  bounds: Aabb;
  /** Rest-pose centroid; explode moves away from the scene centre. */
  centroid: Vec3;
};

export type ProductScene = {
  parts: ScenePart[];
  bounds: Aabb;
  sourceFiles: string[];
};

export type PixelBuffer = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type RenderOptions = {
  projectDir: string;
  outputDir: string;
  preset: VideoPreset;
  durationSec: number;
  fps: number;
  resolution: VideoResolution;
  aspect: VideoAspect;
  background: VideoBackground;
  captions: boolean;
  formats: VideoFormat[];
  specs: ProductSpecs;
  ffmpegPath?: string | null;
  /** Override the 720p/1080p size — used by CI smoke tests. */
  width?: number;
  height?: number;
  signal?: AbortSignal;
  progress?: (fraction: number, note?: string) => void;
};

export type RenderOutputs = {
  files: Partial<Record<VideoFormat, string>>;
  poster: string;
  manifest: string;
  width: number;
  height: number;
  frameCount: number;
  skipped: Array<{ format: VideoFormat; reason: string }>;
  parts: Array<{ id: string; role: ScenePart["role"]; path: string; triangles: number }>;
};

export function frameSize(resolution: VideoResolution, aspect: VideoAspect): { width: number; height: number } {
  const long = resolution === "1080p" ? 1920 : 1280;
  const short = resolution === "1080p" ? 1080 : 720;
  if (aspect === "square") return { width: short, height: short };
  if (aspect === "vertical") return { width: short, height: long };
  return { width: long, height: short };
}

export function backgroundRgba(kind: VideoBackground): [number, number, number, number] {
  if (kind === "transparent") return [0, 0, 0, 0];
  if (kind === "dark") return [18, 20, 26, 255];
  return [244, 241, 234, 255];
}
