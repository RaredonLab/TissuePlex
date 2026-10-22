/**
 * The viewer's coordinate frame, when there is no image to take it from.
 *
 * Every data layer draws in image pixel space, and OpenSeadragon owns pan and
 * zoom over that space — so something has to be "the image": OSD needs a tile
 * source with a width and a height before deck.gl can be placed over it. That
 * something used to have to be a real morphology pyramid, which made every
 * layer depend on an image file existing *and* opening. A dataset without one,
 * or with one the tiler could not read, rendered nothing at all.
 *
 * `blankTileSource` is the replacement: an in-browser tile source of the right
 * size whose every tile is one uniform dark square. The backend reports the
 * size (`/spatial/{ds}/info` → `frame`, from the data extent); no pyramid is
 * built, no tile request leaves the browser, and the morphology layer becomes
 * what it should have been all along — one optional layer among the others.
 */

/** Sentinel `activeImage` for "no image: draw on the data frame". */
export const BLANK_IMAGE_NAME = "__blank__";

const TILE = 256;
// Dark enough that outlines and edges read against it, light enough to tell
// from the viewer background outside the frame.
const FILL = "#1a1a1a";

let blankTileUrl = null;

/** A 256×256 uniform tile as a data URL, made once per page. */
export function blankTile() {
  if (blankTileUrl) return blankTileUrl;
  if (typeof document === "undefined") return "";
  const c = document.createElement("canvas");
  c.width = TILE; c.height = TILE;
  const ctx = c.getContext("2d");
  ctx.fillStyle = FILL;
  ctx.fillRect(0, 0, TILE, TILE);
  blankTileUrl = c.toDataURL("image/png");
  return blankTileUrl;
}

/**
 * An OpenSeadragon tile-source description for a frame of `width` × `height`
 * image pixels. OSD treats a plain object with these fields as a custom tile
 * source and calls `getTileUrl` for every tile at every level; every answer is
 * the same square.
 */
export function blankTileSource(frame) {
  const width = Math.max(1, Math.round(frame?.width ?? 1));
  const height = Math.max(1, Math.round(frame?.height ?? 1));
  const url = blankTile();
  return {
    width,
    height,
    tileSize: TILE,
    tileOverlap: 0,
    minLevel: 0,
    maxLevel: Math.max(0, Math.ceil(Math.log2(Math.max(width, height)))),
    getTileUrl: () => url,
  };
}

/** True when a frame can be opened: positive finite width and height. */
export function frameUsable(frame) {
  return !!frame && Number.isFinite(frame.width) && Number.isFinite(frame.height)
    && frame.width > 0 && frame.height > 0;
}
