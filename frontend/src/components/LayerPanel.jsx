/**
 * Layer panel — toggle, opacity, color-by, and layer controls.
 */
import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { legendGradient, QUAL_PALETTE } from "../utils/colormap";

const SECTION_HEADER = {
  fontSize: 10,
  fontFamily: "monospace",
  color: "#555",
  textTransform: "uppercase",
  letterSpacing: 1,
  marginTop: 14,
  marginBottom: 6,
  paddingBottom: 3,
  borderBottom: "1px solid #2a2a2a",
};

const LABEL_STYLE = {
  fontSize: 11,
  color: "#aaa",
  fontFamily: "monospace",
  userSelect: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const SELECT_STYLE = {
  background: "#252525",
  color: "#ccc",
  border: "1px solid #3a3a3a",
  borderRadius: 3,
  padding: "2px 4px",
  fontFamily: "monospace",
  fontSize: 11,
  cursor: "pointer",
  width: "100%",
};

const INPUT_STYLE = {
  ...SELECT_STYLE,
  marginTop: 4,
};

const PALETTE_OPTIONS = ["viridis", "plasma", "magma", "inferno"];

function DatasetPicker() {
  const { apiBase, dataset, setDataset, activeImage, setActiveImage } = useStore();
  const [datasets, setDatasets] = useState([]);
  const [images, setImages] = useState([]);

  // Fetch dataset list; auto-initialize to first entry if store has no valid dataset
  useEffect(() => {
    fetch(`${apiBase}/spatial/datasets`)
      .then((r) => r.ok ? r.json() : [])
      .then((list) => {
        if (!Array.isArray(list)) return;
        setDatasets(list);
        if (list.length > 0) {
          const cur = useStore.getState().dataset;
          if (!cur || !list.includes(cur)) setDataset(list[0]);
        }
      })
      .catch(() => {});
  }, [apiBase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch available images for the current dataset
  useEffect(() => {
    if (!dataset) return;
    fetch(`${apiBase}/spatial/${dataset}/images`)
      .then((r) => r.ok ? r.json() : [])
      .then((list) => {
        if (!Array.isArray(list)) return;
        setImages(list);
        if (list.length > 0 && !list.includes(activeImage)) {
          setActiveImage(list[0]);
        }
      })
      .catch(() => setImages([]));
  }, [apiBase, dataset]); // eslint-disable-line react-hooks/exhaustive-deps

  if (datasets.length === 0) {
    return (
      <div style={{ marginBottom: 12, color: "#555", fontSize: 11, fontFamily: "monospace" }}>
        Connecting…
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ ...SECTION_HEADER, marginTop: 0 }}>Dataset</div>
      <select
        value={dataset || ""}
        onChange={(e) => setDataset(e.target.value)}
        style={SELECT_STYLE}
      >
        {datasets.map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
      {images.length > 1 && (
        <>
          <div style={{ ...SECTION_HEADER, marginTop: 8 }}>Image</div>
          <select
            value={activeImage}
            onChange={(e) => setActiveImage(e.target.value)}
            style={SELECT_STYLE}
          >
            {images.map((img) => (
              <option key={img} value={img}>{img}</option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

export default function LayerPanel() {
  const { platformCapabilities } = useStore();
  const hasTranscripts = platformCapabilities?.has_transcripts ?? true;
  const hasBoundaries  = platformCapabilities?.has_boundaries  ?? true;
  const unitLabel      = platformCapabilities?.unit_label ?? "cell";
  const unitTitle      = unitLabel.charAt(0).toUpperCase() + unitLabel.slice(1);

  return (
    <div style={{
      flex: 1,
      overflowY: "auto",
      padding: "10px 12px",
      color: "#ccc",
      fontFamily: "monospace",
      fontSize: 12,
      background: "#1e1e1e",
    }}>
      <DatasetPicker />
      <div style={{ fontWeight: "bold", marginBottom: 10, fontSize: 13, color: "#fff" }}>Layers</div>

      <div style={SECTION_HEADER}>Core</div>
      <MorphologyRow />
      {hasTranscripts && <LayerRow id="transcripts" label="Transcripts" color="#e88" />}
      {hasBoundaries  && <CellSegmentsRow unitTitle={unitTitle} />}

      <div style={SECTION_HEADER}>{unitTitle} Color</div>
      <ColorBySection unitLabel={unitLabel} />

      {hasTranscripts && (
        <>
          <div style={SECTION_HEADER}>Transcript Species</div>
          <TranscriptSpeciesSection />
        </>
      )}

      <div style={SECTION_HEADER}>Tissue Graph</div>
      <TissueGraphSection />

      <div style={SECTION_HEADER}>Edge Data</div>
      <EdgeSection />

      <RegionsSection />
    </div>
  );
}

// ── Color By section ──────────────────────────────────────────────────────────
function ColorBySection({ unitLabel = "cell" }) {
  const {
    apiBase, dataset,
    cellColorEnabled, setCellColorEnabled,
    colorBy, setColorBy,
    cellColorPalette, setCellColorPalette,
    allGenes, setAllGenes,
    selectedGenes,
    cellColorRange,
    cellColorClamp, setCellColorClamp,
  } = useStore();

  const [cellSchema, setCellSchema] = useState(null);

  // Fetch full gene list and cell schema once per dataset
  useEffect(() => {
    fetch(`${apiBase}/spatial/${dataset}/genes`)
      .then((r) => r.ok ? r.json() : [])
      .then((g) => { if (Array.isArray(g)) setAllGenes(g); })
      .catch(() => {});
    fetch(`${apiBase}/spatial/${dataset}/cells/schema`)
      .then((r) => r.ok ? r.json() : null)
      .then((s) => { if (s) setCellSchema(s); })
      .catch(() => {});
  }, [apiBase, dataset]); // eslint-disable-line react-hooks/exhaustive-deps

  const { mode, field } = colorBy;
  const selectedCount = selectedGenes === null ? allGenes.length : selectedGenes.size;

  // Determine if the selected metadata column is categorical
  const fieldDtype = field && cellSchema ? cellSchema.columns[field] : null;
  const isCategorical = fieldDtype === "object" || fieldDtype === "string" ||
    (fieldDtype?.startsWith("int") && false); // int cols treated as continuous unless overridden

  return (
    <div style={{ marginBottom: 6 }}>
      {/* On/off toggle row */}
      <label style={{ ...LABEL_STYLE, marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={cellColorEnabled}
          onChange={(e) => setCellColorEnabled(e.target.checked)}
          style={{ accentColor: "#6cf" }}
        />
        Color {unitLabel}s
      </label>

      {cellColorEnabled && (
        <>
          {/* Mode selector */}
          <select
            value={mode}
            onChange={(e) => { setColorBy(e.target.value, null); setCellColorClamp(null, null); }}
            style={SELECT_STYLE}
          >
            <option value="off">— choose mode —</option>
            <option value="gene_set">Gene set (selected species)</option>
            <option value="metadata">Cell metadata</option>
          </select>

          {/* Gene set info */}
          {mode === "gene_set" && (
            <div style={{ marginTop: 4, fontSize: 10, color: "#888" }}>
              {selectedCount} of {allGenes.length} genes selected
              <span style={{ color: "#555" }}> (use Transcript Species to adjust)</span>
            </div>
          )}

          {/* Metadata column + palette */}
          {mode === "metadata" && (
            <>
              <select
                value={field ?? ""}
                onChange={(e) => { setColorBy("metadata", e.target.value || null); setCellColorClamp(null, null); }}
                style={{ ...SELECT_STYLE, marginTop: 4 }}
              >
                <option value="">— select column —</option>
                {cellSchema?.columns && Object.keys(cellSchema.columns).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </>
          )}

          {/* Palette picker — only for continuous modes */}
          {(mode === "gene_set" || (mode === "metadata" && field && !isCategorical)) && (
            <select
              value={cellColorPalette}
              onChange={(e) => setCellColorPalette(e.target.value)}
              style={{ ...SELECT_STYLE, marginTop: 4 }}
            >
              {PALETTE_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}

          {/* Legend */}
          {mode === "gene_set" && (
            <ClampableLegend label="gene set expression" palette={cellColorPalette}
              vmin={cellColorRange.vmin} vmax={cellColorRange.vmax}
              clamp={cellColorClamp} setClamp={setCellColorClamp} accentColor="#6cf" />
          )}
          {mode === "metadata" && field && !isCategorical && (
            <ClampableLegend label={field} palette={cellColorPalette}
              vmin={cellColorRange.vmin} vmax={cellColorRange.vmax}
              clamp={cellColorClamp} setClamp={setCellColorClamp} accentColor="#6cf" />
          )}
          {mode === "metadata" && field && isCategorical && (
            <CategoricalLegend field={field} apiBase={apiBase} dataset={dataset} />
          )}
        </>
      )}
    </div>
  );
}

function ClampableLegend({ label, palette, vmin, vmax, clamp, setClamp, accentColor = "#f90" }) {
  const fmt = (v) => (v == null ? "" : Math.abs(v) < 0.01 || Math.abs(v) >= 1000
    ? v.toExponential(1) : v.toFixed(2));
  const hasData = vmin != null && vmax != null && vmax > vmin;
  const low  = clamp?.low  ?? vmin;
  const high = clamp?.high ?? vmax;
  const step = hasData ? (vmax - vmin) / 200 : 0.01;
  const clamped = clamp?.low != null || clamp?.high != null;

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ height: 8, borderRadius: 2, background: legendGradient(palette), marginBottom: 2 }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#555", marginBottom: hasData ? 4 : 0 }}>
        <span>{hasData ? fmt(low) : "low"}</span>
        <span style={{ color: "#666", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 100 }}>{label}</span>
        <span>{hasData ? fmt(high) : "high"}</span>
      </div>
      {hasData && (
        <div style={{ fontSize: 9, color: "#444" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
            <span style={{ width: 18, color: "#444" }}>lo</span>
            <input type="range" min={vmin} max={vmax} step={step}
              value={low ?? vmin}
              onChange={(e) => setClamp(parseFloat(e.target.value), clamp?.high ?? null)}
              style={{ flex: 1, accentColor, cursor: "pointer" }} />
            <span style={{ width: 36, textAlign: "right", color: "#555" }}>{fmt(low)}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 18, color: "#444" }}>hi</span>
            <input type="range" min={vmin} max={vmax} step={step}
              value={high ?? vmax}
              onChange={(e) => setClamp(clamp?.low ?? null, parseFloat(e.target.value))}
              style={{ flex: 1, accentColor, cursor: "pointer" }} />
            <span style={{ width: 36, textAlign: "right", color: "#555" }}>{fmt(high)}</span>
          </div>
          {clamped && (
            <button onClick={() => setClamp(null, null)}
              style={{ ...CHIP_STYLE, marginTop: 3, color: "#888" }}>
              reset range
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CategoricalLegend({ field, apiBase, dataset }) {
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    if (!field) return;
    fetch(`${apiBase}/spatial/${dataset}/color-values`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "metadata", field }),
    })
      .then((r) => r.json())
      .then((d) => { if (d.type === "categorical") setCategories(d.categories); })
      .catch(() => {});
  }, [apiBase, dataset, field]);

  if (!categories.length) return null;
  return (
    <div style={{ marginTop: 6 }}>
      {categories.map((cat, i) => {
        const [r, g, b] = QUAL_PALETTE[i % QUAL_PALETTE.length];
        return (
          <div key={cat} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${r},${g},${b})`, flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={cat}>{cat}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Morphology row ────────────────────────────────────────────────────────────
function MorphologyRow() {
  const { layers, setLayerProp } = useStore();
  const state = layers.morphology ?? { visible: true, opacity: 1.0 };
  return (
    <LayerRowBase
      label="Morphology" color="#888"
      visible={state.visible} opacity={state.opacity}
      onToggle={(v) => setLayerProp("morphology", "visible", v)}
      onOpacity={(v) => setLayerProp("morphology", "opacity", v)}
    />
  );
}

function LayerRow({ id, label, color }) {
  const { layers, setLayerProp } = useStore();
  const state = layers[id] ?? { visible: true, opacity: 0.8 };
  return (
    <LayerRowBase
      label={label} color={color}
      visible={state.visible} opacity={state.opacity}
      onToggle={(v) => setLayerProp(id, "visible", v)}
      onOpacity={(v) => setLayerProp(id, "opacity", v)}
    />
  );
}

function LayerRowBase({ label, color, visible, opacity, onToggle, onOpacity }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={LABEL_STYLE}>
        <input
          type="checkbox"
          checked={visible}
          onChange={(e) => onToggle(e.target.checked)}
          style={{ accentColor: color, width: 13, height: 13, cursor: "pointer" }}
        />
        <span style={{
          display: "inline-block", width: 10, height: 10, borderRadius: 2,
          background: color, flexShrink: 0, opacity: visible ? 1 : 0.3,
        }} />
        <span style={{ color: visible ? "#ddd" : "#555" }}>{label}</span>
      </label>
      {visible && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 26, marginTop: 3 }}>
          <input
            type="range" min={0} max={1} step={0.01} value={opacity}
            onChange={(e) => onOpacity(parseFloat(e.target.value))}
            style={{ flex: 1, accentColor: color, cursor: "pointer" }}
          />
          <span style={{ color: "#555", width: 28, textAlign: "right" }}>
            {Math.round(opacity * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}

function CellSegmentsRow({ unitTitle = "Cell" }) {
  const { layers, setLayerProp } = useStore();
  const state = layers.cellSegments ?? { visible: true, opacity: 0.6, outlineOpacity: 0.8 };
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={LABEL_STYLE}>
        <input type="checkbox" checked={state.visible}
          onChange={(e) => setLayerProp("cellSegments", "visible", e.target.checked)}
          style={{ accentColor: "#6cf", width: 13, height: 13, cursor: "pointer" }} />
        <span style={{
          display: "inline-block", width: 10, height: 10, borderRadius: 2,
          background: "#6cf", flexShrink: 0, opacity: state.visible ? 1 : 0.3,
        }} />
        <span style={{ color: state.visible ? "#ddd" : "#555" }}>{unitTitle} Segments</span>
      </label>
      {state.visible && (
        <div style={{ paddingLeft: 26, marginTop: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
            <span style={{ fontSize: 10, color: "#555", width: 42, flexShrink: 0 }}>fill</span>
            <input type="range" min={0} max={1} step={0.01} value={state.opacity}
              onChange={(e) => setLayerProp("cellSegments", "opacity", parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: "#6cf", cursor: "pointer" }} />
            <span style={{ color: "#555", width: 28, textAlign: "right" }}>
              {Math.round(state.opacity * 100)}%
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, color: "#555", width: 42, flexShrink: 0 }}>outline</span>
            <input type="range" min={0} max={1} step={0.01}
              value={state.outlineOpacity ?? 0.8}
              onChange={(e) => setLayerProp("cellSegments", "outlineOpacity", parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: "#6cf", cursor: "pointer" }} />
            <span style={{ color: "#555", width: 28, textAlign: "right" }}>
              {Math.round((state.outlineOpacity ?? 0.8) * 100)}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Transcript species section ────────────────────────────────────────────────
function TranscriptSpeciesSection() {
  const { allGenes, selectedGenes, setSelectedGenes, toggleSelectedGene } = useStore();
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");

  const filterActive = selectedGenes !== null;
  const selectedList = filterActive ? [...selectedGenes].sort() : [];

  const pickerGenes = search.trim()
    ? allGenes.filter((g) => g.toLowerCase().includes(search.toLowerCase()))
    : allGenes;

  if (allGenes.length === 0) {
    return <div style={{ color: "#3a3a3a", paddingLeft: 4, marginBottom: 6, fontSize: 11 }}>— loading genes…</div>;
  }

  return (
    <div style={{ marginBottom: 8 }}>
      {/* Status + action buttons */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: "#555", flex: 1 }}>
          {filterActive
            ? `${selectedGenes.size} / ${allGenes.length} genes selected`
            : `all ${allGenes.length} genes`}
        </span>
        {filterActive && (
          <button
            onClick={() => { setSelectedGenes(null); setExpanded(false); }}
            style={CHIP_STYLE}
          >
            clear
          </button>
        )}
        <button onClick={() => setExpanded((e) => !e)} style={CHIP_STYLE}>
          {expanded ? "▲" : filterActive ? "edit ▼" : "select ▼"}
        </button>
      </div>

      {/* Compact selected-gene list (filter active, picker closed) */}
      {filterActive && !expanded && (
        <div style={{ maxHeight: 110, overflowY: "auto", marginBottom: 4 }}>
          {selectedList.length === 0 && (
            <div style={{ fontSize: 11, color: "#555", paddingLeft: 2 }}>no genes selected</div>
          )}
          {selectedList.map((gene) => (
            <div
              key={gene}
              style={{ display: "flex", alignItems: "center", fontSize: 11, color: "#e88", padding: "1px 0" }}
            >
              <span style={{ flex: 1 }}>{gene}</span>
              <button
                onClick={() => toggleSelectedGene(gene)}
                style={{ background: "transparent", border: "none", color: "#844", cursor: "pointer", fontSize: 11, padding: "0 2px", lineHeight: 1 }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Expanded gene picker */}
      {expanded && (
        <div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="filter genes…"
            style={{ ...SELECT_STYLE, marginBottom: 4 }}
          />
          <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
            <button onClick={() => setSelectedGenes(null)} style={CHIP_STYLE}>all</button>
            <button onClick={() => setSelectedGenes(new Set())} style={CHIP_STYLE}>none</button>
          </div>
          <div style={{ maxHeight: 180, overflowY: "auto" }}>
            {pickerGenes.map((gene) => {
              const checked = selectedGenes === null || selectedGenes.has(gene);
              return (
                <label key={gene} style={{ ...LABEL_STYLE, marginBottom: 3, display: "flex" }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSelectedGene(gene)}
                    style={{ accentColor: "#e88", width: 12, height: 12, cursor: "pointer", flexShrink: 0 }}
                  />
                  <span
                    style={{
                      marginLeft: 4,
                      color: checked ? "#ccc" : "#444",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {gene}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const CHIP_STYLE = {
  background: "#2a2a2a",
  color: "#777",
  border: "1px solid #3a3a3a",
  borderRadius: 3,
  padding: "1px 5px",
  fontFamily: "monospace",
  fontSize: 10,
  cursor: "pointer",
};

// ── Tissue graph section ──────────────────────────────────────────────────────
function TissueGraphSection() {
  const { layers, setLayerProp } = useStore();
  const state = layers.tissueGraph ?? { visible: true, opacity: 0.25 };
  return (
    <div style={{ marginBottom: 8 }}>
      <LayerRowBase
        label="Tissue Graph"
        color="#888"
        visible={state.visible}
        opacity={state.opacity}
        onToggle={(v) => setLayerProp("tissueGraph", "visible", v)}
        onOpacity={(v) => setLayerProp("tissueGraph", "opacity", v)}
      />
    </div>
  );
}

// ── Edge section ──────────────────────────────────────────────────────────────
// Columns that are identity/spatial and shouldn't appear in metadata picker
const EDGE_SKIP_COLS = new Set(["x1", "y1", "x2", "y2", "edge", "sending_cell", "receiving_cell", "is_autocrine", "lrm_id", "lrm", "ligand", "receptor", "score", "score_norm"]);

function EdgeSection() {
  const {
    apiBase, dataset,
    layers, setLayerProp,
    edgeMinStrength, setEdgeMinStrength,
    edgeColorBy, setEdgeColorBy,
    edgeColorPalette, setEdgeColorPalette,
    edgeDirectional, setEdgeDirectional,
    edgeOffset, setEdgeOffset,
    showAutocrine, setShowAutocrine,
    autocrineRadius, setAutocrineRadius,
    autocrineLineWidth, setAutocrineLineWidth,
    edgeWidth, setEdgeWidth,
    showArrowheads, setShowArrowheads,
    arrowStyle, setArrowStyle,
    arrowheadScale, setArrowheadScale,
    lrmCatalogue, setLrmCatalogue,
    hiddenLrms, toggleLrm, setAllLrmsVisible, hideAllLrms,
    edgeColorRange,
    edgeColorClamp, setEdgeColorClamp,
    edgeDensity, setEdgeDensity,
  } = useStore();
  const state = layers.edges ?? { visible: true, opacity: 0.9 };
  const [localStrength, setLocalStrength] = useState(edgeMinStrength ?? 0);
  const commitTimer = useRef(null);
  const [edgeSchema, setEdgeSchema] = useState(null);
  const [lrmSearch, setLrmSearch] = useState("");

  useEffect(() => {
    fetch(`${apiBase}/edges/${dataset}/schema`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setEdgeSchema)
      .catch(() => {});
    if (lrmCatalogue.length === 0) {
      fetch(`${apiBase}/edges/${dataset}/lrm-catalogue`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setLrmCatalogue)
        .catch(() => {});
    }
  }, [apiBase, dataset]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStrength = (e) => {
    const v = parseFloat(e.target.value);
    setLocalStrength(v);
    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => setEdgeMinStrength(v), 300);
  };

  // Metadata columns for color-by (exclude spatial/identity cols)
  const metaCols = edgeSchema?.columns
    ? Object.keys(edgeSchema.columns).filter((c) => !EDGE_SKIP_COLS.has(c))
    : [];

  const { mode, field } = edgeColorBy;
  const selectedLrmCount = lrmCatalogue.length - hiddenLrms.size;

  // Determine if selected metadata column is categorical
  const fieldDtype = field && edgeSchema ? edgeSchema.columns[field] : null;
  const isCategorical = fieldDtype === "object" || fieldDtype === "string" || fieldDtype === "bool";

  return (
    <div style={{ marginBottom: 8 }}>
      <LayerRowBase
        label="Edges"
        color="#f90"
        visible={state.visible}
        opacity={state.opacity}
        onToggle={(v) => setLayerProp("edges", "visible", v)}
        onOpacity={(v) => setLayerProp("edges", "opacity", v)}
      />
      {state.visible && (
        <div style={{ paddingLeft: 26, marginTop: 4 }}>
          {/* Edge style toggles */}
          <div style={{ display: "flex", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
            <label style={LABEL_STYLE}>
              <input type="checkbox" checked={edgeDirectional}
                onChange={(e) => setEdgeDirectional(e.target.checked)}
                style={{ accentColor: "#f90" }} />
              Directional
            </label>
            <label style={LABEL_STYLE}>
              <input type="checkbox" checked={showArrowheads && edgeDirectional}
                disabled={!edgeDirectional}
                onChange={(e) => setShowArrowheads(e.target.checked)}
                style={{ accentColor: "#f90" }} />
              Arrowheads
            </label>
            <label style={LABEL_STYLE}>
              <input type="checkbox" checked={showAutocrine}
                onChange={(e) => setShowAutocrine(e.target.checked)}
                style={{ accentColor: "#f90" }} />
              Autocrine
            </label>
          </div>

          {/* Edge width */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: "#555", whiteSpace: "nowrap", width: 72 }}>
              width: {edgeWidth.toFixed(1)}
            </span>
            <input
              type="range" min={0.5} max={8} step={0.5}
              value={edgeWidth}
              onChange={(e) => setEdgeWidth(parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: "#f90", cursor: "pointer" }}
            />
          </div>

          {/* Offset slider (directional mode only) */}
          {edgeDirectional && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 10, color: "#555", whiteSpace: "nowrap", width: 72 }}>
                offset: {edgeOffset.toFixed(1)}
              </span>
              <input
                type="range" min={0} max={20} step={0.5}
                value={edgeOffset}
                onChange={(e) => setEdgeOffset(parseFloat(e.target.value))}
                style={{ flex: 1, accentColor: "#f90", cursor: "pointer" }}
              />
            </div>
          )}

          {/* Autocrine controls */}
          {showAutocrine && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "#555", whiteSpace: "nowrap", width: 72 }}>
                  ring r: {autocrineRadius}
                </span>
                <input
                  type="range" min={4} max={40} step={1}
                  value={autocrineRadius}
                  onChange={(e) => setAutocrineRadius(parseInt(e.target.value, 10))}
                  style={{ flex: 1, accentColor: "#f90", cursor: "pointer" }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "#555", whiteSpace: "nowrap", width: 72 }}>
                  ring w: {autocrineLineWidth.toFixed(1)}
                </span>
                <input
                  type="range" min={0.5} max={8} step={0.5}
                  value={autocrineLineWidth}
                  onChange={(e) => setAutocrineLineWidth(parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: "#f90", cursor: "pointer" }}
                />
              </div>
            </div>
          )}

          {/* Arrowhead controls (only when arrowheads + directional are on) */}
          {edgeDirectional && showArrowheads && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: "#555", whiteSpace: "nowrap", width: 72 }}>
                  arrow: {arrowheadScale.toFixed(2)}×
                </span>
                <input
                  type="range" min={0.25} max={3} step={0.25}
                  value={arrowheadScale}
                  onChange={(e) => setArrowheadScale(parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: "#f90", cursor: "pointer" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={LABEL_STYLE}>
                  <input type="radio" name="arrowStyle" value="full"
                    checked={arrowStyle === "full"}
                    onChange={() => setArrowStyle("full")}
                    style={{ accentColor: "#f90" }} />
                  Full
                </label>
                <label style={LABEL_STYLE}>
                  <input type="radio" name="arrowStyle" value="half"
                    checked={arrowStyle === "half"}
                    onChange={() => setArrowStyle("half")}
                    style={{ accentColor: "#f90" }} />
                  Harpoon
                </label>
              </div>
            </div>
          )}

          {/* Density */}
          <div style={{ fontSize: 10, color: "#555", marginBottom: 2 }}>
            density: {Math.round(edgeDensity * 100)}%
          </div>
          <input
            type="range" min={0.1} max={5} step={0.1}
            value={edgeDensity}
            onChange={(e) => setEdgeDensity(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "#f90", cursor: "pointer", marginBottom: 8 }}
          />

          {/* Strength filter */}
          <div style={{ fontSize: 10, color: "#555", marginBottom: 2 }}>
            min strength: {localStrength.toFixed(2)}
          </div>
          <input
            type="range" min={0} max={4} step={0.05}
            value={localStrength}
            onChange={handleStrength}
            style={{ width: "100%", accentColor: "#f90", cursor: "pointer", marginBottom: 8 }}
          />

          {/* ── Edge Color ──────────────────────────────────────────────── */}
          <div style={{ fontSize: 10, color: "#555", marginBottom: 3 }}>edge color</div>
          <select value={mode} onChange={(e) => { setEdgeColorBy(e.target.value, null); setEdgeColorClamp(null, null); }} style={SELECT_STYLE}>
            <option value="default">Default (uniform)</option>
            <option value="lrm_set">LRM Set (selected mechanisms)</option>
            <option value="metadata">Metadata column</option>
          </select>

          {mode === "lrm_set" && (
            <div style={{ marginTop: 4, fontSize: 10, color: "#888" }}>
              {selectedLrmCount} of {lrmCatalogue.length} LRMs selected
              <span style={{ color: "#555" }}> (use checklist below)</span>
            </div>
          )}

          {mode === "metadata" && (
            <select
              value={field ?? ""}
              onChange={(e) => { setEdgeColorBy("metadata", e.target.value || null); setEdgeColorClamp(null, null); }}
              style={{ ...SELECT_STYLE, marginTop: 4 }}
            >
              <option value="">— select column —</option>
              {metaCols.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}

          {/* Palette — only for continuous color modes */}
          {(mode === "lrm_set" || (mode === "metadata" && field && !isCategorical)) && (
            <select
              value={edgeColorPalette}
              onChange={(e) => setEdgeColorPalette(e.target.value)}
              style={{ ...SELECT_STYLE, marginTop: 4 }}
            >
              {PALETTE_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}

          {/* Legend */}
          {mode === "lrm_set" && (
            <ClampableLegend label="LRM set score" palette={edgeColorPalette}
              vmin={edgeColorRange.vmin} vmax={edgeColorRange.vmax}
              clamp={edgeColorClamp} setClamp={setEdgeColorClamp} accentColor="#f90" />
          )}
          {mode === "metadata" && field && !isCategorical && (
            <ClampableLegend label={field} palette={edgeColorPalette}
              vmin={edgeColorRange.vmin} vmax={edgeColorRange.vmax}
              clamp={edgeColorClamp} setClamp={setEdgeColorClamp} accentColor="#f90" />
          )}
          {mode === "metadata" && field && isCategorical && (
            <EdgeCategoricalLegend field={field} apiBase={apiBase} dataset={dataset} />
          )}

          {/* ── LRM Mechanisms checklist ─────────────────────────────── */}
          {lrmCatalogue.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ ...SECTION_HEADER, marginTop: 6 }}>LRM Mechanisms</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "#555", flex: 1 }}>
                  {selectedLrmCount} / {lrmCatalogue.length} active
                </span>
                <button onClick={setAllLrmsVisible} style={CHIP_STYLE}>all</button>
                <button onClick={hideAllLrms} style={CHIP_STYLE}>none</button>
              </div>
              <input
                type="text"
                value={lrmSearch}
                onChange={(e) => setLrmSearch(e.target.value)}
                placeholder="filter mechanisms…"
                style={{ ...SELECT_STYLE, marginBottom: 4 }}
              />
              <div style={{ maxHeight: 160, overflowY: "auto" }}>
                {lrmCatalogue
                  .filter((e) =>
                    !lrmSearch.trim() ||
                    `${e.ligand} ${e.receptor}`.toLowerCase().includes(lrmSearch.toLowerCase())
                  )
                  .map((entry) => {
                    const lrmStr = entry.lrm ?? `${entry.ligand}|${entry.receptor}`;
                    const active = !hiddenLrms.has(lrmStr);
                    return (
                      <label key={lrmStr} style={{ ...LABEL_STYLE, marginBottom: 3, display: "flex" }}>
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => toggleLrm(lrmStr)}
                          style={{ accentColor: "#f90", width: 12, height: 12, cursor: "pointer", flexShrink: 0 }}
                        />
                        <span style={{
                          marginLeft: 4,
                          color: active ? "#ccc" : "#444",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {entry.ligand} → {entry.receptor}
                        </span>
                      </label>
                    );
                  })
                }
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EdgeCategoricalLegend({ field, apiBase, dataset }) {
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    if (!field) return;
    fetch(`${apiBase}/edges/${dataset}/edge-color-values`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "metadata", field }),
    })
      .then((r) => r.json())
      .then((d) => { if (d.type === "categorical") setCategories(d.categories); })
      .catch(() => {});
  }, [apiBase, dataset, field]);

  if (!categories.length) return null;
  return (
    <div style={{ marginTop: 6 }}>
      {categories.map((cat, i) => {
        const [r, g, b] = QUAL_PALETTE[i % QUAL_PALETTE.length];
        return (
          <div key={cat} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${r},${g},${b})`, flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={cat}>{cat}</span>
          </div>
        );
      })}
    </div>
  );
}

function RegionsSection() {
  const { apiBase, dataset, regions, removeRegion } = useStore();
  if (regions.length === 0) return null;

  const exportRegion = async (region) => {
    const res = await fetch(`${apiBase}/spatial/${dataset}/cells/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(region.selectedCellIds),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${dataset}_region_${region.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div style={SECTION_HEADER}>Regions</div>
      {regions.map((r) => {
        const [rv, gv, bv] = r.color;
        const swatch = `rgb(${rv},${gv},${bv})`;
        return (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: swatch, flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 11, color: "#aaa" }}>
              {r.selectedCellIds.length} cells
            </span>
            <button
              title="Export cells as CSV"
              onClick={() => exportRegion(r)}
              style={{ background: "transparent", border: "1px solid #3a3a3a", color: "#8af", borderRadius: 3, padding: "1px 6px", fontFamily: "monospace", fontSize: 10, cursor: "pointer" }}
            >
              CSV
            </button>
            <button
              title="Remove region"
              onClick={() => removeRegion(r.id)}
              style={{ background: "transparent", border: "none", color: "#c44", fontFamily: "monospace", fontSize: 12, cursor: "pointer", padding: "0 2px" }}
            >
              ×
            </button>
          </div>
        );
      })}
    </>
  );
}

function PlaceholderRow({ label }) {
  return <div style={{ color: "#3a3a3a", paddingLeft: 4, marginBottom: 6 }}>{label}</div>;
}
