import { optimizeImage } from '@/lib/imageOptimizer';
import { safeUUID } from '@/lib/safeUUID';
import type { SignagePhoto } from '@/lib/welileSignages';

export async function prepareSignagePhoto(file: File, category: SignagePhoto['category']): Promise<SignagePhoto> {
  const optimized = await optimizeImage(file, { maxWidth: 1200, maxHeight: 1200, format: 'image/webp' });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read photo.'));
      reader.onerror = () => reject(new Error('Could not read photo.'));
      reader.readAsDataURL(optimized.file);
    });
    return { id: safeUUID(), url, category, caption: category.replace('_', ' '), taken_at: new Date().toISOString() };
  } finally {
    URL.revokeObjectURL(optimized.previewUrl);
  }
}