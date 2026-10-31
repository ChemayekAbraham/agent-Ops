import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/integrations/supabase/client', () => {
  const makeBuilder = () => {
    const builder: any = {};
    ['select', 'eq', 'is', 'order', 'limit', 'or', 'in', 'neq', 'gte', 'lte', 'not', 'update', 'insert', 'delete', 'ilike', 'contains']
      .forEach((m) => { builder[m] = vi.fn(() => builder); });
    builder.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    builder.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    builder.then = (onF: any, onR: any) => Promise.resolve({ data: [], error: null }).then(onF, onR);
    return builder;
  };
  return {
    supabase: {
      from: vi.fn(() => makeBuilder()),
      rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
      functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) },
      auth: {
        getUser: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })),
        getSession: vi.fn(() => Promise.resolve({ data: { session: { user: { id: 'agent-1' } } }, error: null })),
        refreshSession: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      },
    },
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'agent-1' } }),
}));

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }));

vi.mock('@/hooks/useAgentCapacityMap', () => ({
  useAgentCapacityMap: () => ({ data: new Map(), isLoading: false }),
  DAILY_ELIGIBILITY_THRESHOLD: 0.2,
}));

vi.mock('@/components/agent/ListEmptyHouseDialog', () => ({ ListEmptyHouseDialog: () => null }));
vi.mock('@/components/agent/RegisterLandlordDialog', () => ({ default: () => null }));
vi.mock('@/components/agent/LandlordSearchSelect', () => ({ LandlordSearchSelect: () => null }));
vi.mock('@/components/agent/GuarantorConsentCheckbox', () => ({
  GuarantorConsentCheckbox: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (v: boolean) => void }) => (
    <button type="button" onClick={() => onCheckedChange(!checked)}>guarantor consent</button>
  ),
}));
vi.mock('@/components/agent/ExistingTenantPhoneNotice', () => ({ ExistingTenantPhoneNotice: () => null }));
vi.mock('@/components/agent/TenantDuplicateNotice', () => ({ TenantDuplicateNotice: () => null }));
vi.mock('@/components/executive/EntityDetailSheet', () => ({ EntityDetailSheet: () => null }));
vi.mock('@/components/shared/DailyRatingThresholdPopover', () => ({ DailyRatingThresholdPopover: () => null }));
vi.mock('@/components/agent/AgentEditRentRequestDialog', () => ({ AgentEditRentRequestDialog: () => null }));

import AgentRentRequestDialog from './AgentRentRequestDialog';

function renderChat() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AgentRentRequestDialog presentation="chat" open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe('Agent rent request chat', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('opens on the income-type question and walks into rent, then blocks an empty amount', async () => {
    renderChat();

    expect(await screen.findByTestId('rent-request-chat')).toBeInTheDocument();
    expect(screen.getByText('How does this tenant pay rent?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));

    expect(await screen.findByText('What is the rent, and how long will they repay?')).toBeInTheDocument();
    expect(screen.getByText('Daily')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Type the rent amount');

    fireEvent.change(screen.getByPlaceholderText('500,000'), { target: { value: '300000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Does this tenant have a smartphone?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Outstanding' })).toBeNull();
  });

  it('offers Outstanding as its own first question path', async () => {
    renderChat();
    fireEvent.click(await screen.findByRole('button', { name: 'Outstanding' }));
    expect(await screen.findByText('Who is the landlord for this outstanding balance?')).toBeInTheDocument();
  });
});
