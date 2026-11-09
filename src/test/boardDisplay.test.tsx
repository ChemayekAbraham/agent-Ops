import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BoardDisplay from '@/pages/BoardDisplay';
const mock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/boardDisplayClient', () => ({ loadBoardDisplay: mock.load }));
const fixture = () => ({ generated_at: '2026-11-09T08:00:00Z', display: { label: 'Boardroom screen 1' },
  headline: Object.fromEntries(['today','7d','30d','90d','all'].map(k => [k, { posted: { n: 134, ugx: 23100000 }, sold: { n: 0, ugx: 0 }, waiting: { n: 134, ugx: 23100000 } }])), stages: [] });
beforeEach(() => { vi.useFakeTimers(); mock.load.mockReset(); window.history.replaceState(null, '', '/board/test-secret'); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('Public boardroom display', () => {
  it('preserves data through failed refreshes and retries after sixty seconds', async () => {
    mock.load.mockResolvedValueOnce(fixture()).mockRejectedValueOnce(new Error('This display link has been switched off')).mockResolvedValue(fixture());
    await act(async () => { render(<BoardDisplay />); });
    expect(screen.getByText('Boardroom screen 1')).toBeInTheDocument();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex,nofollow');
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(mock.load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent('This display link has been switched off');
    expect(screen.getByText('Rent requests posted')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(59999); });
    expect(mock.load).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mock.load).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('turns amber after two minutes with no good refresh and hides idle controls', async () => {
    mock.load.mockResolvedValueOnce(fixture()).mockRejectedValue(new Error('Offline'));
    await act(async () => { render(<BoardDisplay />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(document.querySelector('main')).toHaveClass('board-idle');
    await act(async () => { await vi.advanceTimersByTimeAsync(118000); });
    expect(document.querySelector('.board-live')).toHaveClass('text-warning');
  });
});