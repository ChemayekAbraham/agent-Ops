import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

let state: { data?: { total_plans: number } } = {};
vi.mock('@/hooks/tenantOpsWorkspace/useLandlordNotPaid', () => ({
  useLandlordNotPaid: () => state,
}));

import WorkspaceClockNote from './WorkspaceClockNote';

describe('WorkspaceClockNote', () => {
  beforeEach(() => { state = {}; });

  it('always says where the clock starts, and never shows a zero while the count loads', () => {
    render(<WorkspaceClockNote />);
    expect(screen.getByText('Counted from the day after the landlord was paid')).toBeTruthy();
    expect(screen.queryByTestId('workspace-landlord-not-paid')).toBeNull();
  });

  it('shows how many plans are not counted as owing', () => {
    state = { data: { total_plans: 82 } };
    render(<WorkspaceClockNote />);
    expect(screen.getByTestId('workspace-landlord-not-paid').textContent).toBe(
      'Landlord not paid yet: 82 plans (not counted as owing)',
    );
  });

  it('uses the singular for one plan', () => {
    state = { data: { total_plans: 1 } };
    render(<WorkspaceClockNote />);
    expect(screen.getByTestId('workspace-landlord-not-paid').textContent).toContain('1 plan (not');
  });
});
