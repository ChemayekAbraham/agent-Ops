import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

import {
  buildEligibilityPreview, describePreviewAmounts, type CommsChannel, type SupportContact, type TenantPaymentMessageFigures,
} from './useTenantCommunications';

const figures: TenantPaymentMessageFigures = {
  tenant_id: 't1', rent_amount: 300000, total_expected: 1000000, paid_to_date: 400000, remaining: 600000,
  term_end: '2026-12-09', days_left_in_cycle: 60, days_after_cycle: 0, tier_key: 'same_amount_only',
  current_access: 300000, current_topup: 0, next_level_required: 500000, next_level_access: 600000, next_level_deadline: '2026-12-09',
};
const contacts: SupportContact[] = [{ id: 'c1', label: 'Care', phone: '0700111222', sort_order: 1, active: true }];
const channels: CommsChannel[] = [{ provider: 'MTN', merchant_code: '123456', merchant_name: null, active: true }];

describe('payment message preview', () => {
  it('still builds exactly the message that is sent (wording unchanged)', () => {
    expect(buildEligibilityPreview(figures, contacts, channels)).toBe(
      'You have now paid UGX 400,000 of UGX 1,000,000, leaving UGX 600,000 to pay. '
      + 'Your payment cycle ends in 60 days. '
      + 'You have qualified for rent of up to UGX 300,000 next time, the same as your current rent. '
      + 'Pay UGX 500,000 more to qualify for rent of up to UGX 600,000. Pay it by 2026-12-09 to keep this. '
      + 'Pay directly via MTN 123456. Need help? Call Welile customer care on 0700111222.',
    );
  });
});

describe('describePreviewAmounts', () => {
  it('says what each amount is, and that none is the amount due now', () => {
    const notes = describePreviewAmounts(figures);
    const by = (amount: string) => notes.filter((n) => n.amount === amount).map((n) => n.meaning).join(' | ');
    expect(by('UGX 400,000')).toContain('all time');
    expect(by('UGX 1,000,000')).toContain('full cycle');
    expect(by('UGX 600,000')).toMatch(/Lifetime balance .* not the amount due now/);
    expect(by('UGX 500,000')).toMatch(/all time\)\. It is not the amount due now/);
    // every amount note that talks about paying says it is not due now, and none claims to be due today
    for (const n of notes) expect(n.meaning).not.toMatch(/due today/i);
  });

  it('also explains the current rent when the message compares the new access with it', () => {
    const withTopup = describePreviewAmounts({ ...figures, current_access: 450000, current_topup: 150000 });
    expect(withTopup.some((n) => n.amount === 'UGX 300,000' && n.meaning.includes('current rent'))).toBe(true);
    expect(describePreviewAmounts(figures).some((n) => n.amount === 'UGX 300,000' && n.meaning.includes('current rent') && n.meaning.startsWith('Their'))).toBe(false);
  });

  it('explains only the amounts the message actually quotes', () => {
    expect(describePreviewAmounts({ ...figures, total_expected: 0, current_access: 0, next_level_required: null, next_level_access: null })).toEqual([]);
    const paidUp = describePreviewAmounts({ ...figures, remaining: 0, next_level_required: null, next_level_access: null });
    expect(paidUp.some((n) => n.meaning.includes('Lifetime balance'))).toBe(false);
    expect(describePreviewAmounts(null)).toEqual([]);
  });

  it('never uses the words loan, lender, ROI or interest', () => {
    expect(JSON.stringify(describePreviewAmounts(figures))).not.toMatch(/\b(loan|lender|ROI|interest)\b/i);
  });
});
