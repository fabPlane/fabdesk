/**
 * Skia backing for the Route Cinema painter.
 *
 * `CinemaPainter` (client-core) draws through a `Canvas2D`-shaped interface — the slice of
 * `CanvasRenderingContext2D` it needs — and composes two cached layers (statics, settled copper)
 * onto the visible context. `SkiaCanvas2D` maps that interface onto an `SkCanvas`: fills and
 * strokes become paints, `beginPath`/`moveTo`/`lineTo`/`arc` build an `SkPath`, `setLineDash` a
 * path effect. The two cached layers are offscreen `SkSurface`s whose snapshots the painter
 * `drawImage`s back; the visible "context" is a `PictureRecorder`, so a frame is one `SkPicture`
 * for the `<Canvas>` to draw.
 *
 * Coordinates are in points throughout: the offscreen surfaces are allocated at device pixels and
 * pre-scaled, and their snapshots are drawn back at point size, so the painter never sees the
 * pixel ratio.
 */
import {
  BlendMode,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  type SkCanvas,
  type SkImage,
  type SkPaint,
  type SkPath,
  type SkPicture,
  type SkSurface,
} from "@shopify/react-native-skia";
import {
  CinemaPainter,
  drawScene,
  type DrawOptions,
  type LineCap,
  type LineJoin,
  type OffscreenLike,
  type Transform,
} from "@fabdesk/client-core";

const CAPS: Record<LineCap, StrokeCap> = {
  butt: StrokeCap.Butt,
  round: StrokeCap.Round,
  square: StrokeCap.Square,
};
const JOINS: Record<LineJoin, StrokeJoin> = {
  miter: StrokeJoin.Miter,
  round: StrokeJoin.Round,
  bevel: StrokeJoin.Bevel,
};
const DEG = 180 / Math.PI;
const FULL_TURN = Math.PI * 2 - 1e-6;

export class SkiaCanvas2D implements OffscreenLike {
  fillStyle = "#000000";
  strokeStyle = "#000000";
  lineWidth = 1;
  lineCap: LineCap = "butt";
  lineJoin: LineJoin = "miter";
  globalAlpha = 1;

  #path: SkPath | null = null;
  #dash: number[] = [];
  readonly #paint: SkPaint = Skia.Paint();
  readonly #clear: SkPaint = Skia.Paint();

  /**
   * @param pixelRatio device pixels per point of the images handed to `drawImage` (snapshots of the
   *   offscreen layers), so they land at point size.
   * @param onDraw called after every drawing call; the layer wrapper uses it to invalidate its snapshot.
   */
  constructor(
    readonly canvas: SkCanvas,
    private readonly pixelRatio = 1,
    private readonly onDraw?: () => void,
  ) {
    this.#paint.setAntiAlias(true);
    this.#clear.setBlendMode(BlendMode.Clear);
  }

  #prepare(style: PaintStyle, color: string): SkPaint {
    const p = this.#paint;
    p.setStyle(style);
    p.setColor(Skia.Color(color));
    p.setAlphaf(this.globalAlpha);
    if (style === PaintStyle.Stroke) {
      p.setStrokeWidth(this.lineWidth);
      p.setStrokeCap(CAPS[this.lineCap]);
      p.setStrokeJoin(JOINS[this.lineJoin]);
      p.setPathEffect(this.#dash.length > 0 ? Skia.PathEffect.MakeDash(this.#dash, 0) : null);
    } else {
      p.setPathEffect(null);
    }
    return p;
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.canvas.drawRect(Skia.XYWHRect(x, y, w, h), this.#prepare(PaintStyle.Fill, this.fillStyle));
    this.onDraw?.();
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.canvas.drawRect(
      Skia.XYWHRect(x, y, w, h),
      this.#prepare(PaintStyle.Stroke, this.strokeStyle),
    );
    this.onDraw?.();
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.canvas.drawRect(Skia.XYWHRect(x, y, w, h), this.#clear);
    this.onDraw?.();
  }

  beginPath(): void {
    this.#path = Skia.Path.Make();
  }

  moveTo(x: number, y: number): void {
    (this.#path ??= Skia.Path.Make()).moveTo(x, y);
  }

  lineTo(x: number, y: number): void {
    (this.#path ??= Skia.Path.Make()).lineTo(x, y);
  }

  arc(x: number, y: number, r: number, a0: number, a1: number): void {
    const path = (this.#path ??= Skia.Path.Make());
    const sweep = a1 - a0;
    // The painter only ever asks for full circles (vias, airline dots), but honour a partial arc too.
    if (Math.abs(sweep) >= FULL_TURN) path.addCircle(x, y, r);
    else path.arcToOval(Skia.XYWHRect(x - r, y - r, r * 2, r * 2), a0 * DEG, sweep * DEG, false);
  }

  stroke(): void {
    if (!this.#path) return;
    this.canvas.drawPath(this.#path, this.#prepare(PaintStyle.Stroke, this.strokeStyle));
    this.onDraw?.();
  }

  fill(): void {
    if (!this.#path) return;
    this.canvas.drawPath(this.#path, this.#prepare(PaintStyle.Fill, this.fillStyle));
    this.onDraw?.();
  }

  setLineDash(segments: number[]): void {
    this.#dash = segments.filter((n) => n > 0);
  }

  drawImage(image: unknown, x: number, y: number): void {
    const img = image as SkImage;
    const w = img.width();
    const h = img.height();
    const paint = this.#prepare(PaintStyle.Fill, "#ffffff");
    this.canvas.drawImageRect(
      img,
      Skia.XYWHRect(0, 0, w, h),
      Skia.XYWHRect(x, y, w / this.pixelRatio, h / this.pixelRatio),
      paint,
    );
    this.onDraw?.();
  }
}

/** An offscreen surface plus a snapshot that is only retaken after something was drawn. */
class Layer {
  readonly ctx: SkiaCanvas2D;
  #image: SkImage | null = null;
  #dirty = true;

  constructor(
    private readonly surface: SkSurface,
    pixelRatio: number,
  ) {
    surface.getCanvas().scale(pixelRatio, pixelRatio);
    this.ctx = new SkiaCanvas2D(surface.getCanvas(), pixelRatio, () => {
      this.#dirty = true;
    });
  }

  image(): SkImage {
    if (this.#dirty || !this.#image) {
      this.surface.flush();
      // Reusing the previous image's storage keeps a scrub from allocating a screen-sized texture per frame.
      this.#image = this.#image
        ? this.surface.makeImageSnapshot(undefined, this.#image)
        : this.surface.makeImageSnapshot();
      this.#dirty = false;
    }
    return this.#image;
  }
}

export interface PaintedFrame {
  picture: SkPicture;
  transform: Transform | null;
  shapes: number;
  /** Milliseconds spent recording the frame. */
  drawMs: number;
}

/**
 * Owns the painter and its two offscreen layers for one canvas size. `paint()` records one frame
 * into a picture. When the platform cannot make offscreen surfaces, every frame is drawn in a
 * single pass with `drawScene` instead — the same picture, without the layer cache.
 */
export class SkiaCinema {
  readonly #painter: CinemaPainter | null;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly pixelRatio: number,
  ) {
    const px = (n: number) => Math.max(1, Math.ceil(n * pixelRatio));
    const statics = Skia.Surface.MakeOffscreen(px(width), px(height));
    const copper = Skia.Surface.MakeOffscreen(px(width), px(height));
    if (statics && copper) {
      const s = new Layer(statics, pixelRatio);
      const c = new Layer(copper, pixelRatio);
      this.#painter = new CinemaPainter({
        statics: s.ctx,
        copper: c.ctx,
        image: (which) => (which === "statics" ? s.image() : c.image()),
      });
    } else {
      this.#painter = null;
    }
  }

  get layered(): boolean {
    return this.#painter !== null;
  }

  fits(width: number, height: number, pixelRatio: number): boolean {
    return this.width === width && this.height === height && this.pixelRatio === pixelRatio;
  }

  paint(opts: Omit<DrawOptions, "width" | "height">): PaintedFrame {
    const t0 = Date.now();
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, this.width, this.height));
    const ctx = new SkiaCanvas2D(canvas, this.pixelRatio);
    const full: DrawOptions = { ...opts, width: this.width, height: this.height };
    let transform: Transform | null;
    let shapes: number;
    if (this.#painter) {
      const painted = this.#painter.paint(ctx, full);
      transform = painted.transform;
      shapes = painted.shapes;
    } else {
      transform = drawScene(ctx, full);
      const frame = opts.cursor >= 0 ? opts.run.frames[opts.cursor] : undefined;
      shapes = opts.run.statics.length + (frame?.shapes.length ?? 0);
    }
    return {
      picture: recorder.finishRecordingAsPicture(),
      transform,
      shapes,
      drawMs: Date.now() - t0,
    };
  }
}
