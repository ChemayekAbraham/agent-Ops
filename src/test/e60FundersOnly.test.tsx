import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/*
 * E60: Welile does not fund tenants directly (E60_FUNDERS_ONLY), and nobody
 * approves their own funding (E60_SELF_APPROVAL). The CFO screens no longer
 * fund with Welile money, and coded refusals reach the screen word for word.
 */

const invoke = vi.fn();
const rows = [
  { id: 'r1', rent_amount: 650000, tenant_id: '11111111-1111-4111-8111-111111111111', status: 'coo_approved', created_at: '2026-11-08T08:00:00Z' },
  { id: 'r2', rent_amount: 900000, tenant_id: '22222222-2222-4222-8222-222222222222', status: 'coo_approved', created_at: '2026-11-09T08:00:00Z' },
];
const chain = (data: unknown) => {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order']) c[m] = () => c;
  (c as { then: unknown }).then = (ok: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(ok);
  return c;
};
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t === 'rent_requests' ? rows : [{ id: '11111111-1111-4111-8111-111111111111', full_name: 'Amina Nakato' }, { id: '22222222-2222-4222-8222-222222222222', full_name: 'Joseph Ssemanda' }]),
    rpc: () => Promise.resolve({ data: [], error: null }),
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
  },
}));

import { BatchPayoutProcessor, NEEDS_FUNDER_PICK } from '@/components/cfo/BatchPayoutProcessor';
import { readableError } from '@/pages/desk/reviewApi';
import { partnerLead, toPartnerBoard } from '@/pages/desk/partner/partnerApi';

const FUNDERS_ONLY = "E60_FUNDERS_ONLY: Welile does not fund tenants directly. A funder, or Welile's own funder account, must select this tenant on the funders dashboard.";
const SELF_APPROVAL = 'E60_SELF_APPROVAL: you cannot approve your own funding. Another Partner Ops approver must approve it.';

describe('coded refusals reach the screen as-is', () => {
  it('readableError keeps E60 messages, even when raised as 42501', () => {
    expect(readableError({ code: 'P0001', message: FUNDERS_ONLY })).toBe(FUNDERS_ONLY);
    expect(readableError({ code: '42501', message: SELF_APPROVAL })).toBe(SELF_APPROVAL);
    // Other 42501s still read as before.
    expect(readableError({ code: '42501', message: 'permission denied for table x' })).not.toBe('permission denied for table x');
  });

  it('the funding and approval edge functions pass coded guards through unchanged', () => {
    const fund = readFileSync(resolve(__dirname, '../../supabase/functions/fund-agent-landlord-float/index.ts'), 'utf8');
    expect(fund).toContain(FUNDERS_ONLY);
    expect(fund).toMatch(/if \(\/\^E\\d\+_\[A-Z_\]\+:\/\.test\(raw\)\) throw new Error\(raw\)/);
    // The pick is checked before any allocation is written.
    expect(fund.indexOf('E60_FUNDERS_ONLY')).toBeLessThan(fund.indexOf("from('agent_landlord_float_allocations')"));
    const approve = readFileSync(resolve(__dirname, '../../supabase/functions/approve-pending-portfolio/index.ts'), 'utf8');
    expect(approve).toMatch(/if \(\/\^E\\d\+_\[A-Z_\]\+:\/\.test\(msg\)\)/);
  });
});

describe('no Welile-money funding on the CFO screens', () => {
  it('Rent Disbursement and Batch Payout no longer call fund-agent-landlord-float', () => {
    for (const f of ['components/cfo/RentDisbursementQueue.tsx', 'components/cfo/BatchPayoutProcessor.tsx', 'pages/desk/cfo/FundersDashboard.tsx', 'pages/desk/cfo/cfoApi.ts']) {
      expect(readFileSync(resolve(__dirname, '..', f), 'utf8')).not.toContain('fund-agent-landlord-float');
    }
    const rdq = readFileSync(resolve(__dirname, '../components/cfo/RentDisbursementQueue.tsx'), 'utf8');
    expect(rdq).toContain(NEEDS_FUNDER_PICK);
    for (const gone of ['Fund this float', 'Confirm &amp; Pay Selected', 'Select All for Disbursement', 'Select for disbursement']) expect(rdq).not.toContain(gone);
    // Returning a request to the COO stays.
    expect(rdq).toContain('Return to COO');
  });

  it('Batch Payout lists unpicked requests read-only, each with "Needs a funder\'s pick"', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><BatchPayoutProcessor /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Amina Nakato')).toBeTruthy());
    expect(screen.getAllByText(new RegExp(NEEDS_FUNDER_PICK))).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Disburse/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('Partner Ops wording (PO-7D replaces PO-2)', () => {
  it('the lead no longer says Welile funds day-7 rows', () => {
    const b = toPartnerBoard({ tiles: { listed: { n: 24, ugx: 31e6 }, welile_due: { n: 3, ugx: 2.4e6 }, sold: { n: 18 }, sell_through_7d: { pct: 65 } } });
    expect(partnerLead(b)).toBe('24 tenants are listed for funders (UGX 31M); 3 have waited 7+ days and need a Partner Ops follow-up; 18 sold in this period, 65% within a week.');
  });
});
