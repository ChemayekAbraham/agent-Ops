import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

let state: { data?: unknown } = {};
vi.mock('@/hooks/useAmClockDrift', () => ({ useAmClockDrift: () => state }));

import { ClockDriftLine } from './ClockDriftLine';

const status = (over: Record<string, unknown> = {}) => ({
  run_date: '2026-10-13', run_at: '2026-10-13T03:00:00Z', plans_checked: 957, plans_differ: 0, plans_explained: 2,
  due_diff_ugx: 0, arrears_diff_ugx: 0, ...over,
});

describe('ClockDriftLine', () => {
  beforeEach(() => { state = {}; });

  it('shows nothing until a check has run', () => {
    render(<ClockDriftLine />);
    expect(screen.queryByTestId('clock-drift-line')).toBeNull();
  });

  it('says the pages agree', () => {
    state = { data: status() };
    render(<ClockDriftLine />);
    expect(screen.getByTestId('clock-drift-line').textContent).toBe('Pages agree \u00b7 2 hand-set starts kept \u00b7 checked 2026-10-13');
  });

  it('says how many plans differ', () => {
    state = { data: status({ plans_differ: 4 }) };
    render(<ClockDriftLine />);
    const el = screen.getByTestId('clock-drift-line');
    expect(el.textContent).toBe('4 plans differ \u00b7 checked 2026-10-13');
    expect(el.className).toContain('text-destructive');
  });
});
