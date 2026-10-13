import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Meal photos on the REAL (non-fixture) path: what the client sends to
 * Storage and to the RPCs. The bucket is PRIVATE, so photos are shown through
 * short-lived signed URLs and never through a public URL. The server rules
 * themselves (private bucket, who may read and upload, immutability, the
 * food_upsert_meal bypass, audit) are proven in
 * supabase/tests/food_m1/local/45_meal_images.sql against a local stand-in;
 * real Supabase Storage behaviour is not proven by either.
 */

const uploads: Array<{ bucket: string; path: string; opts: Record<string, unknown> }> = [];
const rpcCalls: Array<[string, Record<string, unknown>]> = [];
const signCalls: Array<{ bucket: string; paths: string[]; ttl: number }> = [];
let uploadError: { message: string } | null = null;
let signMode: 'ok' | 'error' | 'throw' = 'ok';
const unsignable = new Set<string>();     // objects Storage refuses (missing / not readable)
let menuResponse: unknown = null;

const getPublicUrl = vi.fn(() => { throw new Error('getPublicUrl must not be used for meal photos'); });

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push([fn, args]);
      if (fn === 'food_menu_for_day') return Promise.resolve({ data: menuResponse, error: null });
      if (fn === 'food_upsert_meal') return Promise.resolve({ data: 'meal-id', error: null });
      return Promise.resolve({ data: { meal_id: args.p_meal_id, image_path: args.p_image_path }, error: null });
    },
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, _file: File, opts: Record<string, unknown>) => {
          uploads.push({ bucket, path, opts });
          return Promise.resolve(uploadError ? { data: null, error: uploadError } : { data: { path }, error: null });
        },
        getPublicUrl,
        createSignedUrls: (paths: string[], ttl: number) => {
          signCalls.push({ bucket, paths: [...paths], ttl });
          if (signMode === 'throw') return Promise.reject(new Error('network down'));
          if (signMode === 'error') return Promise.resolve({ data: null, error: { message: 'storage unavailable' } });
          return Promise.resolve({
            data: paths.map((p) => (unsignable.has(p)
              ? { path: p, signedUrl: '', error: 'Object not found' }
              : { path: p, signedUrl: `https://storage.test/sign/${bucket}/${p}?token=t${signCalls.length}`, error: null })),
            error: null,
          });
        },
      }),
    },
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u' } } }) },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.stubEnv('VITE_FOOD_SERVICE_MOCK', '');

import {
  useSetFoodMealPhoto, useFoodMenu, useUpsertFoodMeal,
  signFoodMealPhotos, forgetFoodMealPhotoUrl, resetFoodMealPhotoCache,
} from '@/hooks/useFoodService';
import {
  foodMealImageProblem, foodMealImagePath, FOOD_MEAL_IMAGE_NAME, FOOD_MEAL_PHOTO_URL_TTL_SECONDS,
} from '@/lib/foodService';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const MEAL = 'a0000000-0000-4000-8000-000000000001';
const A = 'meals/a0000000-0000-4000-8000-00000000000a.jpg';
const B = 'meals/b0000000-0000-4000-8000-00000000000b.png';
const C = 'meals/c0000000-0000-4000-8000-00000000000c.webp';

beforeEach(() => {
  uploads.length = 0; rpcCalls.length = 0; signCalls.length = 0;
  uploadError = null; signMode = 'ok'; unsignable.clear(); menuResponse = null;
  getPublicUrl.mockClear();
  resetFoodMealPhotoCache();
});
afterEach(() => { vi.useRealTimers(); });

describe('meal photo rules (client copy of the bucket limits)', () => {
  it('accepts JPEG, PNG and WebP up to 2 MB', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(foodMealImageProblem({ type, size: 2 * 1024 * 1024 })).toBeNull();
    }
  });
  it('refuses other types, oversized and empty files', () => {
    expect(foodMealImageProblem({ type: 'image/gif', size: 10 })).toMatch(/jpeg, png or webp/i);
    expect(foodMealImageProblem({ type: 'image/svg+xml', size: 10 })).toMatch(/jpeg, png or webp/i);
    expect(foodMealImageProblem({ type: 'image/png', size: 2 * 1024 * 1024 + 1 })).toMatch(/2 mb/i);
    expect(foodMealImageProblem({ type: 'image/png', size: 0 })).toMatch(/empty/i);
  });
  it('names uploads exactly as the storage policy, RPC and column CHECK require', () => {
    expect(foodMealImagePath('image/jpeg')).toMatch(FOOD_MEAL_IMAGE_NAME);
    expect(foodMealImagePath('image/webp')).toMatch(/\.webp$/);
  });
});

describe('signFoodMealPhotos: private bucket, signed URLs', () => {
  it('signs every photo of a menu in ONE request, with a short lifetime', async () => {
    const urls = await signFoodMealPhotos([A, B, A, null, undefined]);
    expect(signCalls).toHaveLength(1);
    expect(signCalls[0]).toMatchObject({ bucket: 'food-meal-images', ttl: FOOD_MEAL_PHOTO_URL_TTL_SECONDS });
    expect(signCalls[0].paths.sort()).toEqual([A, B].sort());
    expect(urls.get(A)).toMatch(/^https:\/\/storage\.test\/sign\/food-meal-images\/meals\//);
    expect(urls.get(B)).toMatch(/token=/);
  });

  it('never builds a public URL', async () => {
    await signFoodMealPhotos([A, B, C]);
    expect(getPublicUrl).not.toHaveBeenCalled();
  });

  it('never sends or shows external, data, absolute or malformed paths', async () => {
    const bad = ['https://evil.example/pixel.png', 'data:image/png;base64,AAAA', '/etc/passwd',
      '../avatars/a.png', 'meals/not-a-uuid.jpg', 'blob:http://x/1'];
    const urls = await signFoodMealPhotos(bad);
    expect(signCalls).toHaveLength(0);
    for (const b of bad) expect(urls.get(b)).toBeNull();
  });

  it('a photo Storage will not sign (missing or not readable) shows no image', async () => {
    unsignable.add(B);
    const urls = await signFoodMealPhotos([A, B]);
    expect(urls.get(A)).toBeTruthy();
    expect(urls.get(B)).toBeNull();
  });

  it('a failed signing request degrades to no images without throwing', async () => {
    signMode = 'error';
    expect((await signFoodMealPhotos([A])).get(A)).toBeNull();
    signMode = 'throw';
    expect((await signFoodMealPhotos([A])).get(A)).toBeNull();
  });

  it('reuses a link until shortly before it expires, then signs again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T09:00:00Z'));
    const first = (await signFoodMealPhotos([A])).get(A);
    vi.setSystemTime(new Date('2026-10-13T09:45:00Z'));          // 45 min: still fresh
    expect((await signFoodMealPhotos([A])).get(A)).toBe(first);
    expect(signCalls).toHaveLength(1);
    vi.setSystemTime(new Date('2026-10-13T09:55:00Z'));          // inside the 10-min margin
    const second = (await signFoodMealPhotos([A])).get(A);
    expect(signCalls).toHaveLength(2);
    expect(second).not.toBe(first);
  });

  it('a link that failed to load is forgotten and re-signed next time', async () => {
    const first = (await signFoodMealPhotos([A])).get(A);
    forgetFoodMealPhotoUrl(first);
    await signFoodMealPhotos([A]);
    expect(signCalls).toHaveLength(2);
  });
});

describe('useFoodMenu shows signed photos only', () => {
  it('replaces stored names with signed URLs, and invalid values with null', async () => {
    menuResponse = {
      service_date: '2026-10-13', closed: false,
      periods: [{
        period_id: 'p', name: 'Lunch',
        meals: [
          { menu_item_id: '1', meal_id: 'm1', name: 'A', image_path: A },
          { menu_item_id: '2', meal_id: 'm2', name: 'No photo', image_path: null },
          { menu_item_id: '3', meal_id: 'm3', name: 'Rogue', image_path: 'https://evil.example/pixel.png' },
        ],
      }],
    };
    const { result } = renderHook(() => useFoodMenu(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    const meals = result.current.data!.periods[0].meals;
    expect(meals[0].image_path).toMatch(/^https:\/\/storage\.test\/sign\//);
    expect(meals[1].image_path).toBeNull();
    expect(meals[2].image_path).toBeNull();
    expect(signCalls).toHaveLength(1);
    expect(signCalls[0].paths).toEqual([A]);
    expect(getPublicUrl).not.toHaveBeenCalled();
  });
});

describe('useUpsertFoodMeal cannot carry a photo', () => {
  it('sends no image path to food_upsert_meal', async () => {
    const { result } = renderHook(() => useUpsertFoodMeal(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ mealId: null, name: 'Pilau', priceUgx: 9000 });
    });
    const [fn, args] = rpcCalls.find(([f]) => f === 'food_upsert_meal')!;
    expect(fn).toBe('food_upsert_meal');
    expect(args).not.toHaveProperty('p_image_path');
  });
});

describe('useSetFoodMealPhoto (real path)', () => {
  it('uploads under a fresh server-shaped name, never overwriting, then attaches it', async () => {
    const { result } = renderHook(() => useSetFoodMealPhoto(), { wrapper });
    const file = new File([new Uint8Array(10)], 'pic.png', { type: 'image/png' });
    await act(async () => { await result.current.mutateAsync({ mealId: MEAL, file }); });

    expect(uploads).toHaveLength(1);
    expect(uploads[0].bucket).toBe('food-meal-images');
    expect(uploads[0].path).toMatch(FOOD_MEAL_IMAGE_NAME);
    expect(uploads[0].path).toMatch(/\.png$/);
    expect(uploads[0].opts).toMatchObject({ upsert: false, contentType: 'image/png' });
    expect(rpcCalls).toEqual([['food_set_meal_image', { p_meal_id: MEAL, p_image_path: uploads[0].path, p_reason: null }]]);
  });

  it('removes a photo with a NULL path and no upload', async () => {
    const { result } = renderHook(() => useSetFoodMealPhoto(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ mealId: MEAL, file: null }); });
    expect(uploads).toHaveLength(0);
    expect(rpcCalls).toEqual([['food_set_meal_image', { p_meal_id: MEAL, p_image_path: null, p_reason: null }]]);
  });

  it('refuses a bad file before touching Storage', async () => {
    const { result } = renderHook(() => useSetFoodMealPhoto(), { wrapper });
    const gif = new File(['x'], 'a.gif', { type: 'image/gif' });
    act(() => { result.current.mutate({ mealId: MEAL, file: gif }); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(uploads).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it('does not attach anything when the upload fails', async () => {
    uploadError = { message: 'new row violates row-level security policy' };
    const { result } = renderHook(() => useSetFoodMealPhoto(), { wrapper });
    const file = new File([new Uint8Array(10)], 'pic.jpg', { type: 'image/jpeg' });
    act(() => { result.current.mutate({ mealId: MEAL, file }); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(rpcCalls).toHaveLength(0);
  });
});
