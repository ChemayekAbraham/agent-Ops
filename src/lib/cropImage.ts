/**
 * Square-crop helper for the verification selfie.
 *
 * Takes the original camera file plus a crop rectangle expressed in the
 * image's own pixel coordinates and returns a new square JPEG file. Pure
 * canvas work — no dependency, no upload, no network.
 */

export interface CropRect {
  x: number;
  y: number;
  size: number;
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that photo.'));
    img.src = src;
  });
}

/** Crops `file` to the given square and re-encodes it at `output` px. */
export async function cropImageToSquare(
  file: File,
  rect: CropRect,
  output = 800,
): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    const canvas = document.createElement('canvas');
    canvas.width = output;
    canvas.height = output;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This device cannot adjust photos.');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, output, output);
    ctx.drawImage(img, rect.x, rect.y, rect.size, rect.size, 0, 0, output, output);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9),
    );
    if (!blob) throw new Error('Could not adjust that photo.');
    const name = file.name.replace(/\.[^.]+$/, '') || 'selfie';
    return new File([blob], `${name}-cropped.jpg`, { type: 'image/jpeg' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
