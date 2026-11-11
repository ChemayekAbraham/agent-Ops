import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FunderFundChooser } from './FunderFundChooser';
import { supportWhatsAppUrl } from '@/lib/funderFundChoice';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useSelfSupportFeePolicy', () => ({
  useSelfSupportFeePolicy: () => ({
    policy: { enabled: true, rate: 0.02, roundTo: 100 },
    enabled: true,
    ratePct: 2,
    pay: (rent: number) => rent,
    fee: (rent: number) => Math.round(rent * 0.02),
    isLoading: false,
  }),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), auth: { getUser: vi.fn() }, storage: { from: vi.fn() } } }));

const contact = vi.hoisted(() => vi.fn());
vi.mock('@/lib/funderFundChoice', async () => {
  const actual = await vi.importActual<typeof import('@/lib/funderFundChoice')>('@/lib/funderFundChoice');
  return { ...actual, fetchLandlordPayoutContact: contact };
});

function renderChooser() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FunderFundChooser
        open
        onOpenChange={vi.fn()}
        onThroughWelile={vi.fn()}
        target={{ rentRequestId: 'plan-1', title: 'Single room in Kira', place: 'Kira', landlordName: 'Okello', rentAmount: 300000 }}
      />
    </QueryClientProvider>,
  );
}

describe('fund chooser', () => {
  it('builds a WhatsApp link that names the plan', () => {
    const url = supportWhatsAppUrl({ rentRequestId: 'plan-1', title: 'Single room' });
    expect(url.startsWith('https://wa.me/256777607640?text=')).toBe(true);
    expect(decodeURIComponent(url)).toContain('plan-1');
    expect(url).not.toContain('\u2014');
  });

  it('hides direct payment until the plan is verified', async () => {
    contact.mockResolvedValue({ state: 'hidden' });
    renderChooser();
    expect(await screen.findByText(/after this Rent Plan is verified/i)).toBeInTheDocument();
    expect(screen.getByText('Fund this house through Welile')).toBeInTheDocument();
    expect(screen.getByText('Contact Welile Tenant Partnership Support Team')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send directly/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Take cash/i })).toBeNull();
    expect(screen.getByText('Contact Welile Tenant Partnership Support Team').closest('button')?.textContent || '').not.toMatch(/Welile Cover/);
  });

  it('offers mobile money and cash when payout details exist', async () => {
    contact.mockResolvedValue({
      state: 'ready',
      contact: {
        landlordName: 'Okello',
        landlordPhone: '0700111222',
        payoutMomoNumber: '0777000111',
        payoutMomoName: 'Okello Peter',
        location: 'Kira',
      },
    });
    renderChooser();
    expect(await screen.findByRole('button', { name: /Send directly to the landlord/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Take cash to the landlord/i })).toBeInTheDocument();
  });
});
