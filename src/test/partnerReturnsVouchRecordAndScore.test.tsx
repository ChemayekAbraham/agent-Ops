/**
 * Partner Returns Phase 4, browser round 3 (G1 + G2):
 * - G1: trust.score is masked by 4b (null) for a viewer who may not see the person's Returns.
 *   shownTrustScore never turns unknown into a figure; the WhatsApp text drops "(x/100)" and the PDF prints
 *   '—' in the score slot. A real score of 0 is still a figure. Each mask on its own (score only, limit only)
 *   is checked, not just the fully masked profile.
 * - G2: LenderRecordLoanCard.recordLoan fails closed on a masked limit or score: no vouch_claims insert, no
 *   confirm() quoting a UGX 0 vouch, and the refusal toast. With real figures the insert is exactly what
 *   production writes today (switch-off parity), including the over-the-limit confirm.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  pdfTexts: [] as string[],
}));

vi.mock('@/integrations/supabase/client', () => {
  const partner = {
    id: 'lp-1', legal_name: 'Test Lending Partner', partner_type: 'individual',
    agreement_accepted: true, is_active: true, kyc_status: 'verified',
  };
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'vouch_claims') return { insert: (row: unknown) => { mocks.insert(row); return Promise.resolve({ error: null }); } };
        // lender_partners: select('*').eq(...).maybeSingle()
        const chain = { select: () => chain, eq: () => chain, maybeSingle: () => Promise.resolve({ data: partner, error: null }) };
        return chain;
      },
    },
  };
});
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'lender-user' } }) }));
vi.mock('@/hooks/useLenderVouchAgreement', () => ({
  useLenderVouchAgreement: () => ({ isAccepted: true, acceptAgreement: vi.fn() }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
// A recording jsPDF: every method is a no-op except text(), whose strings are kept.
vi.mock('jspdf', () => {
  class FakePdf {
    internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
    constructor() {
      return new Proxy(this, {
        get(target, prop) {
          if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
          if (prop === 'text') return (t: unknown) => { mocks.pdfTexts.push(Array.isArray(t) ? t.join('\n') : String(t)); };
          if (prop === 'output') return () => new Blob(['pdf']);
          if (prop === 'splitTextToSize') return (t: string) => [t];
          if (prop === 'getTextWidth') return () => 10;
          return () => {};
        },
      });
    }
  }
  return { jsPDF: FakePdf, default: FakePdf };
});

import type { TrustProfile } from '@/hooks/useTrustProfile';
import { formatUGX } from '@/lib/rentCalculations';
import { buildWhatsAppMessage, shownTrustScore, shownVouchLimit } from '@/lib/shareTrustProfile';
import { generateTrustProfilePdf } from '@/lib/trustProfilePdf';
import LenderRecordLoanCard from '@/components/vouch/lender/LenderRecordLoanCard';

const LIMIT = 1_050_000;

function profile(trust: { score: number | null; borrowing_limit_ugx: number | null }): TrustProfile {
  return {
    ai_id: 'WEL-ABC123',
    user_id: 'subject',
    identity: {
      full_name: 'Subject Person', phone: null, email: null, national_id: null, national_id_present: false,
      avatar_url: null, verified: true, member_since: '2025-01-01T00:00:00Z', roles: ['supporter'], primary_role: 'supporter',
    },
    trust: {
      score: trust.score, tier: 'standard', data_points: 6, borrowing_limit_ugx: trust.borrowing_limit_ugx,
      vouch_breakdown: {
        total_ugx: trust.borrowing_limit_ugx, portfolio_component_ugx: 800_000, angel_shares_ugx: 0, shares_component_ugx: 0, boosters_ugx: 250_000,
        booster_breakdown: { wallet_activity: 100_000, network_contribution: 50_000, agent_performance: 0, verification: 50_000, movement_behavior: 0, payment_history: 50_000 },
      },
      breakdown: { supporter: 20, payment: 10, wallet: 5, network: 2, verification: 3, behavior: 0, landlord: 0 },
      weights: { payment: 15, wallet: 10, network: 15, verification: 10, behavior: 5, landlord: 5 },
    },
    supporter_activity: {
      is_supporter: true, portfolio_value: 800_000, active_portfolios: 1, total_roi_earned: 240_000,
      roi_paid_30d: 80_000, roi_paid_180d: 240_000, roi_monthly_avg: 80_000,
    },
    payment_history: { total_rent_plans: 0, total_repaid: 0, total_owing: 0, on_time_count: 0, late_count: 0, on_time_rate: 0 },
    wallet_activity: { balance: null, total_received_180d: 0, total_sent_180d: 0, transaction_count_180d: 0 },
    cash_flow_capacity: { daily_avg: 3_000, weekly_avg: 21_000, monthly_avg: 90_000, roi_monthly: 80_000, wallet_monthly: 10_000, window_days: 90 },
    network: { referrals: 0, sub_agents: 0, tenants_onboarded: 0, portfolio_value: 800_000 },
    behavior: { visits_total_60d: 0, always_share_location: false },
    landlord_activity: { total_listings: 0, verified_listings: 0, guaranteed_rent: false },
    permissions: { is_self: false, is_staff_view: false, can_see_pii: false },
    generated_at: '2026-11-07T00:00:00Z',
  } as unknown as TrustProfile;
}

async function pdfTextsFor(p: TrustProfile): Promise<string[]> {
  mocks.pdfTexts.length = 0;
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  try {
    await generateTrustProfilePdf(p);
  } finally {
    vi.unstubAllGlobals();
  }
  return [...mocks.pdfTexts];
}

const tierLine = (msg: string) => msg.split('\n').find((l) => l.includes('Trust Tier')) ?? '';

beforeEach(() => {
  mocks.insert.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.pdfTexts.length = 0;
});

describe('G1: shownTrustScore', () => {
  it.each([
    ['null (masked by 4b)', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '62'],
  ])('%s is not a score', (_label, score) => {
    expect(shownTrustScore({ trust: { score } } as never)).toBeNull();
  });

  it('a missing trust block is not a score (never 0)', () => {
    expect(shownTrustScore({} as never)).toBeNull();
  });

  it('a real score passes through, including a real 0', () => {
    expect(shownTrustScore(profile({ score: 62, borrowing_limit_ugx: LIMIT }))).toBe(62);
    expect(shownTrustScore(profile({ score: 0, borrowing_limit_ugx: LIMIT }))).toBe(0);
  });
});

describe('G1: share text with each mask on its own', () => {
  it('score masked, limit visible: the tier line has no "(x/100)", the vouch line stays', () => {
    const msg = buildWhatsAppMessage(profile({ score: null, borrowing_limit_ugx: LIMIT }));
    expect(tierLine(msg)).toMatch(/Trust Tier: \*[^*]+\*$/);
    expect(msg).not.toMatch(/\/100/);
    expect(msg).toContain(`Vouches Up To: *${formatUGX(LIMIT)}*`);
    expect(msg).not.toMatch(/\bnull\b|\bNaN\b|undefined/);
  });

  it('limit masked, score visible: the score shows, no vouch line, no 0 amount', () => {
    const p = profile({ score: 62, borrowing_limit_ugx: null });
    expect(shownVouchLimit(p)).toBeNull();
    const msg = buildWhatsAppMessage(p);
    expect(tierLine(msg)).toMatch(/\(62\/100\)$/);
    expect(msg).not.toMatch(/Vouches Up To/);
    expect(msg).not.toMatch(/\bnull\b|\bNaN\b|undefined/);
  });

  it('a real score of 0 is still printed as (0/100), not dropped', () => {
    expect(tierLine(buildWhatsAppMessage(profile({ score: 0, borrowing_limit_ugx: LIMIT })))).toMatch(/\(0\/100\)$/);
  });
});

describe('G1: PDF with each mask on its own', () => {
  it('score masked: the score slot prints —, never 0, null or NaN; the vouch line stays', async () => {
    const shown = await pdfTextsFor(profile({ score: 62, borrowing_limit_ugx: LIMIT }));
    const texts = await pdfTextsFor(profile({ score: null, borrowing_limit_ugx: LIMIT }));
    // The only difference from the unmasked PDF is the score slot: '62' becomes '—' (not '0').
    expect(texts.length).toBe(shown.length);
    const diff = texts.map((t, i) => [shown[i], t]).filter(([a, b]) => a !== b);
    expect(diff).toEqual([['62', '—']]);
    expect(texts.filter((t) => /\bnull\b|\bNaN\b|undefined/.test(t))).toEqual([]);
    expect(texts).toContain(`Welile vouches up to ${formatUGX(LIMIT)}`);
  });

  it('limit masked: the score prints, no vouch line', async () => {
    const texts = await pdfTextsFor(profile({ score: 62, borrowing_limit_ugx: null }));
    expect(texts).toContain('62');
    expect(texts.some((t) => /vouches up to/i.test(t))).toBe(false);
    expect(texts.filter((t) => /\bnull\b|\bNaN\b|undefined/.test(t))).toEqual([]);
  });

  it('a real score of 0 prints 0, not —', async () => {
    const shown = await pdfTextsFor(profile({ score: 62, borrowing_limit_ugx: LIMIT }));
    const texts = await pdfTextsFor(profile({ score: 0, borrowing_limit_ugx: LIMIT }));
    const diff = texts.map((t, i) => [shown[i], t]).filter(([a, b]) => a !== b);
    expect(diff).toEqual([['62', '0']]);
  });
});

describe('G2: LenderRecordLoanCard.recordLoan', () => {
  let confirmSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    return () => vi.unstubAllGlobals();
  });

  async function submit(p: TrustProfile, principal: string) {
    render(<LenderRecordLoanCard profile={p} />);
    fireEvent.click(await screen.findByRole('button', { name: /Record a Vouched Loan/i }));
    if (principal) fireEvent.change(screen.getByPlaceholderText('500000'), { target: { value: principal } });
    fireEvent.click(screen.getByRole('button', { name: /^Record Loan$/i }));
  }

  async function expectRecordDisabled(p: TrustProfile) {
    render(<LenderRecordLoanCard profile={p} />);
    const open = await screen.findByRole('button', { name: /Record a Vouched Loan/i });
    expect(open).toBeDisabled();
    expect(screen.getByText(/vouch figures for this person are hidden from you/i)).toBeInTheDocument();
    fireEvent.click(open);
    expect(screen.queryByPlaceholderText('500000')).toBeNull();
  }

  it.each([
    ['limit masked', { score: 62, borrowing_limit_ugx: null }],
    ['score masked', { score: null, borrowing_limit_ugx: LIMIT }],
    ['both masked', { score: null, borrowing_limit_ugx: null }],
  ])('%s: refuses, saves nothing, never asks to confirm a UGX 0 vouch', async (_label, t) => {
    // Owner decision (a), 8 Nov: the "Record a Vouched Loan" button is disabled with a one-line reason
    // while the figures are hidden, so the form never opens (recordLoan still refuses on its own).
    await expectRecordDisabled(profile(t));
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('masked, principal above any limit: still refuses before the over-the-vouch confirm', async () => {
    await expectRecordDisabled(profile({ score: 62, borrowing_limit_ugx: null }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('real figures, principal within the limit: the insert is today\'s row (switch-off parity)', async () => {
    await submit(profile({ score: 62, borrowing_limit_ugx: LIMIT }), '500000');
    await waitFor(() => expect(mocks.insert).toHaveBeenCalledTimes(1));
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({
      lender_partner_id: 'lp-1', borrower_user_id: 'subject', borrower_ai_id: 'WEL-ABC123',
      principal_ugx: 500_000, vouched_amount_ugx: 500_000, trust_score_at_record: 62, trust_tier_at_record: 'standard',
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining(formatUGX(500_000))));
  });

  it('real figures, principal above the limit: confirm quotes the real limit and the vouch is capped at it', async () => {
    await submit(profile({ score: 62, borrowing_limit_ugx: LIMIT }), '2000000');
    await waitFor(() => expect(mocks.insert).toHaveBeenCalledTimes(1));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining(`vouches up to ${formatUGX(LIMIT)}`));
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({ principal_ugx: 2_000_000, vouched_amount_ugx: LIMIT, trust_score_at_record: 62 });
  });

  it('real figures, declined confirm: nothing is saved', async () => {
    confirmSpy.mockReturnValue(false);
    await submit(profile({ score: 62, borrowing_limit_ugx: LIMIT }), '2000000');
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('a real score of 0 is a figure: recorded with trust_score_at_record 0, not refused', async () => {
    await submit(profile({ score: 0, borrowing_limit_ugx: LIMIT }), '100000');
    await waitFor(() => expect(mocks.insert).toHaveBeenCalledTimes(1));
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({ vouched_amount_ugx: 100_000, trust_score_at_record: 0 });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('no principal with real figures: the existing principal check still answers', async () => {
    await submit(profile({ score: 62, borrowing_limit_ugx: LIMIT }), '');
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Enter a valid principal'));
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
