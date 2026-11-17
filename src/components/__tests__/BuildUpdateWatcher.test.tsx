import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  custom: vi.fn(),
  live: { source: 'new-src', builtAt: '2026-11-17T09:00:00.000Z' } as { source: string; builtAt: string } | null,
  critical: false,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { custom: mocks.custom }) }));
vi.mock('@/lib/buildInfo', () => ({ BUILD_INFO: { mode: 'production', source: 'old-src', builtAt: '2026-11-17T08:30:00.000Z', commit: 'x' } }));
vi.mock('@/lib/buildUpdate', async (orig) => ({
  ...(await orig<typeof import('@/lib/buildUpdate')>()),
  RUNNING_BUILD: { source: 'old-src', builtAt: '2026-11-17T08:30:00.000Z' },
  fetchLiveBuild: vi.fn(async () => mocks.live),
}));
vi.mock('@/lib/criticalFlowGuard', () => ({ isCriticalFlowActive: () => mocks.critical, subscribeCriticalFlow: () => () => {} }));

import { BuildUpdateWatcher, NewBuildBanner, RECHECK_MS } from '@/components/BuildUpdateWatcher';

beforeEach(() => {
  vi.useFakeTimers();
  mocks.custom.mockReset();
  mocks.live = { source: 'new-src', builtAt: '2026-11-17T09:00:00.000Z' };
  mocks.critical = false;
});
afterEach(() => vi.useRealTimers());

describe('"A new version of Welile is ready" as soon as a newer build exists', () => {
  it('is offered on start, with no wait', async () => {
    render(<BuildUpdateWatcher />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.custom).toHaveBeenCalledTimes(1);
    expect(mocks.custom.mock.calls[0][1]).toMatchObject({ id: 'welile-new-build', duration: Infinity });
  });

  it('a build deployed later is offered at the next check (2 minutes)', async () => {
    mocks.live = { source: 'old-src', builtAt: '2026-11-17T08:30:00.000Z' };
    render(<BuildUpdateWatcher />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.custom).not.toHaveBeenCalled();
    mocks.live = { source: 'new-src', builtAt: '2026-11-17T09:00:00.000Z' };
    await act(async () => { await vi.advanceTimersByTimeAsync(RECHECK_MS); });
    expect(mocks.custom).toHaveBeenCalledTimes(1);
    expect(RECHECK_MS).toBe(2 * 60 * 1000);
  });

  it('the banner leads with "Update now"', () => {
    vi.useRealTimers();
    const onUpdate = vi.fn();
    render(<NewBuildBanner onUpdate={onUpdate} />);
    const banner = screen.getByTestId('new-build-banner');
    expect(banner.firstElementChild).toHaveTextContent('Update now');
    expect(banner).toHaveTextContent(/^Update nowA new version of Welile is ready/);
    screen.getByRole('button', { name: 'Update now' }).click();
    expect(onUpdate).toHaveBeenCalled();
  });

  it('still held back while a protected flow (collection, payout, sign-in) is open', async () => {
    mocks.critical = true;
    render(<BuildUpdateWatcher />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.custom).not.toHaveBeenCalled();
  });
});
