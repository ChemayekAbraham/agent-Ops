/**
 * Canvas-only image cropping. No library, no network — the file never leaves
 * the device until the caller uploads it.
 */

export interface CropRect {
  /** Left edge in the source image's own pixel coordinates. */
  x: number;
  /** Top edge in the source image's own pixel coordinates. */
  y: number;
  /** Side length of the square crop, in source pixels. */
  size: number;
}

export function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that photo. Please take it again.'));
    };
    img.src = url;
  });
}

/**
 * Crops `file` to the given square (source-pixel coordinates) and re-encodes
 * it as a square JPEG of `output` pixels a side. Returns a brand-new File so
 * the ORIGINAL file object stays untouched and can still be archived.
 */
export async function cropImageToSquare(file: File, rect: CropRect, output = 800): Promise<File> {
  const img = await loadImageElement(file);
  const canvas = document.createElement('canvas');
  canvas.width = output;
  canvas.height = output;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Cropping is not available on this device.');

  const size = Math.max(1, Math.round(rect.size));
  const sx = Math.max(0, Math.min(Math.round(rect.x), Math.max(0, img.naturalWidth - 1)));
  const sy = Math.max(0, Math.min(Math.round(rect.y), Math.max(0, img.naturalHeight - 1)));
  ctx.drawImage(img, sx, sy, size, size, 0, 0, output, output);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9),
  );
  if (!blob) throw new Error('Could not prepare that photo. Please take it again.');

  return new File([blob], `selfie-cropped-${Date.now()}.jpg`, { type: 'image/jpeg' });
}
