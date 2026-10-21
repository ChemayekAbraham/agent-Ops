import { describe, expect, it, vi } from 'vitest';
import { fileKey, pruneCache, uploadAllResumable, type UploadCache } from './resumableUpload';

const mk = (name: string, size = 10) => new File(['x'.repeat(size)], name, { type: 'image/jpeg', lastModified: 1 });

describe('uploadAllResumable', () => {
  it('uploads every file once and returns paths in order', async () => {
    const cache: UploadCache = new Map();
    const up = vi.fn(async (f: File) => `p/${f.name}`);
    const res = await uploadAllResumable([mk('a'), mk('b')], 'req1', cache, up);
    expect(res).toEqual(['p/a', 'p/b']);
    expect(up).toHaveBeenCalledTimes(2);
  });

  it('stops at the first failure and keeps earlier uploads for the retry', async () => {
    const cache: UploadCache = new Map();
    const files = [mk('a'), mk('b'), mk('c')];
    let fail = true;
    const up = vi.fn(async (f: File) => (f.name === 'c' && fail ? null : `p/${f.name}`));

    expect(await uploadAllResumable(files, 'req1', cache, up)).toBeNull();
    expect(up).toHaveBeenCalledTimes(3);

    fail = false;
    up.mockClear();
    const res = await uploadAllResumable(files, 'req1', cache, up);
    expect(res).toEqual(['p/a', 'p/b', 'p/c']);
    expect(up).toHaveBeenCalledTimes(1); // only "c" is sent again
    expect(up.mock.calls[0][0].name).toBe('c');
  });

  it('does not share cache entries between requisitions', async () => {
    const cache: UploadCache = new Map();
    const up = vi.fn(async (f: File) => `p/${f.name}`);
    await uploadAllResumable([mk('a')], 'req1', cache, up);
    await uploadAllResumable([mk('a')], 'req2', cache, up);
    expect(up).toHaveBeenCalledTimes(2);
  });

  it('treats a different file with the same name as new', async () => {
    const cache: UploadCache = new Map();
    const up = vi.fn(async (f: File) => `p/${f.size}`);
    await uploadAllResumable([mk('a', 10)], 'req1', cache, up);
    await uploadAllResumable([mk('a', 20)], 'req1', cache, up);
    expect(up).toHaveBeenCalledTimes(2);
  });
});

describe('pruneCache', () => {
  it('forgets removed files only within the given scope', () => {
    const a = mk('a');
    const b = mk('b');
    const cache: UploadCache = new Map([
      [fileKey('req1', a), 'p/a'],
      [fileKey('req1', b), 'p/b'],
      [fileKey('req2', a), 'p/other'],
    ]);
    pruneCache(cache, 'req1', [a]);
    expect(cache.has(fileKey('req1', a))).toBe(true);
    expect(cache.has(fileKey('req1', b))).toBe(false);
    expect(cache.has(fileKey('req2', a))).toBe(true);
  });
});
