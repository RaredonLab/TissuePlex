import { create } from "zustand";

const API = import.meta.env.VITE_API_URL ?? "/api";

export const useStore = create((set, get) => ({
  // ── Dataset ────────────────────────────────────────────────────────────────
  apiBase: API,
  dataset: null,             // initialized from /spatial/datasets on first load
  activeImage: "morphology", // which OME-TIFF is loaded as the background

  setDataset: (dataset) => set({ dataset, selectedGenes: null, allGenes: [], platformCapabilities: null }),
  setActiveImage: (activeImage) => set({ activeImage }),

  // ── Platform capabilities (fetched from /spatial/{dataset}/info) ──────────
  // null = not yet loaded; object = { has_morphology, has_transcripts, has_boundaries, unit_label }
  platformCapabilities: null,
  setPlatformCapabilities: (caps) => set({ platformCapabilities: caps }),

  // ── Image dimensions (from DZI descriptor, set when OSD opens) ───────────
  imageSize: { w: null, h: null },
  setImageSize: (w, h) => set({ imageSize: { w, h } }),

  // ── Viewport (image pixel coords, kept in sync with OpenSeadragon) ────────
  viewport: null, // { xmin, ymin, xmax, ymax }
  setViewport: (viewport) => set({ viewport }),

  // ── Layer visibility ───────────────────────────────────────────────────────
  layers: {
    morphology:   { visible: false, opacity: 1.0 },
    transcripts:  { visible: false, opacity: 0.8 },
    cellSegments: { visible: true,  opacity: 1.0, outlineOpacity: 0.0 },
    tissueGraph:  { visible: true,  opacity: 0.05 },
    edges:        { visible: false, opacity: 0.25 },
  },

  // ── Color range cache (updated from Viewer hooks for legend display) ──────
  cellColorRange: { vmin: null, vmax: null },
  setCellColorRange: (vmin, vmax) => set({ cellColorRange: { vmin, vmax } }),
  edgeColorRange: { vmin: null, vmax: null },
  setEdgeColorRange: (vmin, vmax) => set({ edgeColorRange: { vmin, vmax } }),

  // ── Color clamp / squish (oob::squish): values outside [low,high] map to palette ends) ──
  cellColorClamp: { low: null, high: null },
  setCellColorClamp: (low, high) => set({ cellColorClamp: { low, high } }),
  edgeColorClamp: { low: null, high: null },
  setEdgeColorClamp: (low, high) => set({ edgeColorClamp: { low, high } }),

  // ── Edge style ────────────────────────────────────────────────────────────
  edgeWidth: 2,
  setEdgeWidth: (v) => set({ edgeWidth: v }),
  showArrowheads: true,
  setShowArrowheads: (v) => set({ showArrowheads: v }),
  // arrowStyle: "full" = filled chevron both sides; "half" = harpoon (outer barb only)
  arrowStyle: "half",
  setArrowStyle: (v) => set({ arrowStyle: v }),
  // arrowheadScale: multiplier on base arrowLen (edgeWidth * 4)
  arrowheadScale: 1.0,
  setArrowheadScale: (v) => set({ arrowheadScale: v }),

  // ── Edge filter + color state ─────────────────────────────────────────────
  // edgeDensity: multiplier on zoom-tiered base limits (0.1 = sparse, 5.0 = dense)
  edgeDensity: 1.0,
  setEdgeDensity: (v) => set({ edgeDensity: v }),
  edgeMinStrength: 0,
  setEdgeMinStrength: (v) => set({ edgeMinStrength: v }),

  // mode: 'default' | 'lrm_set' | 'metadata'
  // field: for metadata = column name; unused for other modes
  edgeColorBy: { mode: "lrm_set", field: null },
  setEdgeColorBy: (mode, field) => set({ edgeColorBy: { mode, field } }),

  // Edge palette (for continuous metadata coloring)
  edgeColorPalette: "viridis",
  setEdgeColorPalette: (p) => set({ edgeColorPalette: p }),

  // Directional rendering: show perpendicular offset so A→B ≠ B→A visually
  edgeDirectional: true,
  setEdgeDirectional: (v) => set({ edgeDirectional: v }),
  // edgeOffset: perpendicular separation in image-pixels between A→B and B→A
  edgeOffset: 0,
  setEdgeOffset: (v) => set({ edgeOffset: v }),

  // Show autocrine self-loop rings
  showAutocrine: false,
  setShowAutocrine: (v) => set({ showAutocrine: v }),
  // Autocrine circle geometry — independent from directed-edge line width
  autocrineRadius: 14,
  setAutocrineRadius: (v) => set({ autocrineRadius: v }),
  autocrineLineWidth: 2,
  setAutocrineLineWidth: (v) => set({ autocrineLineWidth: v }),

  // Selected edge (for info panel): "SendingCell|ReceivingCell" string or null
  selectedEdge: null,
  setSelectedEdge: (edge) => set({ selectedEdge: edge }),

  // ── LRM mechanism filter ───────────────────────────────────────────────────
  // hiddenLrms: Set of "ligand|receptor" string IDs to suppress.
  // lrmCatalogue: [{lrm_id, lrm, ligand, receptor}] loaded once from the backend.
  hiddenLrms: new Set(),
  lrmCatalogue: [],
  setLrmCatalogue: (cat) => set({ lrmCatalogue: cat }),
  toggleLrm: (lrm) =>
    set((s) => {
      const next = new Set(s.hiddenLrms);
      if (next.has(lrm)) next.delete(lrm); else next.add(lrm);
      return { hiddenLrms: next };
    }),
  setAllLrmsVisible: () => set({ hiddenLrms: new Set() }),
  hideAllLrms: () =>
    set((s) => ({ hiddenLrms: new Set(s.lrmCatalogue.map((e) => e.lrm ?? `${e.ligand}|${e.receptor}`)) })),
  setLayerProp: (id, prop, value) =>
    set((s) => ({
      layers: { ...s.layers, [id]: { ...s.layers[id], [prop]: value } },
    })),

  // ── Cell color ────────────────────────────────────────────────────────────
  // cellColorEnabled: drives the color-by layer on/off
  // colorBy.mode: 'off' | 'gene_set' | 'metadata'
  // colorBy.field: metadata column name (only used in metadata mode)
  // cellColorPalette: palette for continuous metadata (viridis/plasma/magma/inferno)
  cellColorEnabled: false,
  setCellColorEnabled: (v) => set({ cellColorEnabled: v }),
  colorBy: { mode: "off", field: null },
  setColorBy: (mode, field) => set({ colorBy: { mode, field } }),
  cellColorPalette: "viridis",
  setCellColorPalette: (p) => set({ cellColorPalette: p }),

  // allGenes: full gene panel, fetched once on dataset change
  allGenes: [],
  setAllGenes: (genes) => set({ allGenes: genes }),

  // ── Selected cell ─────────────────────────────────────────────────────────
  selectedCell: null,
  setSelectedCell: (cell) => set({ selectedCell: cell }),

  // ── Annotations ───────────────────────────────────────────────────────────
  // pixelSize: µm per image pixel, fetched from /spatial/{dataset}/info
  pixelSize: 1.0,
  setPixelSize: (v) => set({ pixelSize: v }),

  // annotationMode: current interaction mode
  annotationMode: "pan", // "pan" | "region" | "measure"
  setAnnotationMode: (mode) => set({ annotationMode: mode }),

  // activeRegion: vertices of the polygon currently being drawn (image px)
  activeRegion: [],
  addRegionPoint: (pt) => set((s) => ({ activeRegion: [...s.activeRegion, pt] })),
  cancelActiveRegion: () => set({ activeRegion: [] }),

  // regions: completed annotation polygons
  // each: { id, points [[x,y],...], selectedCellIds [str,...], color [r,g,b] }
  regions: [],
  commitRegion: (region) =>
    set((s) => ({ regions: [...s.regions, region], activeRegion: [] })),
  removeRegion: (id) =>
    set((s) => ({ regions: s.regions.filter((r) => r.id !== id) })),

  // measurements: [{id, p1:[x,y], p2:[x,y], distPx}]
  measurements: [],
  addMeasurement: (m) => set((s) => ({ measurements: [...s.measurements, m] })),
  removeMeasurement: (id) =>
    set((s) => ({ measurements: s.measurements.filter((m) => m.id !== id) })),

  clearAnnotations: () =>
    set({ activeRegion: [], regions: [], measurements: [] }),

  // ── Transcript species filter ──────────────────────────────────────────────
  // selectedGenes: null = no filter (show all); Set<string> = allowlist (show only these).
  // The selection is dataset-scoped and persists across pan/zoom.
  selectedGenes: null,
  setSelectedGenes: (genes) => set({ selectedGenes: genes }),
  toggleSelectedGene: (gene) =>
    set((s) => {
      if (s.selectedGenes === null) {
        // First selection from "show all" state: start an allowlist with just this gene.
        return { selectedGenes: new Set([gene]) };
      }
      const next = new Set(s.selectedGenes);
      if (next.has(gene)) next.delete(gene); else next.add(gene);
      return { selectedGenes: next };
    }),
}));
