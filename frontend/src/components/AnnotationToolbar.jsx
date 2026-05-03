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

export default function AnnotationToolbar({ onScreenshot }) {
  const { annotationMode, setAnnotationMode, clearAnnotations, regions, measurements } = useStore();
  const hasAnnotations = regions.length > 0 || measurements.length > 0;

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
