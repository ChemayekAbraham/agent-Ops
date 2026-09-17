/**
 * Live rectangle-edge detection for scanning a card out of a camera frame.
 *
 * No network, no WASM/OpenCV dependency — this runs on every animation frame
 * on-device, so it has to be cheap. It does not find arbitrary quadrilaterals;
 * it assumes the card is roughly where the on-screen guide box says it is
 * (the person is told to line the card up with it) and only searches a band
 * around each of the guide's four edges for the strongest gradient, which is
 * enough to snap the crop onto the card's real edges instead of the guide's
 * fixed position.
 */

/** A rectangle in the same pixel space as the ImageData/canvas it describes. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedBoundary extends PixelRect {
  /** 0..1 — how confidently each of the four edges was actually found. */
  confidence: number;
}

function toGrayscale(data: ImageData): Float32Array {
  const { data: px, width, height } = data;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    // Rec. 601 luma — cheap and good enough for edge strength.
    gray[p] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  }
  return gray;
}

/** Sobel gradient magnitude, same dimensions as the input. */
function sobelMagnitude(gray: Float32Array, width: number, height: number): Float32Array {
  const mag = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] + gray[i - width + 1] +
        -2 * gray[i - 1] + 2 * gray[i + 1] +
        -gray[i + width - 1] + gray[i + width + 1];
      const gy =
        -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] +
        gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];
      mag[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return mag;
}

/**
 * Scans a band of rows (or columns) for the one with the strongest edge
 * energy, summed across the perpendicular span. Returns the winning
 * coordinate and how far it stood out from the rest of the band (used as a
 * confidence signal — a real card edge spikes; noise/texture doesn't).
 */
function scanBand(
  mag: Float32Array,
  width: number,
  height: number,
  opts: { horizontal: boolean; bandStart: number; bandEnd: number; spanStart: number; spanEnd: number },
): { coord: number; peakiness: number } | null {
  const { horizontal, bandStart, bandEnd, spanStart, spanEnd } = opts;
  const lo = Math.max(0, Math.floor(bandStart));
  const hi = Math.min(horizontal ? width - 1 : height - 1, Math.ceil(bandEnd));
  if (hi <= lo) return null;

  const sums: number[] = [];
  for (let c = lo; c <= hi; c++) {
    let sum = 0;
    const sLo = Math.max(0, Math.floor(spanStart));
    const sHi = Math.min(horizontal ? height - 1 : width - 1, Math.ceil(spanEnd));
    for (let s = sLo; s <= sHi; s++) {
      const i = horizontal ? s * width + c : c * width + s;
      sum += mag[i];
    }
    sums.push(sum);
  }
  if (sums.length === 0) return null;

  let bestIdx = 0;
  let best = -Infinity;
  let total = 0;
  for (let k = 0; k < sums.length; k++) {
    total += sums[k];
    if (sums[k] > best) { best = sums[k]; bestIdx = k; }
  }
  const mean = total / sums.length;
  if (best <= 0 || mean <= 0) return null;
  // How far the winning line stands out above the band's average energy.
  const peakiness = Math.min(1, Math.max(0, (best - mean) / (best + mean)));
  return { coord: lo + bestIdx, peakiness };
}

/**
 * Looks for the card's real edges near each side of `guide`. Returns null
 * when nothing confident enough was found (caller should keep showing the
 * static guide box rather than a jumpy, wrong boundary).
 */
export function detectCardBoundary(
  imageData: ImageData,
  guide: PixelRect,
  opts: { searchBandRatio?: number; minConfidence?: number } = {},
): DetectedBoundary | null {
  const { width, height } = imageData;
  const searchBandRatio = opts.searchBandRatio ?? 0.18;
  const minConfidence = opts.minConfidence ?? 0.12;

  const gray = toGrayscale(imageData);
  const mag = sobelMagnitude(gray, width, height);

  const bandX = guide.width * searchBandRatio;
  const bandY = guide.height * searchBandRatio;
  // Only look at the middle of each edge, away from the rounded corners.
  const marginX = guide.width * 0.15;
  const marginY = guide.height * 0.15;

  const top = scanBand(mag, width, height, {
    horizontal: false,
    bandStart: guide.y - bandY,
    bandEnd: guide.y + bandY,
    spanStart: guide.x + marginX,
    spanEnd: guide.x + guide.width - marginX,
  });
  const bottom = scanBand(mag, width, height, {
    horizontal: false,
    bandStart: guide.y + guide.height - bandY,
    bandEnd: guide.y + guide.height + bandY,
    spanStart: guide.x + marginX,
    spanEnd: guide.x + guide.width - marginX,
  });
  const left = scanBand(mag, width, height, {
    horizontal: true,
    bandStart: guide.x - bandX,
    bandEnd: guide.x + bandX,
    spanStart: guide.y + marginY,
    spanEnd: guide.y + guide.height - marginY,
  });
  const right = scanBand(mag, width, height, {
    horizontal: true,
    bandStart: guide.x + guide.width - bandX,
    bandEnd: guide.x + guide.width + bandX,
    spanStart: guide.y + marginY,
    spanEnd: guide.y + guide.height - marginY,
  });

  if (!top || !bottom || !left || !right) return null;

  const rect: DetectedBoundary = {
    x: left.coord,
    y: top.coord,
    width: right.coord - left.coord,
    height: bottom.coord - top.coord,
    confidence: (top.peakiness + bottom.peakiness + left.peakiness + right.peakiness) / 4,
  };

  if (rect.width <= 0 || rect.height <= 0) return null;
  // A card is roughly 1.4–1.9:1. Anything wildly off is a mis-detection
  // (glare, a table edge, a shadow) rather than the card.
  const ratio = rect.width / rect.height;
  if (ratio < 1.2 || ratio > 2.3) return null;
  if (rect.confidence < minConfidence) return null;

  return rect;
}

/** True when two rects are close enough to call "the same" between frames. */
export function boundariesAgree(a: PixelRect, b: PixelRect, toleranceRatio = 0.04): boolean {
  const tol = Math.max(a.width, a.height) * toleranceRatio;
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.width - b.width) <= tol * 2 &&
    Math.abs(a.height - b.height) <= tol * 2
  );
}

/** Grows a rect by a margin (as a fraction of its own size) and clamps to the frame. */
export function padRect(rect: PixelRect, marginRatio: number, frameWidth: number, frameHeight: number): PixelRect {
  const padX = rect.width * marginRatio;
  const padY = rect.height * marginRatio;
  const x = Math.max(0, rect.x - padX);
  const y = Math.max(0, rect.y - padY);
  const right = Math.min(frameWidth, rect.x + rect.width + padX);
  const bottom = Math.min(frameHeight, rect.y + rect.height + padY);
  return { x, y, width: right - x, height: bottom - y };
}
