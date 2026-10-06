import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MerchandiseStore from '@/pages/MerchandiseStore';

let mockBikeLeases: any[] = [];
let mockPhoneOrders: any[] = [];
let mockPlans: any[] = [];

// Mock dependencies
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: () => ({
      on: () => ({ subscribe: () => ({}) }),
    }),
    removeChannel: () => ({}),
    from: (table: string) => ({
      select: () => {
        if (table === 'merchandise_catalog') {
          return {
            eq: () => ({
              order: () => Promise.resolve({
                data: [
                  { id: 'item-1', item_name: 'Welile T-Shirt', unit_price: 25000, is_active: true, sizes: ['M', 'L'] },
                ],
              }),
            }),
          };
        }
        if (table === 'merchandise_sales') {
          return {
            select: () => ({
              in: () => Promise.resolve({ data: [] }),
            }),
            eq: () => ({
              ilike: () => ({
                order: () => Promise.resolve({ data: mockPhoneOrders }),
              }),
              in: () => ({
                order: () => Promise.resolve({ data: mockPhoneOrders }),
              }),
            }),
          };
        }
        if (table === 'merchandise_recovery_plans') {
          return {
            eq: () => ({
              order: () => Promise.resolve({ data: mockPlans }),
            }),
          };
        }
        return {
          eq: () => ({
            order: () => Promise.resolve({ data: [] }),
            limit: () => Promise.resolve({ data: [] }),
            maybeSingle: () => Promise.resolve({ data: null }),
          }),
        };
      },
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'test-agent-123' },
    loading: false,
  }),
}));

vi.mock('@/hooks/useAgentBalances', () => ({
  useAgentBalances: () => ({
    withdrawableBalance: 500000,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/wallet/useWalletBalance', () => ({
  fetchWalletBalance: vi.fn().mockResolvedValue({ withdrawable: 500000 }),
}));

vi.mock('@/hooks/useMerchandiseOrderLock', () => ({
  useMerchandiseOrderLock: () => ({ repaying: false }),
}));

vi.mock('@/hooks/useBikeLeases', () => ({
  fetchMyBikeLeases: vi.fn().mockImplementation(() => Promise.resolve(mockBikeLeases)),
}));

vi.mock('@/hooks/useMerchandiseRepaymentPortfolio', () => ({
  useMerchandiseRepaymentPortfolio: () => ({
    activePlans: [],
    plans: [],
    deductions: [],
    totalOutstanding: 0,
    totalPaid: 0,
  }),
  useDeleteMerchandiseApplication: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  usePayMerchandisePlan: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

function renderWithClient(ui: React.ReactElement, initialEntries = ['/merchandise']) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        {ui}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('MerchandiseStore Component', () => {
  it('renders store heading and main sections without crashing', async () => {
    mockBikeLeases = [];
    mockPhoneOrders = [];
    mockPlans = [];
    renderWithClient(<MerchandiseStore />);
    expect(screen.getByText(/What do you want to buy\?/i)).toBeDefined();
    expect(screen.getByText(/Order a Welile Smartphone/i)).toBeDefined();
    expect(screen.getByText(/Apply for an electric bike/i)).toBeDefined();
  });

  it('renders My Orders tab when user has active/pending/rejected orders', async () => {
    mockBikeLeases = [
      {
        id: 'bike-1',
        model_type: 'Spiro Commando',
        valuation_amount: 3200000,
        amount_outstanding: 3200000,
        order_status: 'pending_approval',
        created_at: new Date().toISOString(),
      },
    ];
    mockPhoneOrders = [];
    mockPlans = [];

    renderWithClient(<MerchandiseStore />);
    // Tab switcher should be visible because totalOrdersCount > 0
    const ordersTabButton = await screen.findByRole('button', { name: /My Orders/i });
    expect(ordersTabButton).toBeDefined();

    // Clicking My Orders switches view
    fireEvent.click(ordersTabButton);
    expect(screen.getByRole('button', { name: /^All/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^Pending/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^Approved/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^Rejected/i })).toBeDefined();
  });

  it('switches between status filters cleanly', async () => {
    mockBikeLeases = [
      {
        id: 'bike-rejected',
        model_type: 'Spiro Commando',
        valuation_amount: 3200000,
        amount_outstanding: 0,
        order_status: 'rejected',
        rejection_reason: 'Ineligible credit profile',
        created_at: new Date().toISOString(),
      },
    ];

    renderWithClient(<MerchandiseStore />);
    const ordersTabButton = await screen.findByRole('button', { name: /My Orders/i });
    fireEvent.click(ordersTabButton);

    const rejectedButton = screen.getByRole('button', { name: /Rejected/i });
    fireEvent.click(rejectedButton);

    expect(screen.getByText(/Spiro bike lease status/i)).toBeDefined();
  });
});
