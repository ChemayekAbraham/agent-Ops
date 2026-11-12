import { describe, it, expect, vi } from 'vitest';
// The sales sheet prices its worked example at the viewer's own rate (15 while the switch is off).
vi.mock('@/hooks/useFunderSavedTabs', () => ({
  useFunderFloatHolds: () => ({ line: null, tab: null, breakdown: null, isLoading: false, error: null }),
}));
vi.mock('@/hooks/usePartnerQuoteRate', () => ({
  useOwnNewPortfolioRate: () => ({ rate: 15, isLoading: false }),
}));
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
    // The visible description line was removed; only the screen-reader
    // description remains under the title.
    expect(
      screen.queryByText('Check the homes you picked. Nothing is submitted from this screen.')
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Review the homes you picked. Nothing is submitted from this screen.')
    ).toBeInTheDocument();

    // Stats
    expect(screen.getByText(/Total Support/i)).toBeInTheDocument();
    expect(screen.getAllByText('UGX 450,000')).toHaveLength(2); // once in total card, once in item row

    expect(screen.getByText(/Monthly Rent profit share \(15%\)/i)).toBeInTheDocument();
    expect(screen.getByText('UGX 67,500')).toBeInTheDocument();

    expect(screen.getByText(/Available operational float/i)).toBeInTheDocument();
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

  it('shows the agent release receipt without tenant or agent phone numbers', async () => {
    const onFund = vi.fn().mockResolvedValue({
      submitted: true,
      reference: 'ref-1',
      releasedToAgent: true,
      landlordNames: ['Lou'],
      rentRequestIds: ['h1'],
    });
    render(
      <FunderNewReviewDialog
        open
        onOpenChange={vi.fn()}
        items={[{
          ...sampleItems[0],
          landlordName: 'Lou',
          tenantPhone: '0759 229 748',
          agentPhone: '+256772123456',
        }]}
        available={500000}
        walletLoading={false}
        walletError={null}
        onRemove={vi.fn()}
        onFund={onFund}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Fund this plan/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm and support/i }));
    const sentences = await screen.findAllByText('Your rent has gone to the agent, who will pay the landlord within 24 hours.');
    expect(sentences.length).toBeGreaterThan(0);
    const receipt = sentences[0].closest('[role="dialog"]');
    expect(receipt).not.toBeNull();
    expect(receipt?.textContent).toContain('Lou');
    expect(receipt?.textContent).toContain('ref-1');
    expect(screen.getByRole('button', { name: /Download receipt/i })).toBeInTheDocument();
    expect(receipt?.textContent || '').not.toContain('0759 229 748');
    expect(receipt?.textContent || '').not.toContain('+256772123456');
    expect(receipt?.textContent || '').not.toMatch(/\u2014/);
  });
});

describe('Support plan WhatsApp contacts', () => {
  it('links valid numbers to wa.me in 256 digits form and hides missing ones', () => {
    render(
      <FunderNewReviewDialog
        open={true}
        onOpenChange={vi.fn()}
        items={[{
          id: 'h1', category: 'ready', title: 'Shop', place: 'Wakiso', amount: 100000,
          imageUrl: null, monthlyReturn: null, termLabel: '',
          tenantName: 'Tina', tenantPhone: '0759 229 748',
          landlordName: 'Lou', landlordPhone: null,
          agentName: 'Ali', agentPhone: '+256772123456',
        } as any]}
        available={0}
        walletLoading={false}
        walletError={null}
        onRemove={vi.fn()}
      />
    );
    expect(screen.getByRole('link', { name: 'WhatsApp Tenant' })).toHaveAttribute('href', 'https://wa.me/256759229748');
    expect(screen.getByRole('link', { name: 'WhatsApp Agent' })).toHaveAttribute('href', 'https://wa.me/256772123456');
    expect(screen.queryByRole('link', { name: 'WhatsApp Landlord' })).toBeNull();
    expect(screen.getByText('Not available')).toBeInTheDocument();
  });
});
