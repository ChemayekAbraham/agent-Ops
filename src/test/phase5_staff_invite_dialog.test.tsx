/**
 * Partner Returns Phase 5, staff forms (design v2 §6.1 staff form contract), InvitePartnerPortfolioDialog
 * handler: the create-portfolio-invite body follows useStaffPortfolioRate, and a 409 POLICY_CHANGED
 * shows the reload message and reads the policy again.
 *
 * Switch-off parity: with the switch seen off the field shows today's 15 and the body carries
 * roi_percentage 15 exactly as before (plus policy_enabled_seen: false, which the server ignores
 * while the switch is off).
 */
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
  toast: vi.fn(),
  user: { id: 'staff-1' } as null | { id: string },
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc, functions: { invoke: mocks.invoke } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

import { InvitePartnerPortfolioDialog } from '@/components/partner/InvitePartnerPortfolioDialog';
import { POLICY_CHANGED_MESSAGE } from '@/lib/staffPortfolioRate';

const partner = { id: 'p1', full_name: 'Test Partner', email: 'partner@example.com' };

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return render(<InvitePartnerPortfolioDialog open onOpenChange={() => {}} partner={partner} />, { wrapper: Wrapper });
}

/** get_partner_return_policy answers `enabled`; partner_quote_rate answers `personRate`. */
function route(enabled: boolean, personRate: number | null) {
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === 'get_partner_return_policy'
      ? { data: { enabled, new_contract_rate: enabled ? 10 : 15 }, error: null }
      : { data: personRate, error: null });
}

const rateInput = () => document.getElementById('roi') as HTMLInputElement;
const amountInput = () => document.getElementById('amt') as HTMLInputElement;
const policyReads = () => mocks.rpc.mock.calls.filter(([fn]) => fn === 'get_partner_return_policy').length;

async function send() {
  fireEvent.change(amountInput(), { target: { value: '500000' } });
  fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
  return mocks.invoke.mock.calls[0][1].body as Record<string, unknown>;
}

beforeEach(() => {
  localStorage.clear();
  mocks.rpc.mockReset();
  mocks.invoke.mockReset();
  mocks.toast.mockReset();
  mocks.invoke.mockResolvedValue({ data: { portfolio_code: 'WPF-1', partner_email: partner.email }, error: null });
});

describe('InvitePartnerPortfolioDialog: Returns rate in the invite request', () => {
  it("switch seen off: today's 15 prefill, always sent (parity)", async () => {
    route(false, 20);
    renderDialog();
    await waitFor(() => expect(rateInput().value).toBe('15'));
    const body = await send();
    expect(body.roi_percentage).toBe(15);
    expect(body.policy_enabled_seen).toBe(false);
    expect(body).toMatchObject({ partner_id: 'p1', amount: 500000, duration_months: 12, roi_mode: 'monthly_payout' });
  });

  it("switch on, not edited: prefill is the partner's own rate and no rate is sent", async () => {
    route(true, 20);
    renderDialog();
    await waitFor(() => expect(rateInput().value).toBe('20'));
    const body = await send();
    expect(body).not.toHaveProperty('roi_percentage');
    expect(body.policy_enabled_seen).toBe(true);
  });

  it('switch on, edited: the typed rate is sent (the server queues a different one for the CFO)', async () => {
    route(true, 20);
    renderDialog();
    await waitFor(() => expect(rateInput().value).toBe('20'));
    fireEvent.change(rateInput(), { target: { value: '12' } });
    const body = await send();
    expect(body.roi_percentage).toBe(12);
    expect(body.policy_enabled_seen).toBe(true);
  });

  it('switch on, partner rate unknown: blank field, nothing invented, no rate sent', async () => {
    route(true, null);
    renderDialog();
    await waitFor(() => expect(policyReads()).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByRole('button', { name: /send invite/i })).toBeTruthy());
    expect(rateInput().value).toBe('');
    const body = await send();
    expect(body).not.toHaveProperty('roi_percentage');
  });

  it('an invalid typed rate is refused before any request', async () => {
    route(true, 20);
    renderDialog();
    await waitFor(() => expect(rateInput().value).toBe('20'));
    fireEvent.change(rateInput(), { target: { value: '0' } });
    fireEvent.change(amountInput(), { target: { value: '500000' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('while this form has not read the policy yet nothing is sent (an unedited rate must not drop the switch-off 15)', async () => {
    mocks.rpc.mockImplementation(() => new Promise(() => {}));
    renderDialog();
    fireEvent.change(amountInput(), { target: { value: '500000' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('409 POLICY_CHANGED: the reload message, and the policy is read again', async () => {
    route(false, 20);
    const res = new Response(JSON.stringify({ code: 'POLICY_CHANGED', error: 'x' }), { status: 409 });
    mocks.invoke.mockResolvedValue({ data: null, error: { context: res } });
    renderDialog();
    await waitFor(() => expect(rateInput().value).toBe('15'));
    const before = policyReads();
    await send();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: POLICY_CHANGED_MESSAGE })));
    await waitFor(() => expect(policyReads()).toBeGreaterThan(before));
  });
});
