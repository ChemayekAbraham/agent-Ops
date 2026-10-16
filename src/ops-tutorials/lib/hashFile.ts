import { createSHA256 } from 'hash-wasm';

const CHUNK = 4 * 1024 * 1024;

export async function hashFile(file: File, onProgress?: (p: number) => void): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const ab = await file.slice(offset, offset + CHUNK).arrayBuffer();
    hasher.update(new Uint8Array(ab));
    onProgress?.(Math.min(1, (offset + ab.byteLength) / file.size));
  }
  onProgress?.(1);
  return hasher.digest('hex').toLowerCase();
}
