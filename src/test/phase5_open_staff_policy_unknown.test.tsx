/**
 * Partner Returns Phase 5, open item O2: a staff create form whose own policy read FAILED (switch
 * state unknown, not loading) must not submit an unedited rate. Sending nothing would let the gate
 * store the public rate, while with the switch actually off today's form sends its own prefill
 * (20, or 15 on the invite dialog). A typed rate may still go: the server answers 409 POLICY_CHANGED
 * unless the switch is off.
 *
 * Also pins the same loading/unknown guard on the COOPartnersPage bulk edit and the
 * ActivePartnersDetail save (rate push + orphan-portfolio insert).
 */
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc, functions: { invoke: mocks.invoke } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'staff-1' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

import { InvitePartnerPortfolioDialog } from '@/components/partner/InvitePartnerPortfolioDialog';
import {
  POLICY_LOADING_MESSAGE, POLICY_UNKNOWN_MESSAGE, staffRateSubmitBlock,
} from '@/lib/staffPortfolioRate';

describe('staffRateSubmitBlock', () => {
  it('waits while the form reads the policy', () => {
    expect(staffRateSubmitBlock({ isLoading: true, policyEnabled: null, edited: false })).toBe(POLICY_LOADING_MESSAGE);
    expect(staffRateSubmitBlock({ isLoading: true, policyEnabled: null, edited: true })).toBe(POLICY_LOADING_MESSAGE);
  });

  it('refuses an unedited rate when the read failed', () => {
    expect(staffRateSubmitBlock({ isLoading: false, policyEnabled: null, edited: false })).toBe(POLICY_UNKNOWN_MESSAGE);
    expect(POLICY_UNKNOWN_MESSAGE).toBe('The Returns rate could not be checked. Reload the page.');
  });

  it('lets a typed rate go when the read failed (the server re-checks the switch)', () => {
    expect(staffRateSubmitBlock({ isLoading: false, policyEnabled: null, edited: true })).toBeNull();
  });

  it('lets the form submit once the switch state is known, edited or not', () => {
    for (const policyEnabled of [true, false]) {
      for (const edited of [true, false]) {
        expect(staffRateSubmitBlock({ isLoading: false, policyEnabled, edited })).toBeNull();
      }
    }
  });
});

// ---- Rendered: InvitePartnerPortfolioDialog with a failing policy read -------------------------------
const partner = { id: 'p1', full_name: 'Test Partner', email: 'partner@example.com' };

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return render(<InvitePartnerPortfolioDialog open onOpenChange={() => {}} partner={partner} />, { wrapper: Wrapper });
}

const rateInput = () => document.getElementById('roi') as HTMLInputElement;
const amountInput = () => document.getElementById('amt') as HTMLInputElement;
const policyReads = () => mocks.rpc.mock.calls.filter(([fn]) => fn === 'get_partner_return_policy').length;

beforeEach(() => {
  localStorage.clear();
  mocks.rpc.mockReset();
  mocks.invoke.mockReset();
  mocks.toast.mockReset();
  mocks.invoke.mockResolvedValue({ data: { portfolio_code: 'WPF-1', partner_email: partner.email }, error: null });
  // The policy read fails (every attempt, including the hook's one retry); the partner's rate reads 20.
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === 'get_partner_return_policy'
      ? { data: null, error: new Error('network down') }
      : { data: 20, error: null });
});

/** Wait until the hook gave up (two attempts: the first read and its retry). */
async function waitForFailedRead() {
  await waitFor(() => expect(policyReads()).toBeGreaterThanOrEqual(2), { timeout: 5000 });
  // Let the error state settle after the last attempt.
  await new Promise((r) => setTimeout(r, 50));
}

describe('InvitePartnerPortfolioDialog: the policy read failed (O2)', () => {
  it('an unedited rate is refused with the reload message, and nothing is sent', async () => {
    renderDialog();
    await waitForFailedRead();
    fireEvent.change(amountInput(), { target: { value: '500000' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: POLICY_UNKNOWN_MESSAGE })));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('a typed rate is sent with policy_enabled_seen false (the server decides)', async () => {
    renderDialog();
    await waitForFailedRead();
    fireEvent.change(rateInput(), { target: { value: '15' } });
    fireEvent.change(amountInput(), { target: { value: '500000' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    const body = mocks.invoke.mock.calls[0][1].body as Record<string, unknown>;
    expect(body.roi_percentage).toBe(15);
    expect(body.policy_enabled_seen).toBe(false);
  });
});

// ---- Source pins: every staff form and staff edit uses the one helper --------------------------------
const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

describe('staff forms use staffRateSubmitBlock (one helper, not copies)', () => {
  const createForms: [string, string][] = [
    ['components/coo/COOPartnersPage.tsx', 'addPortfolioRate'],
    ['components/executive/NewPartnersPanel.tsx', 'rate'],
    ['components/manager/CreateInvestmentAccountDialog.tsx', 'rate'],
    ['components/partner/InvitePartnerPortfolioDialog.tsx', 'rate'],
  ];
  for (const [file, hook] of createForms) {
    it(`${file}: the create handler refuses before requestFields()`, () => {
      const code = src(file);
      const block = code.indexOf(`staffRateSubmitBlock(${hook})`);
      expect(block).toBeGreaterThan(-1);
      expect(code.indexOf(`${hook}.requestFields()`, block)).toBeGreaterThan(block);
      expect(code).not.toContain('The Returns rate is still loading');
      expect(code).not.toContain('could not be checked');
    });
  }

  for (const file of ['components/coo/COOPartnersPage.tsx', 'pages/coo/ActivePartnersDetail.tsx']) {
    it(`${file}: the partner edit (rate push / orphan insert) refuses before it writes`, () => {
      const code = src(file);
      const start = code.indexOf('async function handleSaveEdit()');
      expect(start).toBeGreaterThan(-1);
      const body = code.slice(start, code.indexOf('\n  }\n', start));
      const guard = body.indexOf('staffRateSubmitBlock({');
      expect(guard).toBeGreaterThan(-1);
      expect(body).toContain('isLoading: partnerReturnPolicy.isLoading');
      expect(body).toContain('policyEnabled: partnerReturnPolicy.enabled');
      expect(body).toContain('edited: editRoi.trim() !== String(editPartner.roiPercentage)');
      expect(guard).toBeLessThan(body.indexOf('setSaving(true)'));
      expect(guard).toBeLessThan(body.indexOf(".from('profiles')"));
    });
  }
});
