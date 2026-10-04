/**
 * Perceptual fingerprints for identity photos (selfie + National ID shot).
 *
 * A difference hash (dHash) is computed locally in the browser: the photo is
 * drawn small and grey, then neighbouring brightness comparisons become bits.
 * The same face or the same ID card photographed again produces the same or a
 * near-identical fingerprint, which lets the queue group repeat submissions
 * instead of showing the same person twice.
 *
 * No pixels leave the device — only the short hex string is stored.
 */

const W = 9; // 9x8 comparisons -> 64 bits
const H = 8;

async function loadBitmap(file: File | Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return await createImageBitmap(file);
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read the photo.'));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }
}

/**
 * 16-character hex fingerprint, or null when the photo cannot be read (the
 * submission must never fail because a fingerprint could not be produced).
 */
export async function imageFingerprint(file: File | Blob | null | undefined): Promise<string | null> {
  if (!file) return null;
  try {
    const bitmap = await loadBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);

    const grey: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      grey.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }

    let bits = '';
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W - 1; x += 1) {
        bits += grey[y * W + x] > grey[y * W + x + 1] ? '1' : '0';
      }
    }

    let hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}
