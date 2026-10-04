import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

/**
 * Integration test for the rent-request house picker "Undo" flow.
 *
 * Renders the real AgentRentRequestDialog, searches for a house, selects the
 * matched landlord/house, then clicks "Undo" and verifies:
 *   1. the inline "Landlord & house selected" panel fully resets, and
 *   2. the picker re-opens with the previous search query preserved.
 *
 * The component is large and talks to many services, so heavy hooks/children
 * are mocked. The picker, selectHouse and undoSelectHouse logic under test run
 * for real.
 */

// --- House the picker should find ---
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

// --- Chainable Supabase mock ---
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

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'agent-1' } }),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/hooks/useAgentCapacityMap', () => ({
  useAgentCapacityMap: () => ({ data: new Map(), isLoading: false }),
  DAILY_ELIGIBILITY_THRESHOLD: 0.2,
  NEW_AGENT_TENANT_THRESHOLD: 10,
  NEW_AGENT_RENT_CAP_UGX: 2_000_000,
}));

vi.mock('@/hooks/useExistingTenantByPhone', () => ({
  useExistingTenantByPhone: () => ({ match: null, checking: false }),
}));

// --- Light stubs for heavy children (not exercised in this flow) ---
vi.mock('@/components/agent/ListEmptyHouseDialog', () => ({ ListEmptyHouseDialog: () => null }));
vi.mock('@/components/agent/RegisterLandlordDialog', () => ({ __esModule: true, default: () => null }));
vi.mock('@/components/agent/LandlordSearchSelect', () => ({ LandlordSearchSelect: () => null }));
vi.mock('@/components/agent/GuarantorConsentCheckbox', () => ({ GuarantorConsentCheckbox: () => null }));
vi.mock('@/components/agent/ExistingTenantPhoneNotice', () => ({ ExistingTenantPhoneNotice: () => null }));
vi.mock('@/components/executive/EntityDetailSheet', () => ({ EntityDetailSheet: () => null }));
vi.mock('@/components/shared/DailyRatingThresholdPopover', () => ({ DailyRatingThresholdPopover: () => null }));

import AgentRentRequestDialog from './AgentRentRequestDialog';

function renderDialog() {
  return render(
    <AgentRentRequestDialog
      open
      onOpenChange={() => {}}
      prefillDraft={{ incomeType: 'daily' }}
    />,
  );
}

const SEARCH_PLACEHOLDER = 'Landlord name, phone, region, or description';

describe('AgentRentRequestDialog — Undo house selection (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reopens the picker and fully resets the inline panel after Undo', async () => {
    renderDialog();

    // Picker is shown at the first details step.
    const input = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);

    // Search for the house and select the matched landlord/house.
    fireEvent.change(input, { target: { value: 'Sunrise' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const result = await screen.findByText('Sunrise Apartments');
    fireEvent.click(result.closest('button')!);

    // Inline confirmation panel appears with the matched landlord details.
    const selectedPanel = await screen.findByText('Landlord & house selected');
    const panel = selectedPanel.closest('div')!.parentElement as HTMLElement;
    expect(within(panel).getByText('Jane Landlord')).toBeInTheDocument();

    // While selected, the search input is hidden.
    expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull();

    // Click Undo.
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));

    // Inline panel is gone and the picker re-opens with the query preserved.
    await waitFor(() => {
      expect(screen.queryByText('Landlord & house selected')).toBeNull();
    });
    const reopenedInput = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
    expect((reopenedInput as HTMLInputElement).value).toBe('Sunrise');
  });
});
