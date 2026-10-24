export { extractSpecs, findMcu, type SpecsInput } from "./specs";
export {
  VIDEO_PRESETS,
  VIDEO_ASPECTS,
  VIDEO_RESOLUTIONS,
  VIDEO_BACKGROUNDS,
  VIDEO_FORMATS,
  PRESET_INFO,
  frameSize,
  backgroundRgba,
  type VideoPreset,
  type VideoAspect,
  type VideoResolution,
  type VideoBackground,
  type VideoFormat,
  type ProductSpecs,
  type ProductScene,
  type RenderOptions,
  type RenderOutputs,
  type FramePose,
  type PixelBuffer,
} from "./types";
export { samplePreset, orbitBasis, explodeOffset } from "./presets";
export { assembleScene, discoverMeshFiles, loadPart } from "./scene";
export { renderFrame, createBuffer, clearBuffer, paintedPixels } from "./raster";
export { encodePng } from "./png";
export { encodeGif } from "./gif";
export { encodeOutputs } from "./encode";
export { findFfmpeg } from "./ffmpeg";
export { renderProductVideo, renderSceneFrames } from "./render";
export { fixtureScene, buildBoxGlb, buildBoxStl } from "./fixture";
export { loadGlb } from "./glb";
export { loadStl, loadObj } from "./stl";
