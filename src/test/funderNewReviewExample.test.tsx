import { describe, it, expect, vi } from 'vitest';
// The sales sheet prices its worked example at the viewer's own rate (15 while the switch is off).
vi.mock('@/hooks/usePartnerQuoteRate', () => ({
  useOwnNewPortfolioRate: () => ({ rate: 15, isLoading: false }),
}));
// The sheet now shows why float is held (co-support, booked houses); those hooks talk to Supabase.
// This test is about the worked example only, so no client and no holds.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/hooks/useFunderSavedTabs', () => ({
  useFunderFloatHolds: () => ({ breakdown: null, line: null, tab: null, isLoading: false, error: null }),
}));
import { render, screen } from '@testing-library/react';
import { FunderNewReviewDialog } from '@/components/funder-new/FunderNewSelectionPanel';
import { supportExampleStepsAt } from '@/lib/supportPlanExample';

// Today's figures: the steps at the switch-off rate (15) read exactly as the old fixed-15% steps.
const SUPPORT_EXAMPLE_STEPS = supportExampleStepsAt(15);
import type { FunderNewSelectionItem } from '@/components/funder-new/types';

const item: FunderNewSelectionItem = {
  id: 'abc-123',
  category: 'ready',
  title: 'Test House',
  place: 'Test Area',
  amount: 700000,
  monthlyReturn: 105000,
  termLabel: '12 months',
  imageUrl: null,
  tenantName: 'Test Tenant',
};

function renderSheet() {
  return render(
    <FunderNewReviewDialog
      open
      onOpenChange={vi.fn()}
      items={[item]}
      available={1000000}
      walletLoading={false}
      walletError={null}
      onRemove={vi.fn()}
    />,
  );
}

describe('in-app Support Plan sheet worked example', () => {
  it('shows the five example steps', () => {
    renderSheet();
    expect(screen.getByText('How it works — example')).toBeTruthy();
    for (const step of SUPPORT_EXAMPLE_STEPS) {
      expect(screen.getByText(step)).toBeTruthy();
    }
  });

  it('shows the for-this-plan line built from the selected home amount', () => {
    renderSheet();
    expect(
      screen.getByText(
        'Support UGX 700,000 → earn UGX 105,000/month for 12 months → then renew or withdraw your UGX 700,000',
      ),
    ).toBeTruthy();
  });
});
