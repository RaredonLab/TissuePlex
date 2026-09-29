/**
 * Floating annotation toolbar — Pan / Draw Region / Measure / Clear
 * + per-panel rotation controls (⟲ / angle input / ⟳).
 */
import React from "react";
import { useStore } from "../store";
import { usePanelSettings } from "../hooks/usePanelSettings";

const MODES = [
  { id: "pan",    label: "Pan",        title: "Pan & zoom (default)" },
  { id: "region", label: "⬡ Region",   title: "Draw annotation region — click vertices, double-click to close" },
  { id: "measure",label: "⟷ Measure",  title: "Measure distance — click two points" },
  // Distinct from ⬡ Region on purpose: Region selects *cells* for CSV export,
  // Rectangle frames an *image* for figure export. Overloading one tool with
  // both meanings would be the confusing option.
  { id: "rectangle", label: "▭ Rectangle", title: "Drag a rectangle to frame a figure for high-resolution export" },
];

const BTN = {
  background: "transparent",
  border: "none",
  borderRadius: 4,
  padding: "3px 8px",
  fontFamily: "monospace",
  fontSize: 11,
  cursor: "pointer",
};

const SEP = { width: 1, background: "#333", margin: "2px 2px" };

export default function AnnotationToolbar({ onScreenshot, onExport, panelIndex = 0 }) {
  const {
    annotationMode, setAnnotationMode, clearAnnotations, regions, measurements,
    exportRects,
    panelCount, setPanelCount,
    requestZoomMatch,
    panelRotations, setPanelRotation,
  } = usePanelSettings(panelIndex);   // this toolbar belongs to one panel

  // Count and clear only this panel's own annotations: the toolbar is rendered
  // per panel, so a Clear here wiping the other panel's work would be a
  // surprise, and the button greying out because the *other* panel is empty
  // would be worse.
  const mine = (a) => a.filter((x) => (x.panelIndex ?? 0) === panelIndex);
  // The framing rectangle counts: Clear removes it too, so the button has to be
  // reachable when it is the only thing this panel has.
  const hasAnnotations = mine(regions).length > 0 || mine(measurements).length > 0
    || mine(exportRects ?? []).length > 0;
  const isSplit = panelCount >= 2;
  const rotation = panelRotations[panelIndex] ?? 0;

  const rotate = (delta) => setPanelRotation(panelIndex, rotation + delta);

  return (
    <div style={{
      position: "absolute",
      top: 10,
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 20,
      display: "flex",
      alignItems: "center",
      gap: 2,
      background: "rgba(20,20,20,0.85)",
      border: "1px solid #333",
      borderRadius: 6,
      padding: "3px 4px",
      pointerEvents: "all",
    }}>
      {MODES.map(({ id, label, title }) => (
        <button
          key={id}
          title={title}
          onClick={() => setAnnotationMode(id)}
          style={{
            ...BTN,
            background: annotationMode === id ? "#3a3a3a" : "transparent",
            color: annotationMode === id ? "#fff" : "#888",
            outline: annotationMode === id ? "1px solid #555" : "none",
          }}
        >
          {label}
        </button>
      ))}

      <div style={SEP} />

      {/* Two deliberately separate actions. Save PNG stays a one-click capture
          of the view at screen resolution; Export… opens the figure dialog,
          where the output size, DPI tag, background and scale bar are chosen. */}
      <button title="Save screenshot as PNG at screen resolution" onClick={onScreenshot} style={{ ...BTN, color: "#888" }}>
        Save PNG
      </button>
      {onExport && (
        <button
          title="Export a high-resolution figure — uses the ▭ Rectangle framing if one is drawn, otherwise the whole view"
          onClick={onExport}
          style={{ ...BTN, color: "#888" }}
        >
          Export…
        </button>
      )}

      {/* ── Rotation controls ─────────────────────────────── */}
      <div style={SEP} />
      <button
        title="Rotate 90° counter-clockwise"
        onClick={() => rotate(-90)}
        style={{ ...BTN, color: "#888", padding: "3px 6px" }}
      >
        ⟲
      </button>
      <input
        type="number"
        min="0"
        max="359"
        step="1"
        value={rotation}
        title="Rotation angle (0–359°)"
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) setPanelRotation(panelIndex, v);
        }}
        style={{
          width: 38,
          background: rotation !== 0 ? "#1a2a1a" : "transparent",
          border: "1px solid #444",
          borderRadius: 3,
          color: rotation !== 0 ? "#9f9" : "#888",
          fontFamily: "monospace",
          fontSize: 11,
          textAlign: "center",
          padding: "2px 2px",
        }}
      />
      <span style={{ color: "#555", fontFamily: "monospace", fontSize: 11, marginLeft: 1 }}>°</span>
      <button
        title="Rotate 90° clockwise"
        onClick={() => rotate(90)}
        style={{ ...BTN, color: "#888", padding: "3px 6px" }}
      >
        ⟳
      </button>
      {rotation !== 0 && (
        <button
          title="Reset rotation to 0°"
          onClick={() => setPanelRotation(panelIndex, 0)}
          style={{ ...BTN, color: "#9f9", fontSize: 10, padding: "3px 5px" }}
        >
          ×
        </button>
      )}

      {panelIndex === 0 && (
        <>
          <div style={SEP} />
          <button
            title={isSplit ? "Return to single panel" : "Split view — compare two areas side by side"}
            onClick={() => setPanelCount(isSplit ? 1 : 2)}
            style={{
              ...BTN,
              color: isSplit ? "#7ab8f5" : "#888",
              outline: isSplit ? "1px solid #3a5a80" : "none",
              background: isSplit ? "#1a2a3a" : "transparent",
            }}
          >
            {isSplit ? "□ Single" : "⊞ Split"}
          </button>
        </>
      )}

      {isSplit && (
        <>
          <div style={SEP} />
          <button
            title={panelIndex === 0
              ? "Navigate panel 2 to match this view"
              : "Navigate panel 1 to match this view"}
            onClick={() => requestZoomMatch(panelIndex)}
            style={{ ...BTN, color: "#888" }}
          >
            ⇔ Match
          </button>
        </>
      )}

      {hasAnnotations && (
        <>
          <div style={SEP} />
          <button
            title="Clear this panel's annotations, measurements and export rectangle"
            onClick={() => clearAnnotations(panelIndex)}
            style={{ ...BTN, color: "#c44" }}
          >
            Clear
          </button>
        </>
      )}
    </div>
  );
}
