import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * TEMPORARY check (deleted after running): the "Quick fill from a tenant you
 * already registered" block and its auto-fill logic were removed from the post
 * rent request form. This renders the real dialog, drives it to the Tenant
 * Details step, and asserts the block is gone.
 */

const HOUSE = {
  id: 'house-1',
  title: 'Sunrise Apartments',
  address: 'Plot 5 Kira Road',
  region: 'Kampala',
  district: 'Kampala',
  house_category: 'single_room',
  monthly_rent: 300000,
  short_code: 'SUN1',
  latitude: 0.34,
  longitude: 32.58,
  landlord_id: 'll-1',
  tenant_id: null,
  reserved_at: null,
  is_hidden: false,
  status: 'available',
  image_urls: ['https://example.com/house.jpg'],
};

const TABLE_DATA: Record<string, any[]> = {
  house_listings: [HOUSE],
  landlords: [{ id: 'll-1', name: 'Jane Landlord', phone: '0772123456' }],
};

vi.mock('@/integrations/supabase/client', () => {
  const makeBuilder = (table: string) => {
    const data = TABLE_DATA[table] ?? [];
    const builder: any = {};
    const chain = [
      'select', 'eq', 'is', 'order', 'limit', 'or', 'in', 'neq',
      'gte', 'lte', 'not', 'update', 'insert', 'delete', 'ilike', 'contains',
    ];
    chain.forEach((m) => { builder[m] = vi.fn(() => builder); });
    builder.maybeSingle = vi.fn(() => Promise.resolve({ data: data[0] ?? null, error: null }));
    builder.single = vi.fn(() => Promise.resolve({ data: data[0] ?? null, error: null }));
    builder.then = (onF: any, onR: any) =>
      Promise.resolve({ data, error: null }).then(onF, onR);
    return builder;
  };
  return {
    supabase: {
      from: vi.fn((table: string) => makeBuilder(table)),
      rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
      functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) },
      auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })) },
    },
  };
});

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'agent-1' } }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useAgentCapacityMap', () => ({
  useAgentCapacityMap: () => ({ data: new Map(), isLoading: false }),
  DAILY_ELIGIBILITY_THRESHOLD: 0.2,
  NEW_AGENT_TENANT_THRESHOLD: 10,
  NEW_AGENT_RENT_CAP_UGX: 2_000_000,
}));
vi.mock('@/hooks/useExistingTenantByPhone', () => ({
  useExistingTenantByPhone: () => ({ match: null, checking: false }),
}));
vi.mock('@/components/agent/ListEmptyHouseDialog', () => ({ ListEmptyHouseDialog: () => null }));
vi.mock('@/components/agent/RegisterLandlordDialog', () => ({ __esModule: true, default: () => null }));
vi.mock('@/components/agent/LandlordSearchSelect', () => ({ LandlordSearchSelect: () => null }));
vi.mock('@/components/agent/GuarantorConsentCheckbox', () => ({ GuarantorConsentCheckbox: () => null }));
vi.mock('@/components/agent/ExistingTenantPhoneNotice', () => ({ ExistingTenantPhoneNotice: () => null }));
vi.mock('@/components/executive/EntityDetailSheet', () => ({ EntityDetailSheet: () => null }));
vi.mock('@/components/shared/DailyRatingThresholdPopover', () => ({ DailyRatingThresholdPopover: () => null }));

import AgentRentRequestDialog from './AgentRentRequestDialog';

const SEARCH_PLACEHOLDER = 'Landlord name, phone, region, or description';

describe('post rent request — quick-fill block removed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Tenant Details with no quick-fill picker', async () => {
    render(
      <AgentRentRequestDialog
        open
        onOpenChange={() => {}}
        prefillDraft={{ incomeType: 'daily' }}
      />,
    );

    const input = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'Sunrise' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const result = await screen.findByText('Sunrise Apartments');
    fireEvent.click(result.closest('button')!);
    await screen.findByText('Landlord & house selected');

    fireEvent.change(screen.getByPlaceholderText('500,000'), { target: { value: '300000' } });
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));

    // Tenant Details step is on screen...
    await waitFor(() => expect(screen.getByText('Tenant Details')).toBeInTheDocument());

    // ...and the removed quick-fill block is nowhere on it.
    expect(screen.queryByText(/Quick fill/i)).toBeNull();
    expect(screen.queryByText(/Tap to pick an existing tenant/i)).toBeNull();
    expect(screen.queryByText(/already registered/i)).toBeNull();
  });
});
