/**
 * PNG post-processing helpers for figure export.
 *
 * A canvas produces a PNG with no physical-resolution metadata, so a file that
 * is 3500 px wide reports no DPI at all. Journals routinely run an automated
 * "is this >= 300/500 DPI" check against that metadata, so a figure that is
 * genuinely high enough resolution can still be rejected. `withPngDpi` writes
 * the pHYs chunk that carries it.
 *
 * The pixel data is untouched — this only changes how a reader interprets the
 * intended print size.
 */

// ── CRC32 (PNG flavour) ─────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readU32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function writeU32(b, o, v) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

function chunkType(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/** Build a complete pHYs chunk (length + type + data + crc) for a given DPI. */
function buildPhysChunk(dpi) {
  // PNG stores pixels per metre; 1 inch = 0.0254 m.
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  writeU32(chunk, 0, 9); // data length
  chunk[4] = 0x70; // 'p'
  chunk[5] = 0x48; // 'H'
  chunk[6] = 0x59; // 'Y'
  chunk[7] = 0x73; // 's'
  writeU32(chunk, 8, ppm);  // x axis
  writeU32(chunk, 12, ppm); // y axis
  chunk[16] = 1;            // unit specifier: 1 = metre
  writeU32(chunk, 17, crc32(chunk.subarray(4, 17)));
  return chunk;
}

/**
 * Return a copy of `blob` with its pHYs chunk set to `dpi`.
 *
 * Any existing pHYs is dropped and the new one is inserted immediately after
 * IHDR, which satisfies the spec's requirement that it precede IDAT. If the
 * input does not look like a PNG the original blob is returned unchanged —
 * losing the DPI tag is much better than handing back a corrupt image.
 */
export async function withPngDpi(blob, dpi) {
  if (!dpi || !isFinite(dpi) || dpi <= 0) return blob;
  try {
    const src = new Uint8Array(await blob.arrayBuffer());
    for (let i = 0; i < 8; i++) {
      if (src[i] !== PNG_SIG[i]) return blob;
    }

    const keep = []; // [start, end) ranges of chunks we retain
    let pos = 8;
    let ihdrEnd = -1;
    while (pos + 8 <= src.length) {
      const len = readU32(src, pos);
      const type = chunkType(src, pos + 4);
      const end = pos + 12 + len; // len + type + data + crc
      if (end > src.length) return blob; // truncated; leave it alone
      if (type === "IHDR") ihdrEnd = end;
      if (type !== "pHYs") keep.push([pos, end]);
      pos = end;
      if (type === "IEND") break;
    }
    if (ihdrEnd < 0) return blob;

    const phys = buildPhysChunk(dpi);
    const total = 8 + keep.reduce((n, [s, e]) => n + (e - s), 0) + phys.length;
    const out = new Uint8Array(total);
    out.set(src.subarray(0, 8), 0);
    let o = 8;
    let inserted = false;
    for (const [s, e] of keep) {
      out.set(src.subarray(s, e), o);
      o += e - s;
      if (!inserted && e === ihdrEnd) {
        out.set(phys, o);
        o += phys.length;
        inserted = true;
      }
    }
    return new Blob([out], { type: "image/png" });
  } catch {
    return blob; // never let metadata tagging cost the user their export
  }
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke late: some browsers abort the download if the URL dies immediately.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Snap a length to the nearest 1/2/5 x 10^n, so a scale bar reads as a round
 * number the way a reader expects rather than "137.4 µm".
 */
export function niceScaleBarUm(targetUm) {
  if (!(targetUm > 0) || !isFinite(targetUm)) return 1;
  const exp = Math.floor(Math.log10(targetUm));
  const base = Math.pow(10, exp);
  const mant = targetUm / base;
  const snapped = mant < 1.5 ? 1 : mant < 3.5 ? 2 : mant < 7.5 ? 5 : 10;
  return snapped * base;
}

/** Format a micron length for a scale-bar label, promoting to mm when large. */
export function formatScaleLabel(um) {
  if (um >= 1000) {
    const mm = um / 1000;
    return `${Number.isInteger(mm) ? mm : mm.toFixed(1)} mm`;
  }
  if (um >= 1) return `${Number.isInteger(um) ? um : um.toFixed(1)} µm`;
  return `${um.toFixed(2)} µm`;
}
