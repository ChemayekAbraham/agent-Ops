/**
 * A note the partner opened from its link is stored as "activated" but is not approved: no bonus, no partner
 * commission. Partner Ops must still find it under "Awaiting review" with an Approve button (Isaac Mwaka's notes,
 * 12 Nov 2026), and it must not show as Approved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

const notes = [
  { id: 'n1', partner_name: 'Patience Ogwal', agent_name: 'Mwaka Isaac', status: 'activated', approval_bonus_paid: false,
    amount: 5_000_000, total_collected: 0, outstanding: 5_000_000, created_at: '2026-11-04T19:10:13Z' },
  { id: 'n2', partner_name: 'Beatrice Akello', agent_name: 'Julius Wantali', status: 'pending', approval_bonus_paid: false,
    amount: 500_000, total_collected: 0, outstanding: 500_000, created_at: '2026-11-09T11:10:42Z' },
  { id: 'n3', partner_name: 'Approved Partner', agent_name: 'Julius Wantali', status: 'activated', approval_bonus_paid: true,
    amount: 50_000, total_collected: 0, outstanding: 50_000, created_at: '2026-11-05T11:00:00Z' },
];

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('@/components/executive/PromissoryNotesQueue', () => ({ AgentCallMenu: () => null }));
vi.mock('@/hooks/usePromissoryOpsReport', () => ({
  PROMISSORY_RANGES: [{ key: 'all', label: 'All time' }],
  usePromissoryOpsReport: () => ({
    report: { kpis: { notes_count: notes.length, promised_total: 5_550_000 }, notes },
    isLoading: false,
    range: 'all',
    setRange: vi.fn(),
  }),
}));

import { PromissoryNotesOverviewCard } from './PromissoryNotesOverviewCard';

function renderCard() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <PromissoryNotesOverviewCard onOpen={vi.fn()} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('promissory-overview-collapsed-v2', 'false');
});

describe('PromissoryNotesOverviewCard: notes opened from the link but never approved', () => {
  it('counts them as awaiting review and offers Approve, not Reject', () => {
    renderCard();
    expect(screen.getByText('2 awaiting review')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve Patience Ogwal' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve Beatrice Akello' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve Approved Partner' })).toBeNull();
  });

  it('keeps them out of Approved', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /^Approved/ }));
    expect(screen.getByRole('button', { name: 'Reject Approved Partner' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reject Patience Ogwal' })).toBeNull();
  });

  it('shows Approve & Pay in the details of such a note, and calls it awaiting review', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'View details for Patience Ogwal' }));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: /Approve & Pay/ })).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: /Reject & Reverse Bonus/ })).toBeNull();
    expect(within(sheet).getByText('Awaiting review')).toBeTruthy();
  });
});
