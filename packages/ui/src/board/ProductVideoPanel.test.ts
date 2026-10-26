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
    expect(html).toContain("Make video");
    expect(html).toContain("Generate 3D model");
    for (const preset of VIDEO_PRESETS) expect(html).toContain(preset.label);
    expect(html).toContain("Title and spec captions");
    expect(html).toContain("exports/");
  });

  test("prefers MP4 over GIF for preview", () => {
    const files = [
      { path: "exports/product-video.gif", size: 10, mtime: "1" },
      { path: "exports/product-video.mp4", size: 20, mtime: "2" },
    ];
    expect(pickPreview(files)?.path).toBe("exports/product-video.mp4");
  });
});
