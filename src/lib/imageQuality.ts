/**
 * Canvas-only photo quality checks for identity captures.
 *
 * No network, no library: the photo is drawn to a small offscreen canvas and
 * scored for sharpness (blur), blown-out highlights (glare) and overall
 * contrast. Used to ask the person to retake the exact photo that failed
 * before it is ever uploaded.
 */

export type PhotoQualityIssue = 'blurry' | 'glare' | 'low_contrast' | 'unreadable';

export interface PhotoQualityResult {
  ok: boolean;
  issues: PhotoQualityIssue[];
  /** Variance of the Laplacian — higher is sharper. */
  sharpness: number;
  /** Share of near-white pixels (0–1) — high means reflections/flash glare. */
  glare: number;
  /** Standard deviation of brightness (0–255) — low means a flat, dim photo. */
  contrast: number;
  /** Plain-language advice for the person taking the photo. */
  message: string | null;
}

/** Tuned for phone camera shots of an ID card or a face, downscaled to ~640px. */
const SHARPNESS_MIN = 55;
const GLARE_MAX = 0.11;
const CONTRAST_MIN = 26;
const ANALYSIS_WIDTH = 640;

const ADVICE: Record<PhotoQualityIssue, string> = {
  blurry: 'it came out blurry — hold the phone still and let it focus before you tap',
  glare: 'there is too much shine on it — move away from direct light or the flash',
  low_contrast: 'it is too dark and flat — take it in brighter, even light',
  unreadable: 'we could not check this photo — please take it again',
};

function loadBitmap(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
    img.src = url;
  });
}

function grayscale(data: Uint8ClampedArray, w: number, h: number) {
  const gray = new Float32Array(w * h);
  let sum = 0;
  let bright = 0;
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const v = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    gray[i] = v;
    sum += v;
    if (v >= 245) bright++;
  }
  const mean = sum / gray.length;
  let varSum = 0;
  for (let i = 0; i < gray.length; i++) varSum += (gray[i] - mean) ** 2;
  return { gray, contrast: Math.sqrt(varSum / gray.length), glare: bright / gray.length };
}

/** Variance of the 3x3 Laplacian — the standard cheap sharpness score. */
function laplacianVariance(gray: Float32Array, w: number, h: number) {
  const vals: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      vals.push(
        4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w],
      );
    }
  }
  if (!vals.length) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
}

/**
 * Scores a photo. Never throws — an unscoreable photo comes back as
 * `unreadable` so the caller can simply ask for another shot.
 */
export async function checkPhotoQuality(file: File): Promise<PhotoQualityResult> {
  const fail = (issue: PhotoQualityIssue): PhotoQualityResult => ({
    ok: false,
    issues: [issue],
    sharpness: 0,
    glare: 0,
    contrast: 0,
    message: ADVICE[issue],
  });

  try {
    const img = await loadBitmap(file);
    const scale = Math.min(1, ANALYSIS_WIDTH / Math.max(1, img.naturalWidth));
    const w = Math.max(16, Math.round(img.naturalWidth * scale));
    const h = Math.max(16, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { ok: true, issues: [], sharpness: 0, glare: 0, contrast: 0, message: null };
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    const { gray, contrast, glare } = grayscale(data, w, h);
    const sharpness = laplacianVariance(gray, w, h);

    const issues: PhotoQualityIssue[] = [];
    if (sharpness < SHARPNESS_MIN) issues.push('blurry');
    if (glare > GLARE_MAX) issues.push('glare');
    if (contrast < CONTRAST_MIN) issues.push('low_contrast');

    return {
      ok: issues.length === 0,
      issues,
      sharpness,
      glare,
      contrast,
      message: issues.length ? issues.map((i) => ADVICE[i]).join(', and ') : null,
    };
  } catch {
    return fail('unreadable');
  }
}

/** "Retake the front of your ID: it came out blurry…" */
export function retakeMessage(label: string, result: PhotoQualityResult): string {
  return `Retake the ${label.toLowerCase()}: ${result.message ?? ADVICE.unreadable}.`;
}
