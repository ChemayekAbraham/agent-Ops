import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSignedUrlCache, getSignedUrl, parseStorageUrl } from './storageUtils';

const mocks = vi.hoisted(() => ({ sign: vi.fn(), bucket: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { storage: { from: mocks.bucket } },
}));
beforeEach(() => {
  vi.clearAllMocks();
  clearSignedUrlCache();
  mocks.bucket.mockReturnValue({ createSignedUrl: mocks.sign });
});
describe('profile avatar storage', () => {
  it('parses stored public and signed paths without copying token query strings', () => {
    expect(parseStorageUrl('https://example.supabase.co/storage/v1/object/sign/avatars/me/avatar.jpg?token=example'))
      .toEqual({ bucket: 'avatars', path: 'me/avatar.jpg' });
    expect(parseStorageUrl('https://example.supabase.co/storage/v1/object/public/avatars/me/avatar.jpg?v=1'))
      .toEqual({ bucket: 'avatars', path: 'me/avatar.jpg' });
  });
  it('returns no broken image URL and does not repeatedly sign a missing avatar', async () => {
    mocks.sign.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    const url = 'https://example.supabase.co/storage/v1/object/public/avatars/me/missing.jpg';
    expect(await getSignedUrl(url)).toBe('');
    expect(await getSignedUrl(url)).toBe('');
    expect(mocks.sign).toHaveBeenCalledTimes(1);
  });
  it('refreshes a stored signed avatar from its actual profile path', async () => {
    mocks.sign.mockResolvedValue({ data: { signedUrl: 'https://example.test/fresh.jpg' }, error: null });
    expect(await getSignedUrl('https://example.supabase.co/storage/v1/object/sign/avatars/me/avatar.jpg?token=old'))
      .toBe('https://example.test/fresh.jpg');
    expect(mocks.bucket).toHaveBeenCalledWith('avatars');
    expect(mocks.sign).toHaveBeenCalledWith('me/avatar.jpg', 3600);
  });
});