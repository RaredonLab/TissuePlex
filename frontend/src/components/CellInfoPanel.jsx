/**
 * Cell info panel — shown when the user clicks a cell.
 * Fetches /xenium/{dataset}/cells/{cell_id} and displays metadata + expression.
 */
import React, { useEffect, useState } from "react";
import { useStore } from "../store";

const ROW = { display: "flex", justifyContent: "space-between", marginBottom: 3 };
const KEY = { color: "#666" };
const VAL = { color: "#ccc", textAlign: "right", marginLeft: 8, wordBreak: "break-all" };

export default function CellInfoPanel() {
  const { apiBase, dataset, selectedCell } = useStore();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedCell) { setDetail(null); return; }
    setLoading(true);
    fetch(`${apiBase}/xenium/${dataset}/cells/${selectedCell.cell_id}`)
      .then((r) => r.json())
      .then((d) => { setDetail(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [apiBase, dataset, selectedCell]);

  return (
    <div style={{
      height: 260,
      borderTop: "1px solid #2a2a2a",
      padding: "10px 12px",
      color: "#ccc",
      fontFamily: "monospace",
      fontSize: 11,
      overflowY: "auto",
      background: "#1a1a1a",
    }}>
      <div style={{ fontWeight: "bold", marginBottom: 8, fontSize: 12, color: "#fff" }}>Cell Info</div>

      {!selectedCell && (
        <div style={{ color: "#444" }}>Click a cell to inspect</div>
      )}

      {loading && <div style={{ color: "#555" }}>Loading…</div>}

      {detail && !loading && (
        <>
          {/* Core identity */}
          <MetaRow k="cell_id" v={detail.cell_id} />
          <MetaRow k="x" v={detail.x_centroid?.toFixed(1)} />
          <MetaRow k="y" v={detail.y_centroid?.toFixed(1)} />

          {/* Counts */}
          <Divider />
          <MetaRow k="transcripts" v={detail.transcript_counts} />
          <MetaRow k="total counts" v={detail.total_counts} />
          <MetaRow k="cell area" v={detail.cell_area?.toFixed(1) + " µm²"} />
          {detail.nucleus_area != null && (
            <MetaRow k="nucleus area" v={detail.nucleus_area.toFixed(1) + " µm²"} />
          )}

          {/* Expression */}
          {detail.expression && Object.keys(detail.expression).length > 0 && (
            <>
              <Divider label="expression" />
              {Object.entries(detail.expression)
                .sort((a, b) => b[1] - a[1])
                .map(([gene, count]) => (
                  <MetaRow key={gene} k={gene} v={count} accent />
                ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

function MetaRow({ k, v, accent }) {
  return (
    <div style={ROW}>
      <span style={KEY}>{k}</span>
      <span style={{ ...VAL, color: accent ? "#e8c84a" : "#ccc" }}>{v ?? "—"}</span>
    </div>
  );
}

function Divider({ label }) {
  return (
    <div style={{
      borderTop: "1px solid #2a2a2a",
      marginTop: 5, marginBottom: 5,
      fontSize: 9, color: "#444",
      textTransform: "uppercase", letterSpacing: 1,
    }}>
      {label}
    </div>
  );
}
