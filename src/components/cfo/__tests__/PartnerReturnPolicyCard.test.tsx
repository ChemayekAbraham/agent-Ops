import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  enabledRoles: ['cfo'] as string[],
  toastSuccess: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => mocks.rpc(...args) },
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ enabledRoles: mocks.enabledRoles, roles: mocks.enabledRoles, user: { id: 'cfo-user' } }),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
// The shared setup stubs haptics without hapticImpact, which the Switch calls.
vi.mock('@/lib/haptics', () => ({ hapticTap: () => {}, hapticSelection: () => {}, hapticImpact: () => {} }));

import { PartnerReturnPolicyCard } from '../PartnerReturnPolicyCard';
import { PARTNER_RETURN_POLICY_QUERY_KEY } from '@/hooks/usePartnerReturnPolicy';

const OFF = { enabled: false, new_contract_rate: 15, policy_rate: 10, legacy_rate: 15, enabled_at: null, updated_at: '2026-11-05T07:00:00Z' };
const ON = { ...OFF, enabled: true, new_contract_rate: 10, enabled_at: '2026-11-05T09:00:00Z', updated_at: '2026-11-05T09:00:00Z' };

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  render(<PartnerReturnPolicyCard />, { wrapper });
  return { invalidate };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.enabledRoles = ['cfo'];
  let current = OFF;
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'get_partner_return_policy') return { data: current, error: null };
    if (fn === 'set_partner_return_policy') { current = ON; return { data: ON, error: null }; }
    return { data: null, error: null };
  });
});

describe('PartnerReturnPolicyCard', () => {
  it('shows the switch state and the rate new contracts earn', async () => {
    renderCard();
    expect(await screen.findByText('Off')).toBeInTheDocument();
    expect(screen.getByText('15%', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Partner Returns switch' })).not.toBeChecked();
  });

  it('confirms the effect, calls set_partner_return_policy and refreshes the policy', async () => {
    const { invalidate } = renderCard();
    fireEvent.click(await screen.findByRole('switch', { name: 'Partner Returns switch' }));
    expect(await screen.findByText(/Every new portfolio, including a new one for an existing partner, earns 10%/)).toBeInTheDocument();
    expect(screen.getByText(/Top-ups and existing portfolios keep their own rate/)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('set_partner_return_policy', expect.anything());
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Board decision' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('set_partner_return_policy', { p_enabled: true, p_note: 'Board decision' }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: PARTNER_RETURN_POLICY_QUERY_KEY }));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Partner Returns switch is on', expect.anything());
    expect(await screen.findByText('On')).toBeInTheDocument();
  });

  it('keeps the dialog open and explains an authenticator error', async () => {
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'get_partner_return_policy'
      ? { data: OFF, error: null }
      : { data: null, error: { message: 'mfa_required: verify with your authenticator app to continue' } }));
    renderCard();
    fireEvent.click(await screen.findByRole('switch', { name: 'Partner Returns switch' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Two-step verification needed/);
  });

  it('is read-only for roles that cannot flip the switch', async () => {
    mocks.enabledRoles = ['coo'];
    renderCard();
    expect(await screen.findByRole('switch', { name: 'Partner Returns switch' })).toBeDisabled();
    expect(screen.getByText(/Only the CFO, CEO or Super Admin/)).toBeInTheDocument();
  });
});
