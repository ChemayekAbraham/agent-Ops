import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

// Desktop: the chat must present as a floating dialog, not a page takeover.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

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

function chatDialog(): HTMLElement {
  const dialog = screen.getByTestId('rent-request-chat').closest('[role="dialog"]');
  if (!dialog) throw new Error('chat dialog not found');
  return dialog as HTMLElement;
}

describe('Agent rent request chat on desktop', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('opens as a floating dialog instead of covering the whole page', async () => {
    renderChat();
    await screen.findByTestId('rent-request-chat');
    const dialog = chatDialog();
    // A 440px panel with no max-width cap is the floating dialog; the page
    // takeover it replaces set width/max-width to the full viewport.
    expect(dialog.style.width).toContain('440px');
    expect(dialog.style.height).toContain('760px');
    expect(dialog.style.maxWidth).toBe('none');
    expect(dialog.style.maxHeight).toBe('none');
  });

  it('keeps the panel rounded and bordered so it reads as a dialog', async () => {
    renderChat();
    await screen.findByTestId('rent-request-chat');
    const dialog = chatDialog();
    expect(dialog.className).toContain('rounded-3xl');
    expect(dialog.className).toContain('border-border');
    expect(dialog.className).not.toContain('rounded-none');
  });
});
