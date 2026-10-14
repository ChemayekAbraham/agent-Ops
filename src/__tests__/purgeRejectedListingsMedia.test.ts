import { describe, it, expect } from 'vitest';
import {
  decideListingMedia, planListingMediaDeletion, PURGE_ALLOWED_BUCKETS,
} from '../../supabase/functions/purge-rejected-listings/media';

/**
 * P-3: purge-rejected-listings deletes with the service role, so the media
 * decision is the only control on what it removes. Before the fix it took the
 * bucket from the URL text and would delete from ANY bucket, including the
 * private Food bucket.
 */

const PROJECT = 'https://abcdefghijklmnopqrst.supabase.co';
const pub = (bucket: string, path: string, host = PROJECT) => `${host}/storage/v1/object/public/${bucket}/${path}`;

describe('allowed listing media is still deleted', () => {
  it('only house-images is authorised', () => {
    expect([...PURGE_ALLOWED_BUCKETS]).toEqual(['house-images']);
  });

  it('a normal listing photo is deleted, query string ignored', () => {
    expect(decideListingMedia(pub('house-images', 'u1/1700000000-front.jpg?t=1'), PROJECT))
      .toEqual({ kind: 'delete', ref: { bucket: 'house-images', path: 'u1/1700000000-front.jpg' } });
  });

  it('an encoded file name is decoded once, as Storage stores it', () => {
    expect(decideListingMedia(pub('house-images', 'u1/my%20house.jpg'), PROJECT))
      .toEqual({ kind: 'delete', ref: { bucket: 'house-images', path: 'u1/my house.jpg' } });
  });

  it('a whole rejected listing: photos grouped and de-duplicated, videos ignored', () => {
    const plan = planListingMediaDeletion([
      pub('house-images', 'u1/a.jpg'), pub('house-images', 'u1/a.jpg'), pub('house-images', 'u1/b.png'),
      'https://youtu.be/dQw4w9WgXcQ', null, undefined, '',
    ], PROJECT);
    expect([...plan.byBucket.keys()]).toEqual(['house-images']);
    expect([...plan.byBucket.get('house-images')!].sort()).toEqual(['u1/a.jpg', 'u1/b.png']);
    expect(plan.refused).toEqual([]);
  });
});

describe('Food photos and other buckets are never deleted', () => {
  it('a private Food meal photo is refused', () => {
    expect(decideListingMedia(pub('food-meal-images', 'meals/a0000000-0000-4000-8000-00000000000a.jpg'), PROJECT))
      .toEqual({ kind: 'refused', reason: 'bucket_not_allowed', bucket: 'food-meal-images' });
  });

  it.each(['avatars', 'service-centre-photos', 'agent-receipts', 'db-backups', 'wallet-statements', 'merchandise'])(
    'bucket %s is refused', (bucket) => {
      expect(decideListingMedia(pub(bucket, 'x/y.jpg'), PROJECT)).toMatchObject({ kind: 'refused', reason: 'bucket_not_allowed' });
    });

  it('a path that climbs from house-images into the Food bucket is refused', () => {
    for (const p of [
      `${PROJECT}/storage/v1/object/public/house-images/../food-meal-images/meals/a.jpg`,
      `${PROJECT}/storage/v1/object/public/house-images/%2e%2e/food-meal-images/meals/a.jpg`,
    ]) {
      expect(decideListingMedia(p, PROJECT)).toMatchObject({ kind: 'refused', bucket: 'food-meal-images' });
    }
  });

  it('a mixed listing deletes only its house-images objects and counts the rest', () => {
    const plan = planListingMediaDeletion([
      pub('house-images', 'u1/a.jpg'),
      pub('food-meal-images', 'meals/a0000000-0000-4000-8000-00000000000a.jpg'),
      pub('food-meal-images', 'meals/b0000000-0000-4000-8000-00000000000b.png'),
      pub('avatars', 'u2/me.png'),
    ], PROJECT);
    expect([...plan.byBucket.keys()]).toEqual(['house-images']);
    expect(plan.refused).toEqual(expect.arrayContaining([
      { reason: 'bucket_not_allowed', bucket: 'food-meal-images', count: 2 },
      { reason: 'bucket_not_allowed', bucket: 'avatars', count: 1 },
    ]));
    // the refusal log carries no URLs or object paths
    expect(JSON.stringify(plan.refused)).not.toMatch(/meals\/|u2\/me|https?:/);
  });
});

describe('external URLs, malformed input and path tricks are refused', () => {
  it('a storage-shaped URL on another host is refused (cannot target our files)', () => {
    expect(decideListingMedia(pub('house-images', 'u1/a.jpg', 'https://evil.example'), PROJECT))
      .toEqual({ kind: 'refused', reason: 'foreign_host' });
    expect(decideListingMedia(pub('house-images', 'u1/a.jpg', 'https://abcdefghijklmnopqrst.supabase.co.evil.example'), PROJECT))
      .toEqual({ kind: 'refused', reason: 'foreign_host' });
  });

  it('an ordinary external link is simply not storage', () => {
    expect(decideListingMedia('https://drive.google.com/file/d/abc/view', PROJECT)).toEqual({ kind: 'not_storage' });
  });

  it.each([
    ['relative path', '/storage/v1/object/public/house-images/u1/a.jpg'],
    ['bare text', 'house-images/u1/a.jpg?/storage/v1/object/public/'],
    ['non-http scheme', 'ftp://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/house-images/a.jpg'],
  ])('%s is never deleted', (_label, raw) => {
    expect(decideListingMedia(raw, PROJECT).kind).not.toBe('delete');
  });

  it.each([
    ['malformed %-escape (used to crash the whole run)', pub('house-images', 'u1/%E0%A4%A.jpg')],
    ['encoded slash', pub('house-images', 'u1%2F..%2F..%2Fother.jpg')],
    ['encoded backslash', pub('house-images', 'u1%5C..%5Cother.jpg')],
    ['empty segment', pub('house-images', 'u1//a.jpg')],
    ['control character', pub('house-images', 'u1/a%00.jpg')],
    ['bucket only', `${PROJECT}/storage/v1/object/public/house-images/`],
    ['no bucket', `${PROJECT}/storage/v1/object/public/`],
    ['uppercase / odd bucket', pub('House-Images', 'u1/a.jpg')],
    ['over-long path', pub('house-images', `u1/${'a'.repeat(1100)}.jpg`)],
  ])('%s is refused', (_label, raw) => {
    expect(decideListingMedia(raw, PROJECT).kind).toBe('refused');
  });

  it('non-string values are ignored, not thrown on', () => {
    for (const v of [42, {}, [], true]) expect(decideListingMedia(v, PROJECT)).toEqual({ kind: 'not_storage' });
  });
});
