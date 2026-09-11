/**
 * Client-side image optimization using Canvas API.
 * Resizes, compresses to WebP (with JPEG fallback), and generates thumbnails.
 * Designed for 40M+ users on African mobile networks.
 */

interface OptimizeOptions {
  /** Max width in pixels (default: 1200) */
  maxWidth?: number;
  /** Max height in pixels (default: 1200) */
  maxHeight?: number;
  /** Quality 0-1 (default: 0.8) */
  quality?: number;
  /** Output format (default: 'image/webp', falls back to 'image/jpeg') */
  format?: string;
}

interface OptimizedResult {
  /** The compressed file */
  file: File;
  /** Object URL for preview */
  previewUrl: string;
  /** Width after resize */
  width: number;
  /** Height after resize */
  height: number;
  /** Original file size in bytes */
  originalSize: number;
  /** Compressed file size in bytes */
  compressedSize: number;
}

interface ThumbnailResult {
  file: File;
  previewUrl: string;
}

// Check WebP support once
let _webpSupported: boolean | null = null;
function supportsWebP(): boolean {
  if (_webpSupported !== null) return _webpSupported;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  _webpSupported = canvas.toDataURL('image/webp').startsWith('data:image/webp');
  return _webpSupported;
}

/**
 * Load an image File into an HTMLImageElement
 */
function loadImage(file: File, timeoutMs = 15000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    let settled = false;

    // Guard against images that never fire onload/onerror (e.g. some HEIC
    // files on certain browsers), which would otherwise hang the UI forever.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      reject(new Error('Image load timed out'));
    }, timeoutMs);

    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error('Image failed to load'));
    };
    img.src = url;
  });
}

/**
 * Calculate dimensions maintaining aspect ratio
 */
function fitDimensions(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  if (width <= maxWidth && height <= maxHeight) {
    return { width, height };
  }
  const ratio = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}

/**
 * Draw image to canvas at target dimensions and export as blob
 */
function canvasToBlob(
  img: HTMLImageElement,
  width: number,
  height: number,
  format: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Canvas 2D context not available'));
      return;
    }
    ctx.drawImage(img, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob returned null'));
      },
      format,
      quality
    );
  });
}

/**
 * Optimize an image file: resize + compress.
 * Reduces 5MB phone photos to ~100-300KB WebP.
 */
export async function optimizeImage(
  file: File,
  options: OptimizeOptions = {}
): Promise<OptimizedResult> {
  const {
    maxWidth = 1200,
    maxHeight = 1200,
    quality = 0.8,
    format: forcedFormat,
  } = options;

  // Skip non-image files
  if (!file.type.startsWith('image/')) {
    throw new Error('Not an image file');
  }

  // Skip tiny files (already optimized or icons)
  if (file.size < 50 * 1024) {
    const url = URL.createObjectURL(file);
    return {
      file,
      previewUrl: url,
      width: 0,
      height: 0,
      originalSize: file.size,
      compressedSize: file.size,
    };
  }

  const img = await loadImage(file);
  const { width, height } = fitDimensions(img.width, img.height, maxWidth, maxHeight);

  // Caller may pin the output format (e.g. flows that only accept JPEG/PNG).
  // Otherwise try WebP first and fall back to JPEG.
  const format = forcedFormat ?? (supportsWebP() ? 'image/webp' : 'image/jpeg');
  const ext = format === 'image/webp' ? 'webp' : format === 'image/png' ? 'png' : 'jpg';

  const blob = await canvasToBlob(img, width, height, format, quality);

  // Clean up the object URL from loadImage
  URL.revokeObjectURL(img.src);

  const optimizedFile = new File(
    [blob],
    file.name.replace(/\.[^.]+$/, `.${ext}`),
    { type: format }
  );

  const previewUrl = URL.createObjectURL(optimizedFile);

  return {
    file: optimizedFile,
    previewUrl,
    width,
    height,
    originalSize: file.size,
    compressedSize: optimizedFile.size,
  };
}

/**
 * Generate a small thumbnail (300px) for listing cards.
 */
export async function generateThumbnail(
  file: File,
  size: number = 300
): Promise<ThumbnailResult> {
  const img = await loadImage(file);
  const { width, height } = fitDimensions(img.width, img.height, size, size);

  const format = supportsWebP() ? 'image/webp' : 'image/jpeg';
  const ext = format === 'image/webp' ? 'webp' : 'jpg';

  // Lower quality for thumbnails — they're tiny
  const blob = await canvasToBlob(img, width, height, format, 0.6);
  URL.revokeObjectURL(img.src);

  const thumbFile = new File(
    [blob],
    `thumb_${file.name.replace(/\.[^.]+$/, `.${ext}`)}`,
    { type: format }
  );

  return {
    file: thumbFile,
    previewUrl: URL.createObjectURL(thumbFile),
  };
}

/**
 * Optimize multiple images in parallel with concurrency limit.
 * Prevents memory issues on low-end phones.
 */
export async function optimizeBatch(
  files: File[],
  options: OptimizeOptions = {},
  concurrency: number = 2
): Promise<OptimizedResult[]> {
  const results: OptimizedResult[] = [];
  
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(f => optimizeImage(f, options))
    );
    results.push(...batchResults);
  }
  
  return results;
}
