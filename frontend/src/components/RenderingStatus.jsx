/**
 * RenderingStatus — floating badge that appears when any data layer for this
 * panel is still fetching from the backend.
 *
 * Visibility is delayed by ONSET_MS so fast requests (< ~400ms) never flash the
 * badge at all.  Disappears immediately once all fetches complete so the user
 * gets instant confirmation that the view is stable.
 *
 * Positioned at the bottom-right of the viewer canvas, above OSD controls.
 * pointer-events: none so it never blocks clicks.
 */
import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

const ONSET_MS = 400;

export default function RenderingStatus({ panelIndex }) {
  const isLoading = useStore((s) => s.loadingKeys.has(`panel-${panelIndex}`));
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (isLoading) {
      // Only show the badge if loading persists beyond the onset threshold.
      // This prevents a flicker on fast requests that resolve within ~400ms.
      timerRef.current = setTimeout(() => setVisible(true), ONSET_MS);
    } else {
      // Disappear immediately — instant feedback that the view is stable.
      setVisible(false);
    }
    return () => clearTimeout(timerRef.current);
  }, [isLoading]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 40,
        right: 10,
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "rgba(0,0,0,0.72)",
        color: "#bbb",
        fontFamily: "monospace",
        fontSize: 11,
        padding: "5px 10px",
        borderRadius: 4,
        pointerEvents: "none",
        zIndex: 20,
        userSelect: "none",
      }}
    >
      {/* SVG spinner — uses the tp-spin keyframe defined in index.html */}
      <svg
        width="13"
        height="13"
        viewBox="0 0 13 13"
        style={{ animation: "tp-spin 0.75s linear infinite", flexShrink: 0 }}
      >
        {/* Track ring */}
        <circle cx="6.5" cy="6.5" r="5" fill="none" stroke="#444" strokeWidth="1.8" />
        {/* Leading arc */}
        <path
          d="M 6.5 1.5 A 5 5 0 0 1 11.5 6.5"
          fill="none"
          stroke="#ccc"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
      Computing…
    </div>
  );
}
