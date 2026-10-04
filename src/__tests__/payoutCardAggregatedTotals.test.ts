import { describe, it, expect, vi } from 'vitest';
import {
  renderPayoutCardPng,
  PAYOUT_COLUMNS,
  DEFAULT_PAYOUT_COLUMNS,
} from '@/components/financial-ops/landlordPayoutPdf';
import type { LandlordPayoutShareData } from '@/components/financial-ops/LandlordPayoutShareCard';

// html-to-image's toPng can't run under jsdom (no canvas). Stub it to return
// the rendered card's visible text so we can assert on what the PNG WOULD show
// without needing a real raster. renderPayoutCardPng builds the exact same
// offscreen DOM node it captures, so the text content is the source of truth
// for the amount printed on the WhatsApp single card.
vi.mock('html-to-image', () => ({
  toPng: async (node: HTMLElement) =>
    `data:text/plain,${encodeURIComponent(node.textContent ?? '')}`,
}));

const base: LandlordPayoutShareData = {
  amount: 450_000,
  landlord_name: 'Brenda Stella Nantaayi',
  landlord_phone: '0780541328',
  mobile_money_provider: 'MTN',
  tenant_name: 'John Doe',
  agent_name: 'Agent Smith',
  agent_phone: '0700000000',
  momo_reference: 'PAY-MQZ3MV17-6UIT',
  paid_at: '2026-06-23T10:00:00.000Z',
  country: 'Uganda',
};

const fmt = (n: number) => `UGX ${Number(n).toLocaleString()}`;

describe('WhatsApp single-card PNG render', () => {
  it('prints the exact per-payout amount (no list-export bleed-through)', async () => {
    const dataUrl = await renderPayoutCardPng(base);
    const text = decodeURIComponent(dataUrl.replace('data:text/plain,', ''));
    expect(text).toContain(fmt(base.amount)); // UGX 450,000
    expect(text).toContain(base.landlord_name);
    expect(text).toContain(base.momo_reference);
  });

  it('renders each card with its own amount when sharing several payouts', async () => {
    const rows: LandlordPayoutShareData[] = [
      { ...base, amount: 100_000, momo_reference: 'TID-A' },
      { ...base, amount: 250_000, momo_reference: 'TID-B' },
      { ...base, amount: 999_999, momo_reference: 'TID-C' },
    ];
    for (const r of rows) {
      const url = await renderPayoutCardPng(r);
      const text = decodeURIComponent(url.replace('data:text/plain,', ''));
      // Each single card shows ITS amount, never a summed/aggregated figure.
      expect(text).toContain(fmt(r.amount));
      const others = rows.filter((o) => o !== r);
      others.forEach((o) => expect(text).not.toContain(fmt(o.amount)));
    }
  });
});

describe('export column registry (regression guard for the list changes)', () => {
  it('keeps amount as the only numeric/aggregated column', () => {
    const numeric = PAYOUT_COLUMNS.filter((c) => c.numeric).map((c) => c.key);
    expect(numeric).toEqual(['amount']);
  });

  it('amount column raw() returns a plain number so totals can sum', () => {
    const amount = PAYOUT_COLUMNS.find((c) => c.key === 'amount')!;
    expect(amount.raw?.(base)).toBe(450_000);
    expect(typeof amount.raw?.(base)).toBe('number');
  });

  it('default columns include the amount column', () => {
    expect(DEFAULT_PAYOUT_COLUMNS).toContain('amount');
  });
});