import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Only the personal preview row decides V3. The global switch (feature_preview_on) must never be asked.
const mocks = vi.hoisted(() => ({ row: null as unknown, rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: (table: string) => {
      mocks.from(table);
      const chain = { eq: () => chain, maybeSingle: () => Promise.resolve({ data: mocks.row, error: null }) };
      return { select: () => chain };
    },
  },
}));

import { useFunderUiV3PreviewState } from './useFunderUiV3Preview';

describe('funder V3 is a personal preview only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.rpc.mockResolvedValue({ data: true, error: null }); // global switch ON
  });

  it('keeps the live dashboard when the global switch is on but the viewer has no personal preview', async () => {
    mocks.row = null;
    const { result } = renderHook(() => useFunderUiV3PreviewState('funder-a'));
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.on).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledWith('feature_previews');
  });

  it('shows V3 to a viewer with their own preview row', async () => {
    mocks.row = { feature: 'funders_ui_v3' };
    const { result } = renderHook(() => useFunderUiV3PreviewState('funder-b'));
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.on).toBe(true);
  });

  it('is off for a signed-out viewer', () => {
    const { result } = renderHook(() => useFunderUiV3PreviewState(null));
    expect(result.current).toEqual({ on: false, resolved: true });
  });
});
