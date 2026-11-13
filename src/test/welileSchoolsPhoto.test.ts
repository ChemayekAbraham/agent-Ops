import { describe, it, expect, vi } from 'vitest';

// The test environment has no Supabase URL; these helpers never touch the client.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { cropFaceSquare, studentPhotoPath } from '@/lib/welileSchoolsPhoto';

describe('cropFaceSquare', () => {
  it('crops a centred square from a portrait frame', () => {
    const c = cropFaceSquare(720, 1280);
    expect(c.side).toBe(619);
    expect(c.sx).toBe(51);
    expect(c.sy).toBe(331);
    expect(c.sx * 2 + c.side).toBeLessThanOrEqual(720 + 1);
  });
  it('crops a centred square from a landscape frame', () => {
    const c = cropFaceSquare(1280, 720);
    expect(c.side).toBe(619);
    expect(c.sy).toBe(51);
    expect(c.sx).toBe(331);
  });
  it('always stays inside the frame', () => {
    for (const [w, h] of [[640, 480], [1920, 1080], [480, 640]]) {
      const c = cropFaceSquare(w, h);
      expect(c.sx).toBeGreaterThanOrEqual(0);
      expect(c.sy).toBeGreaterThanOrEqual(0);
      expect(c.sx + c.side).toBeLessThanOrEqual(w);
      expect(c.sy + c.side).toBeLessThanOrEqual(h);
    }
  });
});

describe('studentPhotoPath', () => {
  it('files the photo under the school, named after the profile', () => {
    expect(studentPhotoPath('school-1', 'profile-9')).toBe('school-1/profile-9.jpg');
  });
});
