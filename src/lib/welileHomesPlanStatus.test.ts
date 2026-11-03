import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { resolveWhPlanStage, isWhPlanLocked, dueHasCollection, WH_STAGE_META } from './welileHomesPlanStatus';

const base = { hasCollections: false };

describe('resolveWhPlanStage', () => {
  it('declined wins over everything', () => {
    expect(resolveWhPlanStage({ ...base, subscriptionStatus: 'cancelled', fundingStatus: 'funded', hasCollections: true })).toBe('declined');
  });
  it('collections mean repaying', () => {
    expect(resolveWhPlanStage({ hasCollections: true })).toBe('repaying');
  });
  it('funded only from funding_status', () => {
    expect(resolveWhPlanStage({ ...base, fundingStatus: 'funded' })).toBe('funded');
    expect(resolveWhPlanStage({ ...base, linkedRequestStatus: 'approved' })).toBe('approved_unconfirmed');
    expect(resolveWhPlanStage({ ...base, linkedRequestStatus: 'approved', fundingStatus: 'funded' })).toBe('funded');
  });
  it('maps each review stage', () => {
    expect(resolveWhPlanStage({ ...base, linkedRequestStatus: 'pending' })).toBe('pending_agent_ops');
    expect(resolveWhPlanStage({ ...base, linkedRequestStatus: 'agent_ops_approved' })).toBe('pending_tenant_ops');
    expect(resolveWhPlanStage({ ...base, linkedRequestStatus: 'tenant_ops_approved' })).toBe('pending_coo');
    expect(resolveWhPlanStage({ ...base, linkedRequestStatus: 'coo_approved' })).toBe('pending_cfo');
  });
  it('a rejected request is not a declined application and allows re-request', () => {
    const s = resolveWhPlanStage({ ...base, linkedRequestStatus: 'rejected', fundingStatus: 'unfunded' });
    expect(s).toBe('request_rejected');
    expect(WH_STAGE_META[s].canRequestFloat).toBe(true);
  });
  it('no recorded facts means not requested', () => {
    expect(resolveWhPlanStage(base)).toBe('not_requested');
    expect(resolveWhPlanStage({ ...base, fundingStatus: 'requested' })).toBe('requested');
  });
});

describe('isWhPlanLocked', () => {
  it('locks on collections, funding, live request or unknown collections', () => {
    expect(isWhPlanLocked({ hasCollections: true })).toBe(true);
    expect(isWhPlanLocked({ ...base, fundingStatus: 'requested' })).toBe(true);
    expect(isWhPlanLocked({ ...base, fundingStatus: 'funded' })).toBe(true);
    expect(isWhPlanLocked({ ...base, linkedRequestStatus: 'pending' })).toBe(true);
    expect(isWhPlanLocked({ ...base, collectionsUnknown: true })).toBe(true);
  });
  it('leaves untouched and declined-without-money plans deletable', () => {
    expect(isWhPlanLocked(base)).toBe(false);
    expect(isWhPlanLocked({ ...base, subscriptionStatus: 'cancelled' })).toBe(false);
    expect(isWhPlanLocked({ ...base, linkedRequestStatus: 'rejected', fundingStatus: 'unfunded' })).toBe(false);
  });
});

describe('dueHasCollection', () => {
  it('detects collected money or landlord payout', () => {
    expect(dueHasCollection({ amount_collected: 1 })).toBe(true);
    expect(dueHasCollection({ collection_status: 'collected' })).toBe(true);
    expect(dueHasCollection({ payout_status: 'paid' })).toBe(true);
    expect(dueHasCollection({ amount_collected: 0, collection_status: 'pending', payout_status: 'unpaid' })).toBe(false);
  });
});
