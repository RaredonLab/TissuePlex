/**
 * Floating annotation toolbar — Pan / Draw Region / Measure / Clear.
 */
import React from "react";
import { useStore } from "../store";

const MODES = [
  { id: "pan",    label: "Pan",        title: "Pan & zoom (default)" },
  { id: "region", label: "⬡ Region",   title: "Draw annotation region — click vertices, double-click to close" },
  { id: "measure",label: "⟷ Measure",  title: "Measure distance — click two points" },
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

export default function AnnotationToolbar({ onScreenshot, panelIndex = 0 }) {
  const {
    annotationMode, setAnnotationMode, clearAnnotations, regions, measurements,
    panelCount, setPanelCount,
    requestZoomMatch,
  } = useStore();
  const hasAnnotations = regions.length > 0 || measurements.length > 0;
  const isSplit = panelCount >= 2;

  return (
    <div style={{
      position: "absolute",
      top: 10,
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 20,
      display: "flex",
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

      <div style={{ width: 1, background: "#333", margin: "2px 2px" }} />

      <button
        title="Save screenshot as PNG"
        onClick={onScreenshot}
        style={{ ...BTN, color: "#888" }}
      >
        Save PNG
      </button>

      {panelIndex === 0 && (
        <>
          <div style={{ width: 1, background: "#333", margin: "2px 2px" }} />
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
          <div style={{ width: 1, background: "#333", margin: "2px 2px" }} />
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
          <div style={{ width: 1, background: "#333", margin: "2px 2px" }} />
          <button
            title="Clear all annotations and measurements"
            onClick={clearAnnotations}
            style={{ ...BTN, color: "#c44" }}
          >
            Clear
          </button>
        </>
      )}
    </div>
  );
}
