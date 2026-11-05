import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProductVideoPanel,
  VIDEO_PRESETS,
  pickPreview,
  type ProductVideoForm,
} from "./ProductVideoPanel";

const form: ProductVideoForm = {
  preset: "review",
  resolution: "720p",
  aspect: "landscape",
  background: "light",
  durationSec: 6,
  captions: true,
};

describe("product video panel", () => {
  test("exposes every camera preset and the Make video action", () => {
    const html = renderToStaticMarkup(
      createElement(ProductVideoPanel, {
        projectId: "p1",
        glb: undefined,
        videos: [],
        poster: undefined,
        form,
        onForm: () => {},
        exporting: false,
        making: false,
        onExportGlb: () => {},
        onMakeVideo: () => {},
      }),
    );
    expect(html).toContain('data-testid="product-video-panel"');
    expect(html).toContain('data-testid="make-video"');
    expect(html).toContain('class="fd-video-setup" open=""');
    expect(html).toContain("Make video");
    expect(html).toContain("Generate 3D model");
    for (const preset of VIDEO_PRESETS) expect(html).toContain(preset.label);
    expect(html).toContain("Title and spec captions");
    expect(html).toContain("project’s outputs");
  });

  test("prefers MP4 over GIF for preview", () => {
    const files = [
      { path: "exports/product-video.gif", size: 10, mtime: "1" },
      { path: "exports/product-video.mp4", size: 20, mtime: "2" },
    ];
    expect(pickPreview(files)?.path).toBe("exports/product-video.mp4");
  });

  test("never chooses an encoder's empty placeholder over a usable format", () => {
    expect(pickPreview([
      { path: "exports/product-video.mp4", size: 0, mtime: "2" },
      { path: "exports/product-video.gif", size: 10, mtime: "1" },
    ])?.path).toBe("exports/product-video.gif");
    expect(pickPreview([{ path: "exports/product-video.webm", size: 0, mtime: "2" }])).toBeUndefined();
  });

  test("active encoding with files present shows progress rather than playback or format downloads", () => {
    const html = renderToStaticMarkup(createElement(ProductVideoPanel, {
      projectId: "p1", glb: undefined, poster: undefined,
      videos: [{ path: "exports/product-video.mp4", size: 100, mtime: "1" }, { path: "exports/product-video.webm", size: 0, mtime: "2" }],
      form, onForm: () => {}, exporting: false, making: true, makeNote: "frame 107/144",
      onExportGlb: () => {}, onMakeVideo: () => {},
    }));
    expect(html).toContain("frame 107/144");
    expect(html).toContain("Playback and downloads return when the export finishes");
    expect(html).not.toContain("Download MP4");
    expect(html).not.toContain("Download WEBM");
    expect(html).not.toContain("<video");
  });
});
