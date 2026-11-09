import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BoardDisplay from '@/pages/BoardDisplay';
const mock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/boardDisplayClient', () => ({ loadBoardDisplay: mock.load }));
const fixture = () => ({ generated_at: '2026-11-09T08:00:00Z', display: { label: 'Boardroom screen 1' },
  headline: Object.fromEntries(['today','7d','30d','90d','all'].map(k => [k, { posted: { n: 134, ugx: 23100000 }, sold: { n: 0, ugx: 0 }, waiting: { n: 134, ugx: 23100000 } }])),
  stages: [
    { ord: 0, stage: 'Submitted', desk: '', waiting: 6, waiting_ugx: 900000, done_24h: 6, done_7d: 0, per_day_7d: 0, days_to_clear: null, rejected_7d: 0 },
    { ord: 2, stage: 'Agent Ops', desk: 'agent-ops', waiting: 17, waiting_ugx: 15300000, done_24h: 5, done_7d: 0, per_day_7d: 0, days_to_clear: 1.3, rejected_7d: 0 },
  ] });
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
  it('a refused link takes the whole screen, even over earlier totals, and is retried every 60 s', async () => {
    window.history.replaceState(null, '', '/b/test-secret');
    mock.load.mockResolvedValueOnce(fixture()).mockRejectedValueOnce(Object.assign(new Error('This display link has been switched off'), { code: '28000' })).mockResolvedValue(fixture());
    await act(async () => { render(<BoardDisplay />); });
    expect(mock.load.mock.calls[0][0]).toBe('test-secret');
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(document.querySelector('main')?.getAttribute('data-board-state')).toBe('error');
    expect(screen.getByRole('alert')).toHaveTextContent('This display link has been switched off');
    expect(screen.queryByText('Rent requests posted')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mock.load).toHaveBeenCalledTimes(3);
    expect(document.querySelector('main')?.getAttribute('data-board-state')).toBe('live');
  });
  it('an error before any totals shows full screen', async () => {
    mock.load.mockRejectedValue(new Error('Failed to fetch'));
    await act(async () => { render(<BoardDisplay />); });
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch');
    expect(screen.getByText('Trying again every 60 seconds.')).toBeInTheDocument();
  });
  it('shows the LIVE line, the captions, the table and the pipeline; Submitted shows done 24 h only; totals only', async () => {
    mock.load.mockResolvedValue(fixture());
    await act(async () => { render(<BoardDisplay />); });
    expect(screen.getByText('LIVE · updated 11:00:00 Kampala')).toBeInTheDocument();
    for (const c of ["From the COO to the funders' board", 'Partner took it and money released to the landlord', 'Posted and not yet sold']) expect(screen.getByText(c)).toBeInTheDocument();
    expect([...document.querySelectorAll('.board-comparison thead th')].map((th) => th.textContent)).toEqual(['Rent requests', '7 days', '30 days', '90 days', 'All time']);
    expect([...document.querySelectorAll('.board-comparison tbody th')].map((th) => th.textContent)).toEqual(['Posted', 'Sold', 'Waiting']);
    const submitted = document.querySelector('[data-stage="0"]') as HTMLElement;
    expect(submitted).toHaveTextContent('came in · last 24 h');
    expect(submitted).not.toHaveTextContent('waiting');
    expect(submitted).not.toHaveTextContent('Days to clear');
    expect(document.querySelector('[data-stage="2"]')).toHaveTextContent('Days to clear');
    expect([...document.querySelectorAll('[data-stage]')].map((e) => e.getAttribute('data-stage'))).toEqual(['0', '2']);
  });
  it('pulses a number that changes, for 0.8 s', async () => {
    const next = fixture();
    next.headline.today.sold = { n: 1, ugx: 950000 };
    mock.load.mockResolvedValueOnce(fixture()).mockResolvedValue(next);
    await act(async () => { render(<BoardDisplay />); });
    expect(document.querySelector('[data-changed]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(document.querySelectorAll('[data-changed]').length).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(document.querySelector('[data-changed]')).toBeNull();
  });
});
