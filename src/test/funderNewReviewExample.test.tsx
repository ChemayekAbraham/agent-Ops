import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FunderNewReviewDialog } from '@/components/funder-new/FunderNewSelectionPanel';
import { SUPPORT_EXAMPLE_STEPS } from '@/lib/supportPlanExample';
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
