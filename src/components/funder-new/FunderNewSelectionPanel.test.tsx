import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FunderNewReviewDialog } from './FunderNewSelectionPanel';
import type { FunderNewSelectionItem } from './types';

describe('FunderNewReviewDialog', () => {
  const sampleItems: FunderNewSelectionItem[] = [
    {
      id: 'house-123',
      category: 'ready',
      title: 'Shop',
      place: 'Wakiso Town Council, KKONA',
      amount: 450000,
      imageUrl: null,
      monthlyReturn: null,
      termLabel: '',
    },
  ];

  it('renders correctly on open with re-structured stats and selected house', () => {
    const onOpenChange = vi.fn();
    const onRemove = vi.fn();
    const onTopUp = vi.fn();

    render(
      <FunderNewReviewDialog
        open={true}
        onOpenChange={onOpenChange}
        items={sampleItems}
        available={0}
        walletLoading={false}
        walletError={null}
        onRemove={onRemove}
        onTopUp={onTopUp}
      />
    );

    // Title & description
    expect(screen.getByText('Your support plan')).toBeInTheDocument();
    expect(
      screen.getByText('Check the homes you picked. Nothing is submitted from this screen.')
    ).toBeInTheDocument();

    // Stats
    expect(screen.getByText(/Total Support/i)).toBeInTheDocument();
    expect(screen.getAllByText('UGX 450,000')).toHaveLength(2); // once in total card, once in item row

    expect(screen.getByText(/Monthly at 15%/i)).toBeInTheDocument();
    expect(screen.getByText('UGX 67,500')).toBeInTheDocument();

    expect(screen.getByText(/Available Balance/i)).toBeInTheDocument();
    expect(screen.getByText('UGX 450,000 short')).toBeInTheDocument();

    // House item details
    expect(screen.getByText('Shop')).toBeInTheDocument();
    expect(screen.getByText('Wakiso Town Council, KKONA')).toBeInTheDocument();
    expect(screen.getByText('Tenant ready')).toBeInTheDocument();

    // CTA Button for shortfall
    const topUpBtn = screen.getByRole('button', { name: /Top up Now/i });
    expect(topUpBtn).toBeInTheDocument();
    fireEvent.click(topUpBtn);
    expect(onTopUp).toHaveBeenCalledWith(450000);
  });

  it('renders "Fully covered" and "Fund this plan" when balance is sufficient', () => {
    const onOpenChange = vi.fn();
    const onFund = vi.fn();

    render(
      <FunderNewReviewDialog
        open={true}
        onOpenChange={onOpenChange}
        items={sampleItems}
        available={500000}
        walletLoading={false}
        walletError={null}
        onRemove={vi.fn()}
        onFund={onFund}
      />
    );

    expect(screen.getByText('Fully covered')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fund this plan/i })).toBeInTheDocument();
  });
});
