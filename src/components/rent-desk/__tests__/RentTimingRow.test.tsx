import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RentTimingRow } from '../RentTimingRow';
import { normalizeTiming, timingRow } from '@/lib/rentTiming';

const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const D = 86400;
const timing = normalizeTiming({
  request_id: 'r1', state: 'at_desk', desk: 'tenant_ops',
  current: { desk: 'tenant_ops', entry: '2026-10-09T12:00:00+00:00', seconds: 10 * D, quality: 'confirmed', source: 's' },
  previous: { desk: 'agent_ops', start: '2026-10-06T12:00:00+00:00', end: '2026-10-09T12:00:00+00:00', seconds: 3 * D, quality: 'estimated', source: 's' },
  request_start: '2026-10-06T12:00:00+00:00', total_seconds: 13 * D, quality: 'estimated', evidence: [], as_of: '2026-10-19T12:00:00+00:00',
});
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe('RentTimingRow', () => {
  it('shows the server strings unchanged, with the own-desk wording', () => {
    const row = timingRow(timing!, { ownDesk: true });
    wrap(<RentTimingRow requestId="r1" timing={timing} ownDesk />);
    expect(screen.getByTestId('timing-current').textContent).toContain('On your desk');
    expect(screen.getByTestId('timing-current').textContent).toContain(row.current.value);
    expect(screen.getByTestId('timing-total').textContent).toContain('Total in system');
    expect(screen.getByTestId('timing-total').textContent).toContain('13 d');
    expect(screen.getByTestId('timing-previous').textContent).toContain('Before: Agent Ops');
    expect(rpc).not.toHaveBeenCalled(); // journey is fetched only when opened
  });
  it('shows a skeleton while loading', () => {
    wrap(<RentTimingRow requestId="r1" loading />);
    expect(screen.getByTestId('timing-loading')).toBeTruthy();
  });
  it('shows an error with Retry', () => {
    const onRetry = vi.fn();
    wrap(<RentTimingRow requestId="r1" error={new Error('x')} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });
});
