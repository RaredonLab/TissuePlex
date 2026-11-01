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
// How long the most recent failed fetch stays on screen. Long enough to read,
// short enough that a one-off blip does not look like a standing fault.
const ERROR_MS = 12_000;

export default function RenderingStatus({ panelIndex }) {
  const isLoading = useStore((s) => s.loadingKeys.has(`panel-${panelIndex}`));
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);

  // The most recent failed data fetch (utils/clientLog.js). Shown in panel 0
  // only, so split view does not show it twice. Every hook degrades a failed
  // request to an empty layer, which is the right behaviour and also exactly
  // why a dead backend used to look like a hang: nothing said so.
  const backendError = useStore((s) => s.backendError);
  const [errorShown, setErrorShown] = useState(null);
  useEffect(() => {
    if (!backendError || panelIndex !== 0) return;
    setErrorShown(backendError);
    const t = setTimeout(() => setErrorShown(null), ERROR_MS);
    return () => clearTimeout(t);
  }, [backendError, panelIndex]);

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

  const errorBadge = errorShown ? (
    <div
      title={errorShown.context ? JSON.stringify(errorShown.context) : undefined}
      style={{
        position: "absolute",
        bottom: visible ? 70 : 40,
        right: 10,
        maxWidth: 360,
        background: "rgba(90,20,20,0.85)",
        color: "#f99",
        fontFamily: "monospace",
        fontSize: 11,
        padding: "5px 10px",
        borderRadius: 4,
        pointerEvents: "none",
        zIndex: 20,
        userSelect: "none",
        border: "1px solid rgba(255,120,120,0.35)",
      }}
    >
      ⚠ {errorShown.message}
      <span style={{ color: "#a66", marginLeft: 6 }}>— logged</span>
    </div>
  ) : null;

  if (!visible) return errorBadge;

  return (
    <>
    {errorBadge}
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
    </>
  );
}
