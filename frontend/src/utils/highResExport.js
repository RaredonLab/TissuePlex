/**
 * High-resolution figure export.
 *
 * Renders the deck.gl data layers for one rectangular region into an offscreen
 * canvas at an arbitrary pixel size, composites it over a background, optionally
 * adds a scale bar in a margin band, and returns a PNG blob.
 *
 * ── The thing to understand before editing ────────────────────────────────────
 *
 * Every data layer in Viewer.jsx constrains its stroke width / dot radius in
 * SCREEN pixels, not world units:
 *
 *     tissue-graph      widthMinPixels 0.5   widthMaxPixels 5
 *     edges-directed    widthMinPixels 1     widthMaxPixels 8
 *     cell outline      widthMinPixels 1     widthMaxPixels 6
 *     transcripts       radiusMinPixels 1    radiusMaxPixels 8
 *     autocrine         radiusMinPixels 5    radiusMaxPixels 60
 *
 * At ordinary zoom it is those clamps — not the world-space widths — that decide
 * how thick a line actually looks. So rendering the same scene into a 4x larger
 * canvas without touching them yields a technically correct but visually WRONG
 * figure: the geometry grows 4x while every stroke stays 1-8 px, so the tissue
 * graph comes out as spidery hairlines nothing like what was approved on screen.
 *
 * `scaleClampProps` is meant to multiply every pixel clamp by the same factor the
 * geometry grows by, so the export is a faithful enlargement. World quantities
 * (edgeOffset, arrowhead length, polygons) scale on their own and are left alone.
 *
 * ── KNOWN BUG: the clamp scaling below is INERT ───────────────────────────────
 *
 * Measured on two exports of one region, mean stroke width (ink area / line
 * crossings) came out at a ratio of 0.86-0.97 between a 1250 px and a 1750 px
 * export. It would be 1.40 if the clamps were being scaled and 1.00 if strokes
 * were pinned in output pixels. They are pinned: strokes come out a fixed number
 * of output pixels wide regardless of export size, so the larger the export, the
 * thinner the lines look relative to the image.
 *
 * The cause was not identified. Prime suspect is `cloneLayer` below not applying
 * the overrides under deck.gl v9 — verify that `layer.clone(overrides)` actually
 * merges these props before assuming anything here works.
 *
 * Do NOT "fix" this with deck.gl's numeric `useDevicePixels`, tempting as it is:
 * that anchors line weight to export width, which is the wrong anchor whenever
 * the exported image is cropped before use (crops come out chunky). The right fix
 * is an explicit line-weight control in ExportDialog, decoupled from both the
 * screen view and the pixel count.
 *
 * The check to run after touching any of this: export one region at two pixel
 * widths and compare mean stroke width. The ratio says unambiguously which
 * regime you are in.
 */
import { Deck, OrthographicView } from "@deck.gl/core";
import { niceScaleBarUm, formatScaleLabel } from "./pngExport";

/** Hard ceiling — WebGL tops out at 16384 px/side on most GPUs. */
export const MAX_OUTPUT_DIM = 16384;
/** Above this a single frame costs hundreds of MB; worth warning about. */
export const WARN_OUTPUT_DIM = 8000;

const EXPORT_VIEW_ID = "export-ortho";

/**
 * Pixel-space clamps that must grow with the output.
 * `getWidth` / `getRadius` are NOT here: they are world units and scale already.
 */
const PIXEL_CLAMP_PROPS = [
  "widthMinPixels", "widthMaxPixels",
  "radiusMinPixels", "radiusMaxPixels",
  "lineWidthMinPixels", "lineWidthMaxPixels",
  "pointRadiusMinPixels", "pointRadiusMaxPixels",
];

function cloneLayer(layer, overrides) {
  if (typeof layer?.clone === "function") return layer.clone(overrides);
  // Defensive fallback if a future deck.gl drops Layer#clone.
  const Ctor = layer?.constructor;
  if (!Ctor) return null;
  return new Ctor({ ...layer.props, ...overrides });
}

/**
 * Clone a layer for export: same data and styling, pixel clamps scaled by `k`,
 * rotation re-pivoted around the export centre, picking switched off.
 *
 * NOTE: the `k` scaling is measurably not reaching the rendered layer — see the
 * KNOWN BUG block at the top of this file before trusting or editing this.
 * The rotation re-pivot and the picking overrides DO work; it is specifically
 * the pixel-clamp props that appear to be dropped.
 */
function scaleClampProps(layer, k, modelMatrix) {
  const overrides = {
    modelMatrix,
    pickable: false,
    autoHighlight: false,
  };
  const props = layer?.props ?? {};
  for (const name of PIXEL_CLAMP_PROPS) {
    const v = props[name];
    // deck.gl's default for the *MaxPixels props is Number.MAX_SAFE_INTEGER;
    // scaling that overflows to Infinity, so only touch real, finite settings.
    if (typeof v === "number" && isFinite(v) && Math.abs(v) < 1e6) {
      overrides[name] = v * k;
    }
  }
  return cloneLayer(layer, overrides);
}

/**
 * Render `layers` into `canvas`, capture the frame, then resolve. Always
 * finalizes the Deck.
 *
 * Capture waits for BOTH `onLoad` and at least one `onAfterRender`, in whichever
 * order they arrive, rather than trusting the first frame to be complete.
 * `onDrawn` is written to be idempotent (it repaints the background before
 * compositing) because it may run on several frames before both have landed —
 * drawing a semi-transparent canvas twice over the same pixels would otherwise
 * accumulate alpha and darken the figure.
 */
function renderOnce({ canvas, width, height, viewState, layers, onDrawn }) {
  return new Promise((resolve, reject) => {
    let deck = null;
    let settled = false;
    let drawn = false;
    let loaded = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Release the GL context: browsers cap concurrent WebGL contexts (~16),
      // so leaking one per export eventually kills the live viewer.
      try { deck?.finalize(); } catch { /* already gone */ }
      err ? reject(err) : resolve();
    };

    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for the export frame to render.")),
      30_000
    );

    try {
      deck = new Deck({
        canvas,
        width,
        height,
        views: new OrthographicView({ id: EXPORT_VIEW_ID, flipY: true }),
        viewState: { ...viewState, id: EXPORT_VIEW_ID },
        controller: false,
        layers,
        // 1 CSS px == 1 output px, so the scaled pixel clamps above mean exactly
        // what they say regardless of the user's display density.
        useDevicePixels: false,
        // Both spellings: v8 used glOptions, v9 uses deviceProps. An unknown
        // prop is a console warning; a lost drawing buffer is a blank export.
        glOptions: { preserveDrawingBuffer: true },
        deviceProps: { webgl: { preserveDrawingBuffer: true } },
        onAfterRender: () => {
          if (settled) return;
          try {
            // Copy inside onAfterRender, while the drawing buffer is guaranteed
            // to still hold this frame.
            onDrawn();
            drawn = true;
            if (loaded) finish(null);
          } catch (e) {
            finish(e);
          }
        },
        onLoad: () => {
          loaded = true;
          if (drawn) finish(null);
        },
        onError: (e) => finish(e),
      });
    } catch (e) {
      finish(e);
    }
  });
}

function drawScaleBar(ctx, opts) {
  const { outW, outH, marginH, pixelSize, widthWorld, fg } = opts;
  if (!(pixelSize > 0) || !(widthWorld > 0)) return null;

  const widthUm = widthWorld * pixelSize;
  const umPerOutPx = widthUm / outW;

  let barUm = niceScaleBarUm(widthUm * 0.2);
  let barPx = barUm / umPerOutPx;
  // Never let the bar dominate the figure if the snap rounded upward.
  let guard = 0;
  while (barPx > outW * 0.55 && guard++ < 8) {
    barUm = niceScaleBarUm(barUm * 0.45);
    barPx = barUm / umPerOutPx;
  }

  const pad = Math.max(12, Math.round(outW * 0.015));
  const barH = Math.max(3, Math.round(marginH * 0.11));
  const barY = outH + Math.round(marginH * 0.30);
  const fontPx = Math.max(11, Math.round(marginH * 0.30));

  ctx.fillStyle = fg;
  ctx.fillRect(pad, barY, Math.round(barPx), barH);

  ctx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(formatScaleLabel(barUm), pad, barY + barH + Math.round(marginH * 0.13));

  return { barUm, barPx };
}

/**
 * Produce a PNG blob of one region.
 *
 * @param layers        deck.gl layer instances to draw (already filtered by caller)
 * @param center        [x, y] pivot/centre in image pixel coords
 * @param widthWorld    region width in image pixels
 * @param heightWorld   region height in image pixels
 * @param screenScale   current on-screen world->CSS-pixel scale (2 ** deck zoom)
 * @param modelMatrix   rotation matrix re-pivoted around `center`
 * @param outWidth      output width in pixels
 * @param background    "black" | "white" | "transparent"
 * @param scaleBar      whether to append a margin band with a scale bar
 * @param pixelSize     microns per image pixel, for the scale bar
 */
export async function renderRegionToPng({
  layers,
  center,
  widthWorld,
  heightWorld,
  screenScale,
  modelMatrix,
  outWidth,
  background = "black",
  scaleBar = true,
  pixelSize = 0,
}) {
  if (!(widthWorld > 0) || !(heightWorld > 0)) {
    throw new Error("The export region has no area — draw a rectangle first.");
  }

  const outW = Math.max(1, Math.round(outWidth));
  const outH = Math.max(1, Math.round((outWidth * heightWorld) / widthWorld));
  if (outW > MAX_OUTPUT_DIM || outH > MAX_OUTPUT_DIM) {
    throw new Error(
      `Output would be ${outW}x${outH} px, past the ${MAX_OUTPUT_DIM} px limit ` +
      `most GPUs impose. Reduce the width or draw a wider, shorter rectangle.`
    );
  }

  // World units per output pixel vs per on-screen pixel. This ratio is exactly
  // how much bigger the geometry is about to be drawn, and therefore how much
  // every screen-space clamp has to grow to keep the picture faithful.
  const exportScale = outW / widthWorld;
  const clampScale = screenScale > 0 ? exportScale / screenScale : 1;

  const exportLayers = layers
    .map((l) => scaleClampProps(l, clampScale, modelMatrix))
    .filter(Boolean);

  const marginH = scaleBar ? Math.max(56, Math.round(outH * 0.07)) : 0;
  const totalH = outH + marginH;

  const composite = document.createElement("canvas");
  composite.width = outW;
  composite.height = totalH;
  const ctx = composite.getContext("2d");
  if (!ctx) throw new Error("Could not create a 2D canvas for compositing.");

  // Background is painted here rather than via deck's clearColor: it keeps the
  // result identical across deck.gl versions, and lets the margin band match.
  const paintBackground = (x, y, w, h) => {
    if (background === "transparent") {
      ctx.clearRect(x, y, w, h);
      return;
    }
    ctx.fillStyle = background === "white" ? "#ffffff" : "#000000";
    ctx.fillRect(x, y, w, h);
  };
  paintBackground(0, 0, outW, totalH);

  const glCanvas = document.createElement("canvas");
  glCanvas.width = outW;
  glCanvas.height = outH;
  // Parked off-screen rather than fully detached: some deck.gl/luma builds size
  // the drawing buffer from the canvas' layout box, which is 0x0 while the
  // element is out of the document.
  glCanvas.style.cssText =
    `position:fixed;left:-99999px;top:0;width:${outW}px;height:${outH}px;pointer-events:none;`;
  document.body.appendChild(glCanvas);

  try {
    await renderOnce({
      canvas: glCanvas,
      width: outW,
      height: outH,
      viewState: {
        target: [center[0], center[1], 0],
        zoom: Math.log2(exportScale),
        minZoom: -30,
        maxZoom: 30,
      },
      layers: exportLayers,
      // Idempotent: reset the plot area first, so running on more than one
      // frame cannot double-composite the layers' own transparency.
      onDrawn: () => {
        paintBackground(0, 0, outW, outH);
        ctx.drawImage(glCanvas, 0, 0);
      },
    });
  } finally {
    glCanvas.remove();
  }

  let bar = null;
  if (scaleBar) {
    const fg = background === "white" ? "#000000" : "#ffffff";
    bar = drawScaleBar(ctx, { outW, outH, marginH, pixelSize, widthWorld, fg });
  }

  const blob = await new Promise((resolve, reject) =>
    composite.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas could not be encoded as PNG."))),
      "image/png"
    )
  );

  return { blob, width: outW, height: totalH, plotHeight: outH, scaleBar: bar };
}
