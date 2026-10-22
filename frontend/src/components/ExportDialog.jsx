/**
 * Figure export dialog.
 *
 * Chooses the output size, DPI tag, background and scale bar for a high-
 * resolution PNG of the framed region.
 *
 * On "DPI": a PNG has pixels, not inches, so DPI alone cannot describe an
 * output. What actually determines resolution is the pixel width; the DPI here
 * fixes the intended print size and is written into the file's pHYs chunk so a
 * journal's automated resolution check reads the number the figure was designed
 * for. Both are shown together, with the resulting print width spelled out, so
 * the relationship stays visible instead of being something to remember.
 */
import React, { useMemo, useState } from "react";
import { MAX_OUTPUT_DIM, WARN_OUTPUT_DIM } from "../utils/highResExport";
import { niceScaleBarUm, formatScaleLabel } from "../utils/pngExport";

const PANEL = {
  background: "#141414",
  border: "1px solid #333",
  borderRadius: 8,
  padding: 14,
  width: 320,
  fontFamily: "monospace",
  fontSize: 11,
  color: "#bbb",
  boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
};

const FIELD = {
  background: "#1b1b1b",
  border: "1px solid #444",
  borderRadius: 3,
  color: "#ddd",
  fontFamily: "monospace",
  fontSize: 11,
  padding: "3px 5px",
  width: 78,
};

const BTN = {
  background: "transparent",
  border: "1px solid #444",
  borderRadius: 4,
  color: "#aaa",
  fontFamily: "monospace",
  fontSize: 11,
  padding: "4px 10px",
  cursor: "pointer",
};

const ROW = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 };
const LABEL = { color: "#777" };
const NOTE = { color: "#666", fontSize: 10, lineHeight: 1.45, marginTop: 2 };

/** Common figure widths, as pixels at a given print size and DPI. */
const SIZE_PRESETS = [
  { label: "3.5in @500", px: 1750, dpi: 500 }, // single column
  { label: "7in @500",   px: 3500, dpi: 500 }, // double column
  { label: "7in @600",   px: 4200, dpi: 600 },
];

export default function ExportDialog({
  onClose, onExport, geometry, hasRect, pixelSize, unitLabel,
  panelRotation, onClearRect,
}) {
  const [widthText, setWidthText] = useState("3500");
  const [dpiText, setDpiText] = useState("500");
  const [background, setBackground] = useState("black");
  const [scaleBar, setScaleBar] = useState(true);
  const [includeAnnotations, setIncludeAnnotations] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const outWidth = Math.round(Number(widthText));
  const dpi = Math.round(Number(dpiText));
  const widthValid = Number.isFinite(outWidth) && outWidth >= 16;
  const dpiValid = Number.isFinite(dpi) && dpi > 0;

  const info = useMemo(() => {
    if (!geometry || !(geometry.widthWorld > 0)) return null;
    const aspect = geometry.heightWorld / geometry.widthWorld;
    const outHeight = widthValid ? Math.round(outWidth * aspect) : 0;
    const regionUm = pixelSize > 0 ? geometry.widthWorld * pixelSize : 0;
    const barUm = regionUm > 0 ? niceScaleBarUm(regionUm * 0.2) : 0;
    return {
      aspect,
      outHeight,
      regionUm,
      regionHeightUm: pixelSize > 0 ? geometry.heightWorld * pixelSize : 0,
      sourcePx: geometry.widthWorld,
      barUm,
      // >1 means the output has more pixels than the region has source image
      // pixels. For the vector layers exported here that is simply sharper;
      // it would be the ceiling if the morphology raster were included.
      magnification: widthValid ? outWidth / geometry.widthWorld : 0,
    };
  }, [geometry, outWidth, widthValid, pixelSize]);

  const tooBig = info && (outWidth > MAX_OUTPUT_DIM || info.outHeight > MAX_OUTPUT_DIM);
  const big = info && !tooBig && (outWidth > WARN_OUTPUT_DIM || info.outHeight > WARN_OUTPUT_DIM);
  const rotationMismatch = hasRect && geometry && (geometry.rotation ?? 0) !== (panelRotation ?? 0);
  const canExport = !!geometry && widthValid && dpiValid && !tooBig && !busy;

  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await onExport({
        outWidth, dpi, background, scaleBar, includeAnnotations,
      });
      setDone(res);
    } catch (e) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const unit = unitLabel || "cell";

  return (
    <div
      style={{
        position: "absolute", inset: 0, zIndex: 40,
        background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        pointerEvents: "all",
      }}
      onClick={onClose}
    >
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ color: "#ddd", fontSize: 12 }}>Export figure</span>
          <button onClick={onClose} style={{ ...BTN, border: "none", padding: "2px 4px", color: "#666" }}>✕</button>
        </div>

        {/* ── What is being exported ─────────────────────────────────── */}
        <div style={{ ...NOTE, marginBottom: 10 }}>
          {hasRect
            ? "Region: the ▭ Rectangle framing."
            : "Region: the whole current view — draw a ▭ Rectangle to frame a smaller area."}
          {info && info.regionUm > 0 && (
            <> {" "}{info.regionUm.toFixed(1)} × {info.regionHeightUm.toFixed(1)} µm.</>
          )}
        </div>

        {!geometry && (
          <div style={{ ...NOTE, color: "#c66" }}>
            The view is not ready yet.
          </div>
        )}

        {/* ── Size ───────────────────────────────────────────────────── */}
        <div style={ROW}>
          <span style={LABEL}>width (px)</span>
          <input
            style={FIELD}
            value={widthText}
            inputMode="numeric"
            onChange={(e) => setWidthText(e.target.value)}
          />
        </div>
        <div style={ROW}>
          <span style={LABEL}>DPI (metadata)</span>
          <input
            style={FIELD}
            value={dpiText}
            inputMode="numeric"
            onChange={(e) => setDpiText(e.target.value)}
          />
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
          {SIZE_PRESETS.map((p) => (
            <button
              key={p.label}
              style={{ ...BTN, padding: "2px 6px", fontSize: 10 }}
              onClick={() => {
                setWidthText(String(p.px));
                setDpiText(String(p.dpi));
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {info && widthValid && dpiValid && (
          <div style={{ ...NOTE, marginBottom: 10 }}>
            Output <span style={{ color: "#9c9" }}>{outWidth} × {info.outHeight} px</span>
            {scaleBar && " (plus the scale-bar margin)"} ={" "}
            {(outWidth / dpi).toFixed(2)} × {(info.outHeight / dpi).toFixed(2)} in at {dpi} DPI.
            <br />
            {info.magnification.toFixed(1)}× the region's {Math.round(info.sourcePx)} source image pixels.
          </div>
        )}

        {/* ── Appearance ─────────────────────────────────────────────── */}
        <div style={ROW}>
          <span style={LABEL}>background</span>
          <select
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            style={{ ...FIELD, width: 96 }}
          >
            <option value="black">black (as shown)</option>
            <option value="transparent">transparent</option>
            <option value="white">white</option>
          </select>
        </div>

        <label style={{ ...ROW, cursor: "pointer" }}>
          <span style={LABEL}>scale bar</span>
          <input type="checkbox" checked={scaleBar} onChange={(e) => setScaleBar(e.target.checked)} />
        </label>
        {scaleBar && info && info.barUm > 0 && (
          <div style={{ ...NOTE, marginTop: -3, marginBottom: 7 }}>
            {formatScaleLabel(info.barUm)} bar in a margin band below the plot, not over it.
          </div>
        )}

        <label style={{ ...ROW, cursor: "pointer" }}>
          <span style={LABEL}>include annotations</span>
          <input
            type="checkbox"
            checked={includeAnnotations}
            onChange={(e) => setIncludeAnnotations(e.target.checked)}
          />
        </label>

        <div style={{ ...NOTE, marginBottom: 10 }}>
          Draws the data layers only — no morphology image. Everything is
          re-rendered at the output size, so lines and {unit} outlines stay sharp
          at any resolution. Sampling is unchanged, so the figure shows exactly
          what the panel shows.
        </div>

        {/* ── Warnings ───────────────────────────────────────────────── */}
        {geometry && geometry.inView === false && (
          <div style={{ ...NOTE, color: "#ca8" }}>
            Part of the rectangle is off screen. Layers only hold data for the
            current view, so the export would be missing whatever is outside it —
            pan or zoom until the whole rectangle is visible first.
          </div>
        )}
        {rotationMismatch && (
          <div style={{ ...NOTE, color: "#ca8" }}>
            The rectangle was drawn at {geometry.rotation}° but the panel is now
            at {panelRotation}°. The export reproduces the framing as drawn;
            redraw it to use the current orientation.
          </div>
        )}
        {big && (
          <div style={{ ...NOTE, color: "#ca8" }}>
            Large output — this may take a few seconds and a lot of memory.
          </div>
        )}
        {tooBig && (
          <div style={{ ...NOTE, color: "#c66" }}>
            {outWidth} × {info.outHeight} px exceeds the {MAX_OUTPUT_DIM} px limit
            most GPUs impose. Reduce the width.
          </div>
        )}
        {error && <div style={{ ...NOTE, color: "#c66" }}>{error}</div>}
        {done && (
          <div style={{ ...NOTE, color: "#9c9" }}>
            Saved {done.width} × {done.height} px.
          </div>
        )}

        {/* ── Actions ────────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
          <button
            onClick={run}
            disabled={!canExport}
            style={{
              ...BTN,
              flex: 1,
              color: canExport ? "#9c9" : "#555",
              borderColor: canExport ? "#3a5a3a" : "#333",
              cursor: canExport ? "pointer" : "default",
            }}
          >
            {busy ? "rendering…" : "Export PNG"}
          </button>
          {hasRect && (
            <button
              onClick={onClearRect}
              title="Remove the framing rectangle"
              style={{ ...BTN, color: "#c66", borderColor: "#523" }}
            >
              clear ▭
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
