import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import { FEATURE_FUNDERS_BOARD_TAGS, FEATURE_FUNDERS_UI_V3, resetFeaturePreviewCache, useFeaturePreviewState } from './useFeaturePreview';

describe('useFeaturePreviewState', () => {
  beforeEach(() => {
    rpc.mockReset();
    resetFeaturePreviewCache();
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    Object.defineProperty(window, 'localStorage', { value: globalThis.localStorage, configurable: true });
  });

  it('asks feature_preview_on for the named feature (switch or preview row)', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const { result } = renderHook(() => useFeaturePreviewState(FEATURE_FUNDERS_BOARD_TAGS, 'u1'));
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.on).toBe(true);
    expect(rpc).toHaveBeenCalledWith('feature_preview_on', { p_feature: 'funders_board_tags' });
  });

  it('is off when the server says no or fails, and features are read separately', async () => {
    rpc.mockImplementation((_fn: string, args: { p_feature: string }) =>
      Promise.resolve(args.p_feature === FEATURE_FUNDERS_UI_V3 ? { data: true, error: null } : { data: null, error: { message: 'boom' } }),
    );
    const tags = renderHook(() => useFeaturePreviewState(FEATURE_FUNDERS_BOARD_TAGS, 'u1'));
    const v3 = renderHook(() => useFeaturePreviewState(FEATURE_FUNDERS_UI_V3, 'u1'));
    await waitFor(() => expect(tags.result.current.resolved && v3.result.current.resolved).toBe(true));
    expect(tags.result.current.on).toBe(false);
    expect(v3.result.current.on).toBe(true);
  });

  it('no viewer means off without a request', () => {
    const { result } = renderHook(() => useFeaturePreviewState(FEATURE_FUNDERS_BOARD_TAGS, null));
    expect(result.current).toEqual({ on: false, resolved: true });
    expect(rpc).not.toHaveBeenCalled();
  });
});
