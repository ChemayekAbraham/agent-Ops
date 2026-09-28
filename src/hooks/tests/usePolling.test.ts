import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from '@/hooks/usePolling';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not load on mount unless immediate', async () => {
    const load = vi.fn();
    renderHook(() => usePolling(load, 1_000));
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
  });

  it('loads on mount with immediate and then on every interval', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => usePolling(load, 1_000, { immediate: true }));
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.lastUpdatedAt).toBeInstanceOf(Date);

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('skips ticks while the tab is hidden and refreshes when it becomes visible', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    renderHook(() => usePolling(load, 1_000));
    setVisibility('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(load).not.toHaveBeenCalled();

    setVisibility('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled', async () => {
    const load = vi.fn();
    renderHook(() => usePolling(load, 1_000, { enabled: false, immediate: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(load).not.toHaveBeenCalled();
  });

  it('always calls the latest loader without restarting the timer', async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ fn }) => usePolling(fn, 1_000), { initialProps: { fn: first } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    rerender({ fn: second });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does not overlap a slow load, and survives a failing one', async () => {
    let resolveSlow: () => void = () => {};
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((r) => { resolveSlow = r; }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => usePolling(load, 1_000));

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(load).toHaveBeenCalledTimes(1); // still in flight — ticks coalesce

    await act(async () => { resolveSlow(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); // this one throws
    expect(warn).toHaveBeenCalled();
    await act(async () => { await result.current.refresh(); });
    expect(load).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('stops polling after unmount', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => usePolling(load, 1_000));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(load).not.toHaveBeenCalled();
  });
});
