/**
 * Main viewer component.
 * OpenSeadragon handles pan/zoom of the morphology tile pyramid.
 * A deck.gl OrthographicView canvas sits on top, coordinate-synced to OSD,
 * rendering all data layers (transcripts, cell segments, edges).
 *
 * Coordinate systems:
 *   Image pixel space   — what all data uses (x: 0–img_w, y: 0–img_h)
 *   OSD normalised      — [0,1]² image space (x / img_w, y / img_h)
 *   deck.gl             — OrthographicView in image pixel space
 *   Screen              — display pixels (handled by deck.gl internally)
 *
 * Click picking: OSD receives all pointer events (pan/zoom). After each click
 * we call deck.pickObject() on the pickable cell-fill layer to detect cell hits.
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import OpenSeadragon from "openseadragon";
import DeckGL from "@deck.gl/react";
import { OrthographicView } from "@deck.gl/core";
import { ScatterplotLayer, SolidPolygonLayer, PathLayer, LineLayer } from "@deck.gl/layers";

import { useStore } from "../store";
import { useTranscripts } from "../hooks/useTranscripts";
import { useCellBoundaries } from "../hooks/useCellBoundaries";
import { useCellColors } from "../hooks/useCellColors";
import { useEdges } from "../hooks/useEdges";
import { useEdgeColors } from "../hooks/useEdgeColors";
import { geneColor } from "../utils/geneColor";
import AnnotationToolbar from "./AnnotationToolbar";
import EdgeInfoPanel from "./EdgeInfoPanel";

// Default edge color when no color mode is active
const DEFAULT_EDGE_COLOR = [255, 150, 0, 160];
const DEFAULT_AUTOCRINE_COLOR = [255, 150, 0, 200];

const VIEW_ID = "main";

export default function Viewer() {
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const deckRef = useRef(null);
  const syncRef = useRef(null);           // always points to latest syncDeckFromOSD
  const deckViewStateRef = useRef(null);  // latest deckViewState for event handlers
  const measureFirstRef = useRef(null);   // first point of an in-progress measurement
  const clickTimerRef = useRef(null);     // debounce single-click vs double-click
  const cellPolygonsRef = useRef([]);     // latest cell polygons for point-in-polygon tests
  const [cursorPos, setCursorPos] = useState(null); // image-px cursor while drawing

  const {
    apiBase, dataset, activeImage,
    imageSize, setImageSize,
    setViewport,
    layers: layerState,
    platformCapabilities, setPlatformCapabilities,
    cellColorEnabled, colorBy, cellColorPalette,
    allGenes, selectedGenes,
    selectedCell, setSelectedCell,
    edgeMinStrength, edgeDensity,
    edgeColorBy, edgeColorPalette, edgeDirectional, showAutocrine,
    edgeWidth, showArrowheads, arrowStyle, arrowheadScale,
    edgeOffset,
    autocrineRadius, autocrineLineWidth,
    hiddenLrms, lrmCatalogue,
    selectedEdge, setSelectedEdge,
    setCellColorRange, setEdgeColorRange,
    cellColorClamp, edgeColorClamp, setEdgeColorClamp,
    annotationMode,
    pixelSize, setPixelSize,
    activeRegion, addRegionPoint, cancelActiveRegion, commitRegion,
    regions, removeRegion,
    measurements, addMeasurement,
    clearAnnotations,
  } = useStore();

  // ── deck.gl view state (synced from OSD) ─────────────────────────────────
  const [deckViewState, setDeckViewState] = useState({
    target: [0, 0, 0],
    zoom: 0,
    minZoom: -10,
    maxZoom: 20,
  });

  // ── Compute OSD → deck.gl view state ─────────────────────────────────────
  // Keep syncRef current so OSD's stale animation handlers always call the
  // latest version (avoids stale closure when imageSize populates after open).
  const syncDeckFromOSD = useCallback(
    (osd) => {
      const imgW = imageSize.w;
      const imgH = imageSize.h;
      if (!imgW || !imgH || !containerRef.current) return;

      const bounds = osd.viewport.getBoundsNoRotate();
      const cW = containerRef.current.offsetWidth;

      // OSD uses square normalisation: 1 unit = imgW pixels on both axes.
      const cx = (bounds.x + bounds.width / 2) * imgW;
      const cy = (bounds.y + bounds.height / 2) * imgW;
      const zoom = Math.log2(cW / (bounds.width * imgW));

      setDeckViewState((prev) => ({ ...prev, target: [cx, cy, 0], zoom }));

      setViewport({
        xmin: bounds.x * imgW,
        ymin: bounds.y * imgW,
        xmax: (bounds.x + bounds.width) * imgW,
        ymax: (bounds.y + bounds.height) * imgW,
      });
    },
    [imageSize, setViewport]
  );
  useEffect(() => { syncRef.current = syncDeckFromOSD; }, [syncDeckFromOSD]);
  useEffect(() => { deckViewStateRef.current = deckViewState; }, [deckViewState]);

  // Fetch platform info + capabilities once per dataset
  useEffect(() => {
    if (!dataset) return;
    fetch(`${apiBase}/spatial/${dataset}/info`)
      .then((r) => r.ok ? r.json() : null)
      .then((info) => {
        if (!info) return;
        if (info.pixel_size) setPixelSize(parseFloat(info.pixel_size));
        if (info.capabilities) setPlatformCapabilities(info.capabilities);
      })
      .catch(() => {});
  }, [apiBase, dataset, setPixelSize, setPlatformCapabilities]);

  // ── OpenSeadragon init ────────────────────────────────────────────────────
  const dziUrl = `${apiBase}/tiles/${dataset}/dzi/${activeImage}.dzi`;

  useEffect(() => {
    if (!containerRef.current) return;
    if (viewerRef.current) {
      viewerRef.current.destroy();
      viewerRef.current = null;
    }

    const viewer = OpenSeadragon({
      element: containerRef.current,
      tileSources: dziUrl,
      prefixUrl: "",
      showNavigationControl: true,
      showNavigator: true,
      navigatorPosition: "BOTTOM_RIGHT",
      navigatorSizeRatio: 0.18,
      imageLoaderLimit: 8,
      maxZoomPixelRatio: 4,
      minZoomImageRatio: 0.5,
      defaultZoomLevel: 0,
      visibilityRatio: 0.3,
      immediateRender: false,
      smoothTileEdgesMinZoom: Infinity,
      placeholderFillStyle: "#1a1a1a",
      gestureSettingsMouse: {
        scrollToZoom: true,
        clickToZoom: false,
        dblClickToZoom: true,
        pinchToZoom: true,
      },
    });

    viewer.addHandler("open", () => {
      const src = viewer.world.getItemAt(0);
      if (src) {
        const sz = src.getContentSize();
        setImageSize(sz.x, sz.y);
      }
    });

    viewer.addHandler("open-failed", (e) =>
      console.error("OSD open failed:", e.message)
    );

    viewer.addHandler("animation", () => syncRef.current?.(viewer));
    viewer.addHandler("animation-finish", () => syncRef.current?.(viewer));

    viewerRef.current = viewer;
    if (import.meta.env.DEV) window.__osd = viewer;
    return () => {
      viewer.destroy();
      viewerRef.current = null;
      if (import.meta.env.DEV) window.__osd = null;
    };
  }, [dziUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-sync when imageSize is populated after open
  useEffect(() => {
    if (viewerRef.current && imageSize.w) {
      syncDeckFromOSD(viewerRef.current);
    }
  }, [imageSize, syncDeckFromOSD]);

  // ── Sync morphology layer visibility/opacity to OSD ──────────────────────
  const morphologyVisible = layerState.morphology?.visible ?? true;
  const morphologyOpacity = layerState.morphology?.opacity ?? 1.0;
  useEffect(() => {
    const item = viewerRef.current?.world?.getItemAt(0);
    if (!item) return;
    item.setOpacity(morphologyVisible ? morphologyOpacity : 0);
    // OSD's navigator syncs item opacity via matchOpacity (synchronous, fires inside
    // setOpacity above). Override it immediately so the navigator always shows a faint
    // morphology for spatial orientation regardless of the main-view toggle.
    const navItem = viewerRef.current?.navigator?.world?.getItemAt(0);
    if (navItem) navItem.setOpacity(0.35);
  }, [morphologyVisible, morphologyOpacity, imageSize.w]); // imageSize.w re-fires on tile open

  // ── Screenshot ───────────────────────────────────────────────────────────
  const handleScreenshot = useCallback(() => {
    const osdCanvas = viewerRef.current?.drawer?.canvas;
    const deckCanvas = deckRef.current?.deck?.canvas;
    if (!osdCanvas) return;
    const w = osdCanvas.width;
    const h = osdCanvas.height;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    ctx.drawImage(osdCanvas, 0, 0);
    if (deckCanvas) ctx.drawImage(deckCanvas, 0, 0);
    const link = document.createElement("a");
    link.download = `tissueplex_${Date.now()}.png`;
    link.href = out.toDataURL("image/png");
    link.click();
  }, []);

  // ── Cell click picking ────────────────────────────────────────────────────
  // OSD captures all pointer events; after each click we also query deck.gl.
  // We only set the cell if a drag did NOT occur (OSD fires a canvas-click
  // event with isClick=true for genuine taps).
  // Shift+click: edge-priority mode — skips cell pick and selects edges first.
  const handleViewerClick = useCallback((e) => {
    if (!deckRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (e.shiftKey) {
      // Edge-priority: try directed edges first, then tissue graph, fall through to cells
      const edgeInfo = deckRef.current.pickObject({ x, y, radius: 8, layerIds: ["edges-directed", "edges-autocrine", "tissue-graph"] });
      if (edgeInfo?.object) {
        setSelectedEdge(edgeInfo.object.edge);
        setSelectedCell(null);
        return;
      }
      const cellInfo = deckRef.current.pickObject({ x, y, radius: 6, layerIds: ["cell-segments-fill"] });
      if (cellInfo?.object) {
        setSelectedCell(cellInfo.object);
        setSelectedEdge(null);
      } else {
        setSelectedCell(null);
        setSelectedEdge(null);
      }
      return;
    }

    // Default: cell-priority
    const cellInfo = deckRef.current.pickObject({ x, y, radius: 6, layerIds: ["cell-segments-fill"] });
    if (cellInfo?.object) {
      setSelectedCell(cellInfo.object);
      setSelectedEdge(null);
      return;
    }
    setSelectedCell(null);

    // Edge pick — try directed lines, autocrine rings, then tissue graph
    const edgeInfo = deckRef.current.pickObject({ x, y, radius: 8, layerIds: ["edges-directed", "edges-autocrine", "tissue-graph"] });
    if (edgeInfo?.object) {
      setSelectedEdge(edgeInfo.object.edge);
    } else {
      setSelectedEdge(null);
    }
  }, [setSelectedCell, setSelectedEdge]);

  // ── Screen ↔ image-pixel coordinate conversion ───────────────────────────
  const screenToData = useCallback((sx, sy) => {
    const vs = deckViewStateRef.current;
    if (!vs || !containerRef.current) return null;
    const { width: cW, height: cH } = containerRef.current.getBoundingClientRect();
    const scale = Math.pow(2, vs.zoom);
    return [
      vs.target[0] + (sx - cW / 2) / scale,
      vs.target[1] + (sy - cH / 2) / scale,
    ];
  }, []);

  // ── Annotation overlay events ─────────────────────────────────────────────
  const handleOverlayMouseMove = useCallback((e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const pt = screenToData(e.clientX - rect.left, e.clientY - rect.top);
    setCursorPos(pt);
  }, [screenToData]);

  const handleOverlayMouseLeave = useCallback(() => setCursorPos(null), []);

  const handleOverlaySingleClick = useCallback((sx, sy) => {
    const pt = screenToData(sx, sy);
    if (!pt) return;
    if (annotationMode === "region") {
      addRegionPoint(pt);
    } else if (annotationMode === "measure") {
      if (!measureFirstRef.current) {
        measureFirstRef.current = pt;
      } else {
        const p1 = measureFirstRef.current;
        const p2 = pt;
        const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
        const distPx = Math.sqrt(dx * dx + dy * dy);
        addMeasurement({ id: Date.now(), p1, p2, distPx });
        measureFirstRef.current = null;
      }
    }
  }, [annotationMode, addRegionPoint, addMeasurement, screenToData]);

  const handleOverlayClick = useCallback((e) => {
    if (annotationMode === "pan") return;
    const rect = containerRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    clearTimeout(clickTimerRef.current);
    // Delay to let double-click cancel this
    clickTimerRef.current = setTimeout(() => handleOverlaySingleClick(sx, sy), 220);
  }, [annotationMode, handleOverlaySingleClick]);

  const handleOverlayDblClick = useCallback((e) => {
    if (annotationMode !== "region") return;
    clearTimeout(clickTimerRef.current);
    if (activeRegion.length < 3) {
      cancelActiveRegion();
      return;
    }
    // Find cells whose centroids fall inside the polygon (ray-casting)
    const poly = activeRegion;
    const selectedCellIds = cellPolygonsRef.current
      .filter((cell) => {
        const [px, py] = cell.polygon[0]; // use first vertex as centroid proxy
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [xi, yi] = poly[i], [xj, yj] = poly[j];
          if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
          }
        }
        return inside;
      })
      .map((c) => c.cell_id);

    const PALETTE = [
      [255, 200, 0], [0, 200, 255], [255, 80, 200],
      [80, 255, 120], [255, 120, 60], [180, 100, 255],
    ];
    const color = PALETTE[regions.length % PALETTE.length];
    commitRegion({ id: Date.now(), points: poly, selectedCellIds, color });
  }, [annotationMode, activeRegion, cancelActiveRegion, commitRegion, regions]);

  // ── Transcript / cell-segment data ───────────────────────────────────────
  const viewport = useStore((s) => s.viewport);
  const transcriptsVisible = layerState.transcripts?.visible ?? true;
  const transcriptsOpacity = layerState.transcripts?.opacity ?? 0.8;
  const cellSegmentsVisible = layerState.cellSegments?.visible ?? true;
  const cellSegmentsOpacity = layerState.cellSegments?.opacity ?? 0.6;
  const cellOutlineOpacity = layerState.cellSegments?.outlineOpacity ?? 0.8;

  const edgesVisible = layerState.edges?.visible ?? true;
  const edgesOpacity = layerState.edges?.opacity ?? 0.9;
  const tissueGraphVisible = layerState.tissueGraph?.visible ?? true;
  const tissueGraphOpacity = layerState.tissueGraph?.opacity ?? 0.25;

  // Capability flags — default to true while loading so layers are shown for
  // platforms that support them (Xenium, MERSCOPE, CosMx).
  const hasTranscripts = platformCapabilities?.has_transcripts ?? true;
  const hasBoundaries = platformCapabilities?.has_boundaries ?? true;

  const { transcripts } = useTranscripts(
    apiBase, dataset, viewport, imageSize, transcriptsVisible && hasTranscripts
  );
  const { cells: cellPolygons } = useCellBoundaries(
    apiBase, dataset, viewport, imageSize, cellSegmentsVisible && hasBoundaries
  );
  // Keep ref in sync for annotation point-in-polygon tests (avoids stale closures)
  useEffect(() => { cellPolygonsRef.current = cellPolygons; }, [cellPolygons]);

  const { edges } = useEdges(
    apiBase, dataset, viewport, imageSize, edgesVisible || tissueGraphVisible, edgeMinStrength, hiddenLrms, edgeDensity
  );

  // Apply per-gene visibility filter (null = no filter, show all)
  const visibleTranscripts = selectedGenes === null
    ? transcripts
    : transcripts.filter((t) => selectedGenes.has(t.feature_name));

  const { colorValues, vmin: cellVmin, vmax: cellVmax } = useCellColors(
    apiBase, dataset, colorBy, allGenes, selectedGenes, cellColorPalette, cellColorEnabled, cellColorClamp
  );
  useEffect(() => { setCellColorRange(cellVmin, cellVmax); }, [cellVmin, cellVmax]); // eslint-disable-line

  // ── Edge colors from backend ──────────────────────────────────────────────
  const edgeColorEnabled = edgeColorBy.mode !== "default";
  const { colorValues: edgeColorValues, vmin: edgeVmin, vmax: edgeVmax, p95: edgeP95 } = useEdgeColors(
    apiBase, dataset, edgeColorBy, hiddenLrms, lrmCatalogue, edgeColorPalette, edgeColorEnabled, edgeColorClamp, edges
  );
  useEffect(() => { setEdgeColorRange(edgeVmin, edgeVmax); }, [edgeVmin, edgeVmax]); // eslint-disable-line
  // Auto-calibrate hi clamp to 95th percentile whenever lrm_set data arrives
  useEffect(() => {
    if (edgeColorBy?.mode === "lrm_set" && edgeP95 != null) {
      setEdgeColorClamp(edgeColorClamp?.low ?? null, edgeP95);
    }
  }, [edgeP95]); // eslint-disable-line

  // Clear selected edge when dataset changes
  useEffect(() => { setSelectedEdge(null); }, [dataset]); // eslint-disable-line

  // ── deck.gl layers ────────────────────────────────────────────────────────
  const selectedId = selectedCell?.cell_id ?? null;

  // Build a fast lookup: cell_id → region color (for region-selected cells)
  const regionCellColors = useMemo(() => {
    const map = new Map();
    for (const region of regions) {
      for (const cid of region.selectedCellIds) {
        map.set(cid, region.color);
      }
    }
    return map;
  }, [regions]);

  // Resolve per-cell fill color: selected → yellow, region → region color, colorBy → mapped
  const getCellFillColor = (d) => {
    if (d.cell_id === selectedId) return [255, 220, 0, 80];
    const rc = regionCellColors.get(d.cell_id);
    if (rc) return [...rc, 120];
    if (colorValues) {
      const c = colorValues.get(d.cell_id);
      if (c) return [c[0], c[1], c[2], 180];
      return [20, 11, 53, 120]; // dark purple for zero-expression cells
    }
    return [100, 200, 255, 25];
  };

  const cellFillLayer = new SolidPolygonLayer({
    id: "cell-segments-fill",
    data: cellPolygons,
    visible: cellSegmentsVisible,
    opacity: cellSegmentsOpacity,
    getPolygon: (d) => d.polygon,
    filled: true,
    getFillColor: getCellFillColor,
    extruded: false,
    pickable: true,
    autoHighlight: false,
    updateTriggers: { getFillColor: [selectedId, colorValues, regionCellColors, cellColorEnabled] },
  });

  // Outline layer — selected cell gets a brighter yellow ring
  const cellOutlineLayer = new PathLayer({
    id: "cell-segments-outline",
    data: cellPolygons,
    visible: cellSegmentsVisible,
    opacity: cellOutlineOpacity,
    getPath: (d) => [...d.polygon, d.polygon[0]],
    getColor: (d) =>
      d.cell_id === selectedId ? [255, 220, 0, 255] : [100, 200, 255, 200],
    getWidth: (d) => (d.cell_id === selectedId ? 5 : 3),
    widthMinPixels: 1,
    widthMaxPixels: 6,
    pickable: false,
    jointRounded: true,
    capRounded: true,
    updateTriggers: { getColor: [selectedId], getWidth: [selectedId] },
  });

  const transcriptLayer = new ScatterplotLayer({
    id: "transcripts",
    data: visibleTranscripts,
    visible: transcriptsVisible,
    opacity: transcriptsOpacity,
    getPosition: (d) => [d.x_location, d.y_location],
    getRadius: 4,
    radiusMinPixels: 1,
    radiusMaxPixels: 8,
    getFillColor: (d) => geneColor(d.feature_name),
    pickable: false,
    updateTriggers: { getFillColor: [] },
  });

  // ── Tissue graph: unique undirected cell pairs (backend already returns 1 row/edge)
  const allDirectedEdges = useMemo(() => {
    const seenPairs = new Set();
    const result = [];
    for (const row of edges) {
      if (row.is_autocrine) continue;
      const pair = [row.sending_cell, row.receiving_cell].sort().join("\0");
      if (!seenPairs.has(pair)) {
        seenPairs.add(pair);
        result.push(row);
      }
    }
    return result;
  }, [edges]);

  // ── Backend already groups by edge; just split autocrine vs directed ──────
  const { directedEdges, autocrineCells } = useMemo(() => ({
    directedEdges: edges.filter((r) => !r.is_autocrine && (r.visible_lrm_count ?? r.lrm_count ?? 0) > 0),
    autocrineCells: edges
      .filter((r) => r.is_autocrine)
      .map((r) => ({ ...r, x: r.x1, y: r.y1 })),
  }), [edges]);

  // ── Perpendicular offset: shift A→B left so it doesn't overlap B→A ──────
  const directedEdgesWithOffset = useMemo(() => {
    if (!edgeDirectional) return directedEdges;
    return directedEdges.map((f) => {
      const dx = f.x2 - f.x1, dy = f.y2 - f.y1;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const px = (-dy / len) * edgeOffset;
      const py = (dx / len) * edgeOffset;
      return { ...f, sx: f.x1 + px, sy: f.y1 + py, tx: f.x2 + px, ty: f.y2 + py };
    });
  }, [directedEdges, edgeDirectional, edgeOffset]);

  const getDirectedEdgeColor = useCallback((d) => {
    if (edgeColorValues) {
      const c = edgeColorValues.get(d.edge);
      if (c) return [c[0], c[1], c[2], 200];
    }
    return d.edge === selectedEdge ? [255, 255, 100, 255] : DEFAULT_EDGE_COLOR;
  }, [edgeColorValues, selectedEdge]);

  const getAutocrineCellColor = useCallback((d) => {
    if (edgeColorValues) {
      const c = edgeColorValues.get(d.edge);
      if (c) return [c[0], c[1], c[2], 220];
    }
    return d.edge === selectedEdge ? [255, 255, 100, 255] : DEFAULT_AUTOCRINE_COLOR;
  }, [edgeColorValues, selectedEdge]);

  // ── Arrowhead triangles (filled SolidPolygonLayer) ───────────────────────
  // full:  chevron triangle — tip + left base + right base
  // half:  harpoon triangle — tip + outer (left) base + center-back
  //        both A→B and B→A are offset to their own LEFT, so "outer" = left barb only
  const arrowheadTriangles = useMemo(() => {
    if (!showArrowheads || !edgeDirectional) return [];
    const arrowLen = Math.max(4, edgeWidth * 4 * arrowheadScale);
    const cos150 = Math.cos((5 * Math.PI) / 6); // ≈ -0.866
    const sin150 = Math.sin((5 * Math.PI) / 6); // 0.5
    return directedEdgesWithOffset.map((f) => {
      const dx = f.tx - f.sx, dy = f.ty - f.sy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / len, uy = dy / len;
      // Rotate fwd by +150° (CCW) → outer/left barb
      const lx = ux * cos150 - uy * sin150, ly = ux * sin150 + uy * cos150;
      const tip = [f.tx, f.ty];
      const outerBase = [f.tx + lx * arrowLen, f.ty + ly * arrowLen];
      if (arrowStyle === "half") {
        // Harpoon: tip + outer barb + center-back point
        const backBase = [f.tx - ux * arrowLen, f.ty - uy * arrowLen];
        return { polygon: [tip, outerBase, backBase], edge: f.edge };
      }
      // Full chevron: tip + left base + right base
      // Rotate fwd by -150° (CW) → inner/right barb
      const rx = ux * cos150 + uy * sin150, ry = -ux * sin150 + uy * cos150;
      const innerBase = [f.tx + rx * arrowLen, f.ty + ry * arrowLen];
      return { polygon: [tip, outerBase, innerBase], edge: f.edge };
    });
  }, [directedEdgesWithOffset, showArrowheads, edgeDirectional, edgeWidth, arrowheadScale, arrowStyle]);

  // ── Tissue graph (structural background, LRM-agnostic) ──────────────────
  const tissueGraphLayer = new LineLayer({
    id: "tissue-graph",
    data: allDirectedEdges,
    visible: tissueGraphVisible,
    opacity: tissueGraphOpacity,
    getSourcePosition: (d) => [d.x1, d.y1],
    getTargetPosition: (d) => [d.x2, d.y2],
    getColor: [180, 180, 180, 255],
    getWidth: edgeWidth,
    widthMinPixels: 0.5,
    widthMaxPixels: 5,
    pickable: true,
  });

  const edgeDirectedLayer = new LineLayer({
    id: "edges-directed",
    data: directedEdgesWithOffset,
    visible: edgesVisible,
    opacity: edgesOpacity,
    getSourcePosition: (d) => edgeDirectional ? [d.sx, d.sy] : [d.x1, d.y1],
    getTargetPosition: (d) => edgeDirectional ? [d.tx, d.ty] : [d.x2, d.y2],
    getColor: getDirectedEdgeColor,
    getWidth: edgeWidth,
    widthMinPixels: 1,
    widthMaxPixels: 8,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 100, 255],
    updateTriggers: {
      getColor: [edgeColorValues, selectedEdge],
      getSourcePosition: [edgeDirectional],
      getTargetPosition: [edgeDirectional],
    },
  });

  const edgeArrowheadLayer = new SolidPolygonLayer({
    id: "edges-arrowheads",
    data: arrowheadTriangles,
    visible: edgesVisible && showArrowheads && edgeDirectional,
    opacity: edgesOpacity,
    getPolygon: (d) => d.polygon,
    filled: true,
    extruded: false,
    getFillColor: (d) => {
      if (edgeColorValues) {
        const c = edgeColorValues.get(d.edge);
        if (c) return [c[0], c[1], c[2], 220];
      }
      return d.edge === selectedEdge ? [255, 255, 100, 255] : DEFAULT_EDGE_COLOR;
    },
    pickable: false,
    updateTriggers: { getFillColor: [edgeColorValues, selectedEdge] },
  });

  const edgeAutocrineLayer = new ScatterplotLayer({
    id: "edges-autocrine",
    data: autocrineCells,
    visible: edgesVisible && showAutocrine,
    opacity: edgesOpacity,
    getPosition: (d) => [d.x, d.y],
    getRadius: autocrineRadius,
    radiusMinPixels: 5,
    radiusMaxPixels: 60,
    filled: false,
    stroked: true,
    getLineColor: getAutocrineCellColor,
    getLineWidth: autocrineLineWidth,
    lineWidthMinPixels: 1,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 100, 255],
    updateTriggers: { getLineColor: [edgeColorValues, selectedEdge] },
  });

  // ── Annotation layers ─────────────────────────────────────────────────────
  // Completed region fills
  const regionFillLayers = regions.map((r) =>
    new SolidPolygonLayer({
      id: `region-fill-${r.id}`,
      data: [r],
      getPolygon: (d) => d.points,
      getFillColor: [...r.color, 40],
      filled: true,
      extruded: false,
      pickable: false,
    })
  );
  // Completed region outlines
  const regionOutlineLayers = regions.map((r) =>
    new PathLayer({
      id: `region-outline-${r.id}`,
      data: [[...r.points, r.points[0]]],
      getPath: (d) => d,
      getColor: [...r.color, 220],
      getWidth: 2,
      widthMinPixels: 1.5,
      pickable: false,
    })
  );
  // Active region being drawn (preview path + cursor line)
  const activePts = cursorPos && activeRegion.length > 0
    ? [...activeRegion, cursorPos]
    : activeRegion;
  const activeRegionLayer = new PathLayer({
    id: "active-region",
    data: activePts.length > 1 ? [activePts] : [],
    getPath: (d) => d,
    getColor: [255, 255, 255, 200],
    getWidth: 2,
    widthMinPixels: 1.5,
    pickable: false,
    getDashArray: [6, 4],
    extensions: [],
  });
  const activeVertexLayer = new ScatterplotLayer({
    id: "active-vertices",
    data: activeRegion,
    getPosition: (d) => d,
    getRadius: 4,
    radiusMinPixels: 4,
    getFillColor: [255, 255, 255, 220],
    pickable: false,
  });
  // Measurement layers
  const measureLineLayer = new LineLayer({
    id: "measure-lines",
    data: measurements,
    getSourcePosition: (d) => d.p1,
    getTargetPosition: (d) => d.p2,
    getColor: [255, 220, 60, 220],
    getWidth: 2,
    widthMinPixels: 1.5,
    pickable: false,
  });
  const measureEndpointLayer = new ScatterplotLayer({
    id: "measure-endpoints",
    data: measurements.flatMap((m) => [m.p1, m.p2]),
    getPosition: (d) => d,
    getRadius: 5,
    radiusMinPixels: 5,
    getFillColor: [255, 220, 60, 220],
    pickable: false,
  });
  // In-progress measurement: first point waiting for second click
  const measureFirstLayer = new ScatterplotLayer({
    id: "measure-first",
    data: measureFirstRef.current ? [measureFirstRef.current] : [],
    getPosition: (d) => d,
    getRadius: 5,
    radiusMinPixels: 5,
    getFillColor: [255, 220, 60, 180],
    pickable: false,
  });

  const deckLayers = [
    cellFillLayer, cellOutlineLayer, transcriptLayer,
    tissueGraphLayer, edgeDirectedLayer, edgeArrowheadLayer, edgeAutocrineLayer,
    ...regionFillLayers, ...regionOutlineLayers,
    activeRegionLayer, activeVertexLayer,
    measureLineLayer, measureEndpointLayer, measureFirstLayer,
  ];

  // ── Measurement label positions (screen coords) ───────────────────────────
  const measureLabels = measurements.map((m) => {
    const vs = deckViewStateRef.current;
    if (!vs || !containerRef.current) return null;
    const { width: cW, height: cH } = containerRef.current.getBoundingClientRect();
    const scale = Math.pow(2, vs.zoom);
    const mx = (m.p1[0] + m.p2[0]) / 2;
    const my = (m.p1[1] + m.p2[1]) / 2;
    const sx = (mx - vs.target[0]) * scale + cW / 2;
    const sy = (my - vs.target[1]) * scale + cH / 2;
    const distUm = m.distPx * pixelSize;
    return { id: m.id, sx, sy, label: `${distUm.toFixed(1)} µm` };
  }).filter(Boolean);

  // ── Render ────────────────────────────────────────────────────────────────
  if (!dataset) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
                    width: "100%", height: "100%", color: "#555", fontFamily: "monospace", fontSize: 13 }}>
        Loading datasets…
      </div>
    );
  }

  const inAnnotationMode = annotationMode !== "pan";
  const cursor = annotationMode === "region" ? "crosshair"
    : annotationMode === "measure" ? "cell" : "default";

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "#1a1a1a" }}>
      {/* OpenSeadragon tile canvas */}
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%" }}
        onClick={inAnnotationMode ? undefined : handleViewerClick}
      />

      {/* deck.gl overlay — pointerEvents:none so OSD handles pan/zoom */}
      <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        {imageSize.w && (
          <DeckGL
            ref={deckRef}
            views={new OrthographicView({ id: VIEW_ID, flipY: true })}
            viewState={{ ...deckViewState, id: VIEW_ID }}
            controller={false}
            layers={deckLayers}
            style={{ position: "absolute", top: 0, left: 0 }}
            glOptions={{ preserveDrawingBuffer: true }}
          />
        )}
      </div>

      {/* Annotation event capture overlay — active only in draw/measure modes */}
      {inAnnotationMode && (
        <div
          style={{
            position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
            cursor, pointerEvents: "all",
          }}
          onClick={handleOverlayClick}
          onDoubleClick={handleOverlayDblClick}
          onMouseMove={handleOverlayMouseMove}
          onMouseLeave={handleOverlayMouseLeave}
        />
      )}

      {/* Measurement distance labels */}
      {measureLabels.map(({ id, sx, sy, label }) => (
        <div
          key={id}
          style={{
            position: "absolute",
            left: sx, top: sy,
            transform: "translate(-50%, -120%)",
            background: "rgba(0,0,0,0.7)",
            color: "#ffdc3c",
            fontFamily: "monospace", fontSize: 11,
            padding: "2px 5px", borderRadius: 3,
            pointerEvents: "none", whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      ))}

      {/* Annotation toolbar */}
      <AnnotationToolbar onScreenshot={handleScreenshot} />

      {/* Edge info panel — appears on edge click */}
      {selectedEdge && (
        <EdgeInfoPanel
          apiBase={apiBase}
          dataset={dataset}
          edgeId={selectedEdge}
          onClose={() => setSelectedEdge(null)}
        />
      )}

      {/* Dataset / transcript count label */}
      <div
        style={{
          position: "absolute", top: 8, left: 8,
          color: "#aaa", fontFamily: "monospace", fontSize: 11,
          background: "rgba(0,0,0,0.55)", padding: "2px 6px", borderRadius: 3,
          pointerEvents: "none",
        }}
      >
        {dataset} / {activeImage}
        {transcripts.length > 0 && (
          <span style={{ marginLeft: 8, color: "#777" }}>
            {transcripts.length} transcripts
          </span>
        )}
      </div>
    </div>
  );
}
