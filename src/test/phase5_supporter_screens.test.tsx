/**
 * Partner Returns Phase 5 (supporter screens, Claude data lines), rendered:
 *  - RentCategoryFeed caches rents (new key, no reward figure) and prices the reward at render with the
 *    viewer's own rate: 15 while the switch is off (today's figure), the person's rate after, none
 *    without a rate.
 *  - PlanShareButton shares the text the database composed (link.description), else the figure-free
 *    fallback; never a client-side 15% sentence.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rate: 15 as number | null,
  rows: [] as { id: string; rent_amount: number; request_city: string; duration_days: number; house_category: string | null }[],
  link: { description: null as string | null },
}));

vi.mock('@/hooks/usePartnerQuoteRate', () => ({
  useOwnNewPortfolioRate: () => ({ rate: mocks.rate, isLoading: false }),
}));
vi.mock('@/hooks/useCurrency', () => ({
  useCurrency: () => ({ formatAmount: (v: unknown) => `F${v}` }),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ limit: async () => ({ data: mocks.rows, error: null }) }) }),
    }),
    auth: { getUser: async () => ({ data: { user: { id: 'partner-1' } } }) },
  },
}));
vi.mock('@/lib/planShareLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planShareLink')>();
  return {
    ...actual,
    createPlanShareLink: vi.fn(async () => ({
      code: 'abc',
      short_code: 'abc',
      share_url: 'https://share.welileapp.com/s/abc',
      shortUrl: 'https://share.welileapp.com/s/abc',
      shareUrl: 'https://share.welileapp.com/s/abc',
      description: mocks.link.description,
    })),
  };
});

import { RentCategoryFeed } from '@/components/supporter/RentCategoryFeed';
import { PlanShareButton } from '@/components/partner/PlanShareButton';
import { planShareFallbackDescription } from '@/lib/planShareLink';

const DOUBLE_ROOM_RENTS = [160_001, 200_000, 249_999];
const OLD_REWARD = DOUBLE_ROOM_RENTS.reduce((s, r) => s + Math.round(r * 0.15), 0);

beforeEach(() => {
  localStorage.clear();
  mocks.rate = 15;
  mocks.rows = DOUBLE_ROOM_RENTS.map((r, i) => ({
    id: `r${i}`, rent_amount: r, request_city: 'Kampala', duration_days: 30, house_category: null,
  }));
  mocks.link.description = null;
});

describe('RentCategoryFeed: reward priced at render, never cached', () => {
  it('switch off (rate 15): the card shows exactly the old per-request 15% total', async () => {
    render(<RentCategoryFeed onFundCategory={() => {}} />);
    expect(await screen.findByText(`+F${OLD_REWARD}`)).toBeInTheDocument();
  });

  it('the cache holds each tier’s rents under the new key and no reward figure; the old key is dropped', async () => {
    localStorage.setItem('welile_rent_categories', JSON.stringify({ data: [], timestamp: Date.now() }));
    render(<RentCategoryFeed onFundCategory={() => {}} />);
    await screen.findByText(`+F${OLD_REWARD}`);
    expect(localStorage.getItem('welile_rent_categories')).toBeNull();
    const cached = JSON.parse(localStorage.getItem('welile_rent_categories_v2') ?? '{}');
    const tier = cached.data.find((c: { category: string }) => c.category === 'Welile Double Room');
    expect(tier.rents).toEqual(DOUBLE_ROOM_RENTS);
    expect(cached.data.every((c: object) => !('expectedReturn' in c))).toBe(true);
  });

  it('a cached entry is re-priced with the current viewer’s rate (10 after switch-on)', async () => {
    render(<RentCategoryFeed onFundCategory={() => {}} />);
    await screen.findByText(`+F${OLD_REWARD}`);
    mocks.rate = 10;
    // A fresh mount reads the cache (no network) and prices it with the new rate.
    mocks.rows = [];
    render(<RentCategoryFeed onFundCategory={() => {}} />);
    const at10 = DOUBLE_ROOM_RENTS.reduce((s, r) => s + Math.round((r * 10) / 100), 0);
    expect(await screen.findByText(`+F${at10}`)).toBeInTheDocument();
  });

  it('no rate: no figure is computed (the card shows "—", never a 15% default)', async () => {
    mocks.rate = null;
    render(<RentCategoryFeed onFundCategory={() => {}} />);
    await screen.findAllByText('—');
    expect(screen.queryByText('+Fnull')).toBeNull();
    expect(screen.queryByText(`+F${OLD_REWARD}`)).toBeNull();
  });
});

describe('PlanShareButton: the database-composed share text', () => {
  const plan = { rent_request_id: 'plan-1', funding_amount: 300_000, house_category: 'single_room', request_city: 'Kampala' };

  async function share(): Promise<ShareData> {
    const shareFn = vi.fn(async (_d: ShareData) => {});
    Object.defineProperty(navigator, 'share', { value: shareFn, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    render(<PlanShareButton plan={plan} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share this rent plan' }));
    await waitFor(() => expect(shareFn).toHaveBeenCalled());
    return shareFn.mock.calls[0][0];
  }

  it('shares link.description as it is', async () => {
    mocks.link.description = 'Support this tenant for UGX 300,000 ... earn UGX 45,000 per month';
    expect((await share()).text).toBe(mocks.link.description);
  });

  it('without a description: the fallback text, which carries no Returns figure', async () => {
    const payload = await share();
    expect(payload.text).toBe(planShareFallbackDescription(plan));
    expect(payload.text).not.toMatch(/45,000|15%/);
  });
});
