import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';

/**
 * These tests exist because the Today dashboard originally rendered numbers that
 * came from nothing — hardcoded chart data, invented operators, a fabricated
 * "recoveries" figure. They assert two things a reviewer cannot check by eye:
 *
 *  1. Each hook really reads the table that owns the fact it displays.
 *  2. The wallet arithmetic matches what the backend actually does — a verified
 *     listing credits the bonus only once `status = 'paid'`, and a rejected
 *     listing DEBITS UGX 4,000 (it is not merely "no bonus").
 */

// ─── Minimal recording stub of the PostgREST query builder ───
interface Recorded {
  table: string;
  ops: { fn: string; args: unknown[] }[];
}

let recorded: Recorded[] = [];
/** table -> rows (or { count }) the stub should resolve with */
let responses: Record<string, { data?: unknown[]; count?: number; error?: { message: string } }> = {};

function makeBuilder(table: string) {
  const entry: Recorded = { table, ops: [] };
  recorded.push(entry);

  const result = () => {
    const r = responses[table] ?? {};
    return { data: r.data ?? [], count: r.count ?? 0, error: r.error ?? null };
  };

  const builder: Record<string, unknown> = {};
  const chain = ['select', 'gte', 'lte', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit'];
  for (const fn of chain) {
    builder[fn] = (...args: unknown[]) => {
      entry.ops.push({ fn, args });
      return builder;
    };
  }
  // Awaiting the builder resolves it, as PostgREST builders do.
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => makeBuilder(table),
  },
}));

const { useLandlordOpsActivity, useLandlordOpsRecentDecisions, useLandlordOpsWalletImpact } =
  await import('../useLandlordOpsToday');
const { useLandlordOpsBadgeCounts } = await import('../useLandlordOpsBadgeCounts');

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

/** Every op recorded against a table, flattened for assertions. */
const opsFor = (table: string) =>
  recorded.filter((r) => r.table === table).flatMap((r) => r.ops);
const tablesQueried = () => [...new Set(recorded.map((r) => r.table))];

const iso = (daysAgo: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
};

beforeEach(() => {
  recorded = [];
  responses = {};
});

describe('useLandlordOpsBadgeCounts — the badges that used to be 73 / 38 / 26', () => {
  it('reads each backlog from the table that owns it', async () => {
    responses = {
      house_listings: { count: 11 },
      landlords: { count: 22 },
      v_lc1_verification_inbox: { count: 33 },
      rent_requests: { count: 44 },
      agent_landlord_payouts: { count: 55 },
      disbursement_records: { data: [{ landlord_id: 'a' }, { landlord_id: 'a' }, { landlord_id: 'b' }] },
    };

    const { result } = renderHook(() => useLandlordOpsBadgeCounts(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.pendingHouses).toBe(11);
    expect(result.current.pendingLandlords).toBe(22);
    expect(result.current.pendingLc1).toBe(33);
    expect(result.current.pendingPipeline).toBe(44);
    expect(result.current.pendingPayouts).toBe(55);
    // Distinct landlords, not row count.
    await waitFor(() => expect(result.current.paidLandlords).toBe(2));
  });

  it('counts the LC1 bucket the inbox actually opens on (agent_requested)', async () => {
    responses = { v_lc1_verification_inbox: { count: 0 } };
    const { result } = renderHook(() => useLandlordOpsBadgeCounts(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const ops = opsFor('v_lc1_verification_inbox');
    // Chairpersons still with a Service Centre manager are not Landlord Ops work.
    expect(ops).toEqual(
      expect.arrayContaining([{ fn: 'neq', args: ['service_center_status', 'pending'] }]),
    );
    expect(ops).toEqual(expect.arrayContaining([{ fn: 'eq', args: ['status', 'pending'] }]));
    // Lc1VerificationInboxPanel defaults to initialStatus='agent_requested'.
    // Counting bare `status='pending'` made the badge read ~11.8k against a tab
    // showing a fraction of that.
    expect(ops).toEqual(
      expect.arrayContaining([{ fn: 'eq', args: ['agent_request_open', true] }]),
    );
  });

  it('counts the rent-pipeline stage that actually sits on Landlord Ops', async () => {
    responses = { rent_requests: { count: 0 } };
    const { result } = renderHook(() => useLandlordOpsBadgeCounts(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(opsFor('rent_requests')).toEqual(
      expect.arrayContaining([{ fn: 'eq', args: ['status', 'tenant_ops_approved'] }]),
    );
  });

  it('counts payouts awaiting landlord-ops review, not CFO sign-off', async () => {
    responses = { agent_landlord_payouts: { count: 0 } };
    const { result } = renderHook(() => useLandlordOpsBadgeCounts(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(opsFor('agent_landlord_payouts')).toEqual(
      expect.arrayContaining([{ fn: 'eq', args: ['status', 'pending_landlord_ops'] }]),
    );
  });
});

describe('decision feed — reads both decision tables', () => {
  it('takes rejections from agent_listing_rejections, not the bonus-approval table', async () => {
    const { result } = renderHook(() => useLandlordOpsActivity(3), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(tablesQueried()).toContain('listing_bonus_approvals');
    expect(tablesQueried()).toContain('agent_listing_rejections');

    // `listing_bonus_approvals.rejected_at` is a rejected *bonus approval*, a
    // different event, and must never be read as a rejected listing.
    const approvalOps = opsFor('listing_bonus_approvals');
    expect(approvalOps.some((o) => JSON.stringify(o.args).includes('rejected_at'))).toBe(false);
  });

  it('returns one zeroed bucket per day so a quiet window keeps an even axis', async () => {
    const { result } = renderHook(() => useLandlordOpsActivity(5), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(5);
    expect(result.current.data?.every((d) => d.verified === 0 && d.rejected === 0)).toBe(true);
    // Oldest first.
    const dates = result.current.data!.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('buckets verifications and rejections onto their own day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    responses = {
      listing_bonus_approvals: {
        data: [
          { id: 'a1', listing_id: 'L1', amount: 2000, status: 'paid', landlord_ops_approved_at: iso(0), landlord_ops_approved_by: 'op1' },
          { id: 'a2', listing_id: 'L2', amount: 2000, status: 'paid', landlord_ops_approved_at: iso(0), landlord_ops_approved_by: 'op1' },
        ],
      },
      agent_listing_rejections: {
        data: [{ id: 'r1', listing_id: 'L3', reason: 'blurry photos', rejected_at: iso(0), rejected_by: 'op2' }],
      },
    };

    const { result } = renderHook(() => useLandlordOpsActivity(3), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const bucket = result.current.data?.find((d) => d.date === today);
    expect(bucket).toEqual({ date: today, verified: 2, rejected: 1 });
  });
});

describe('wallet impact — the arithmetic the mockup had inverted', () => {
  it('credits only settled bonuses, holds unsettled ones separately, and debits rejections', async () => {
    responses = {
      listing_bonus_approvals: {
        data: [
          // settled -> credited
          { id: 'a1', listing_id: 'L1', amount: 2000, status: 'paid', landlord_ops_approved_at: iso(0), landlord_ops_approved_by: 'op1' },
          // in flight -> pendingCredit
          { id: 'a2', listing_id: 'L2', amount: 2000, status: 'pending_credit', landlord_ops_approved_at: iso(0), landlord_ops_approved_by: 'op1' },
          // rolled back -> neither
          { id: 'a3', listing_id: 'L3', amount: 2000, status: 'failed', landlord_ops_approved_at: iso(0), landlord_ops_approved_by: 'op1' },
        ],
      },
      agent_listing_rejections: {
        data: [
          { id: 'r1', listing_id: 'L4', reason: 'no gps', rejected_at: iso(0), rejected_by: 'op2' },
          { id: 'r2', listing_id: 'L5', reason: 'duplicate', rejected_at: iso(0), rejected_by: 'op2' },
        ],
      },
    };

    const { result } = renderHook(() => useLandlordOpsWalletImpact(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({
      credited: 2000,
      pendingCredit: 2000,
      // 2 rejections x the UGX 4,000 charge reject_house_listing posts.
      charged: 8000,
      verifiedCount: 3,
      rejectedCount: 2,
    });
  });

  it('reports zero rather than a placeholder when nothing was decided today', async () => {
    const { result } = renderHook(() => useLandlordOpsWalletImpact(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({
      credited: 0,
      pendingCredit: 0,
      charged: 0,
      verifiedCount: 0,
      rejectedCount: 0,
    });
  });
});

describe('recent decisions — real operators and real amounts', () => {
  it('resolves the operator and listing, and carries each decision its own amount', async () => {
    responses = {
      listing_bonus_approvals: {
        data: [
          { id: 'a1', listing_id: 'L1', amount: 2000, status: 'paid', landlord_ops_approved_at: iso(1), landlord_ops_approved_by: 'op1' },
        ],
      },
      agent_listing_rejections: {
        data: [{ id: 'r1', listing_id: 'L2', reason: 'photos unusable', rejected_at: iso(0), rejected_by: 'op2' }],
      },
      house_listings: {
        data: [
          { id: 'L1', title: 'Two bedroom, Ntinda', district: 'Kampala', image_urls: ['https://cdn/x.jpg', 'https://cdn/y.jpg'] },
          { id: 'L2', title: null, district: null, image_urls: null },
        ],
      },
      profiles: {
        data: [
          { id: 'op1', full_name: 'Verifier One' },
          { id: 'op2', full_name: 'Verifier Two' },
        ],
      },
    };

    const { result } = renderHook(() => useLandlordOpsRecentDecisions(6), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const rows = result.current.data!;
    // Newest first: the rejection happened today, the approval yesterday.
    expect(rows.map((r) => r.kind)).toEqual(['rejected', 'verified']);

    const rejected = rows[0];
    expect(rejected.amount).toBe(4000); // charge, not the 2,000 the mockup showed
    expect(rejected.operatorName).toBe('Verifier Two');
    expect(rejected.rejectionReason).toBe('photos unusable');
    expect(rejected.imageUrl).toBeNull();
    expect(rejected.photoCount).toBe(0);
    expect(rejected.creditLanded).toBe(false);

    const verified = rows[1];
    expect(verified.amount).toBe(2000);
    expect(verified.creditLanded).toBe(true);
    expect(verified.operatorName).toBe('Verifier One');
    expect(verified.listingTitle).toBe('Two bedroom, Ntinda');
    expect(verified.district).toBe('Kampala');
    expect(verified.photoCount).toBe(2);
    expect(verified.imageUrl).toBe('https://cdn/x.jpg');
  });

  it('leaves the operator null instead of inventing a name', async () => {
    responses = {
      agent_listing_rejections: {
        data: [{ id: 'r1', listing_id: 'L1', reason: 'bad data', rejected_at: iso(0), rejected_by: null }],
      },
      house_listings: { data: [{ id: 'L1', title: 'X', district: null, image_urls: null }] },
      profiles: { data: [] },
    };

    const { result } = renderHook(() => useLandlordOpsRecentDecisions(6), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data![0].operatorName).toBeNull();
  });

  it('returns an empty list, and skips enrichment, when there are no decisions', async () => {
    const { result } = renderHook(() => useLandlordOpsRecentDecisions(6), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
    // No point querying listings/profiles for nothing.
    expect(tablesQueried()).not.toContain('profiles');
  });
});

describe('useLandlordOpsNewToday — must be a subset of the headline', () => {
  it('applies each queue filter as well as the date, so it cannot exceed the count above it', async () => {
    const { useLandlordOpsNewToday } = await import('../useLandlordOpsToday');
    const { result } = renderHook(() => useLandlordOpsNewToday(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The bug this guards: these counted every row created today with no status
    // filter, so a card could read "0 awaiting sign-off / New today: 5".
    const houses = opsFor('house_listings');
    expect(houses).toEqual(expect.arrayContaining([{ fn: 'eq', args: ['verified', false] }]));
    expect(houses).toEqual(expect.arrayContaining([{ fn: 'gte', args: ['created_at', expect.any(String)] }]));

    const rent = opsFor('rent_requests');
    expect(rent).toEqual(expect.arrayContaining([{ fn: 'eq', args: ['status', 'tenant_ops_approved'] }]));
    expect(rent).toEqual(expect.arrayContaining([{ fn: 'gte', args: ['created_at', expect.any(String)] }]));

    const lc1 = opsFor('v_lc1_verification_inbox');
    expect(lc1).toEqual(expect.arrayContaining([{ fn: 'eq', args: ['agent_request_open', true] }]));
    expect(lc1).toEqual(expect.arrayContaining([{ fn: 'gte', args: ['requested_at', expect.any(String)] }]));

    const landlords = opsFor('landlords');
    expect(landlords).toEqual(
      expect.arrayContaining([{ fn: 'neq', args: ['service_center_status', 'pending'] }]),
    );
    expect(landlords).toEqual(expect.arrayContaining([{ fn: 'gte', args: ['created_at', expect.any(String)] }]));
  });

  it('counts today from local midnight, not UTC midnight', async () => {
    const { useLandlordOpsNewToday } = await import('../useLandlordOpsToday');
    const { result } = renderHook(() => useLandlordOpsNewToday(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const gte = opsFor('house_listings').find((o) => o.fn === 'gte');
    const since = new Date(String((gte!.args as [string, string])[1]));
    const localMidnight = new Date();
    localMidnight.setHours(0, 0, 0, 0);
    expect(since.getTime()).toBe(localMidnight.getTime());
  });
});

describe('a queue we could not read must not render as zero', () => {
  it('reports the failure per queue instead of resolving to 0', async () => {
    // e.g. an RLS policy that hides rent_requests from this role. Previously
    // `count || 0` swallowed this and the card read "0 awaiting sign-off",
    // indistinguishable from an empty queue.
    responses = {
      rent_requests: { error: { message: 'permission denied for table rent_requests' } },
      house_listings: { count: 7 },
    };

    const { result } = renderHook(() => useLandlordOpsBadgeCounts(), { wrapper });
    await waitFor(() => expect(result.current.errors.pipeline).toBeTruthy());

    expect(result.current.isError).toBe(true);
    expect(String((result.current.errors.pipeline as { message: string }).message)).toContain(
      'permission denied',
    );
    // One failing table must not blank the others.
    await waitFor(() => expect(result.current.pendingHouses).toBe(7));
    expect(result.current.errors.houses).toBeFalsy();
  });

  it('has no error when every queue is genuinely empty', async () => {
    const { result } = renderHook(() => useLandlordOpsBadgeCounts(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isError).toBe(false);
    expect(result.current.pendingPipeline).toBe(0);
    expect(result.current.pendingPayouts).toBe(0);
  });
});
