import React from "react";
import Viewer from "./components/Viewer";
import LayerPanel from "./components/LayerPanel";
import CellInfoPanel from "./components/CellInfoPanel";

export default function App() {
  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "#1a1a1a" }}>
      {/* Main viewer canvas — OpenSeadragon + deck.gl overlay */}
      <div style={{ flex: 1, position: "relative" }}>
        <Viewer />
      </div>

      {/* Right sidebar */}
      <div style={{ width: 320, display: "flex", flexDirection: "column", borderLeft: "1px solid #333" }}>
        <LayerPanel />
        <CellInfoPanel />
      </div>
    </div>
  );
}
