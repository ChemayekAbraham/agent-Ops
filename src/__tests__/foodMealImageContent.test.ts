import { describe, it, expect } from 'vitest';
import { foodMealImageSignatureType, foodMealImageContentProblem } from '@/lib/foodService';

const blob = (bytes: number[], type: string) => new Blob([new Uint8Array(bytes)], { type });
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const WEBP = [...'RIFF'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map(c => c.charCodeAt(0)));

describe('meal photo content check', () => {
  it('recognises real JPEG, PNG and WebP signatures', () => {
    expect(foodMealImageSignatureType(new Uint8Array(JPEG))).toBe('image/jpeg');
    expect(foodMealImageSignatureType(new Uint8Array(PNG))).toBe('image/png');
    expect(foodMealImageSignatureType(new Uint8Array(WEBP))).toBe('image/webp');
  });
  it('accepts a file whose content matches its type', async () => {
    expect(await foodMealImageContentProblem(blob(PNG, 'image/png'))).toBeNull();
  });
  it('refuses a non-image renamed as an image', async () => {
    expect(await foodMealImageContentProblem(blob([0x3c, 0x73, 0x76, 0x67, 0, 0, 0, 0, 0, 0, 0, 0], 'image/jpeg')))
      .toBe('That file is not a JPEG, PNG or WebP image.');
  });
  it('refuses a mismatch between content and declared type', async () => {
    expect(await foodMealImageContentProblem(blob(JPEG, 'image/png'))).toBe('The file content does not match its image type.');
  });
  it('refuses an empty or truncated file', async () => {
    expect(await foodMealImageContentProblem(blob([0xff, 0xd8], 'image/jpeg'))).not.toBeNull();
  });
});
