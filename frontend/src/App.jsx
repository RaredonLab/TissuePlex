import React from "react";
import Viewer from "./components/Viewer";
import LayerPanel from "./components/LayerPanel";
import CellInfoPanel from "./components/CellInfoPanel";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: "#f66", fontFamily: "monospace", fontSize: 13, background: "#1a1a1a", height: "100%" }}>
          <div style={{ marginBottom: 8, color: "#aaa" }}>TissuePlex — render error</div>
          <div>{String(this.state.error)}</div>
          <button
            style={{ marginTop: 16, padding: "6px 12px", background: "#333", color: "#ccc", border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontFamily: "monospace" }}
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <div style={{ display: "flex", width: "100%", height: "100%", background: "#1a1a1a" }}>
        <div style={{ flex: 1, position: "relative" }}>
          <Viewer />
        </div>
        <div style={{ width: 320, display: "flex", flexDirection: "column", borderLeft: "1px solid #333" }}>
          <LayerPanel />
          <CellInfoPanel />
        </div>
      </div>
    </ErrorBoundary>
  );
}
