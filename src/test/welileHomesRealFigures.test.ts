import { describe, it, expect } from 'vitest';
import {
  applicationsFromRequests, splitCollections, whApplicationLabel,
  type WhApplicationSource, type WhCollectionRow,
} from '@/lib/welileHomesRealFigures';

const req = (over: Partial<WhApplicationSource> & { id: string }): WhApplicationSource => ({
  agent_id: 'a1',
  requested_amount: 500000,
  status: 'pending',
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});

const due = (over: Partial<WhCollectionRow> & { id: string }): WhCollectionRow => ({
  subscription_id: 's1',
  tenant_id: 't1',
  agent_id: 'a1',
  period_month: '2026-11',
  amount_collected: 0,
  welile_net: 0,
  landlord_net: 0,
  collection_status: 'pending',
  payout_status: 'unpaid',
  ...over,
});

describe('Welile Homes overview real figures', () => {
  it('does not count pending or rejected applications as approved float', () => {
    const apps = applicationsFromRequests(
      [
        req({ id: 'r1', status: 'pending' }),
        req({ id: 'r2', status: 'rejected' }),
        req({ id: 'r3', status: 'returned_to_agent' }),
      ],
      new Map(),
      new Map(),
    );
    expect(apps).toEqual([]);
  });

  it('counts stage approvals as approved float and only CFO disbursements as disbursed', () => {
    const items = new Map([['r1', ['s1']], ['r2', ['s2']]]);
    const apps = applicationsFromRequests(
      [
        req({ id: 'r1', status: 'coo_approved', requested_amount: 700000 }),
        req({ id: 'r2', status: 'approved', requested_amount: 300000, disbursed_ledger_txn: 'txn-9' }),
      ],
      items,
      new Map([['a1', 'Jane Agent']]),
    );
    expect(apps.map((a) => a.id).sort()).toEqual(['r1', 'r2']);
    expect(apps.reduce((s, a) => s + a.amount, 0)).toBe(1000000);
    const disbursed = apps.filter((a) => a.disbursed);
    expect(disbursed.map((a) => a.id)).toEqual(['r2']);
    expect(disbursed.reduce((s, a) => s + a.amount, 0)).toBe(300000);
    expect(apps.find((a) => a.id === 'r1')?.tenant_count).toBe(1);
  });

  it('keeps rent received on tenants with no approved float out of the counted totals', () => {
    const covered = new Set(['s1']);
    const split = splitCollections(
      [
        due({ id: 'd1', subscription_id: 's1', amount_collected: 100000, collection_status: 'collected', welile_net: 8000, landlord_net: 90000, payout_status: 'unpaid' }),
        due({ id: 'd2', subscription_id: 's9', amount_collected: 250000, collection_status: 'collected', welile_net: 20000, landlord_net: 225000 }),
      ],
      covered,
      '2026-11',
    );
    expect(split.collectionsTotal).toBe(100000);
    expect(split.collectionsMtd).toBe(100000);
    expect(split.welileNetTotal).toBe(8000);
    expect(split.pendingPayoutsTotal).toBe(90000);
    expect(split.unapprovedCollectionsTotal).toBe(250000);
    expect(split.unapprovedCollectionRows.map((d) => d.id)).toEqual(['d2']);
  });

  it('recognises revenue and payouts only from fully collected rent', () => {
    const split = splitCollections(
      [
        due({ id: 'p1', subscription_id: 's1', amount_collected: 40000, collection_status: 'partial', welile_net: 3200, landlord_net: 36000 }),
        due({ id: 'p2', subscription_id: 's1', amount_collected: 60000, collection_status: 'collected', welile_net: 4800, landlord_net: 54000, payout_status: 'paid' }),
      ],
      new Set(['s1']),
      '2026-11',
    );
    expect(split.collectionsTotal).toBe(100000);
    expect(split.welileNetTotal).toBe(4800);
    expect(split.pendingPayoutsTotal).toBe(0);
  });

  it('names each approved stage in plain English', () => {
    expect(whApplicationLabel('landlord_ops_approved')).toBe('Landlord Ops approved');
    expect(whApplicationLabel('approved')).toBe('Disbursed by the CFO');
  });
});
