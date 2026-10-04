import { describe, it, expect } from 'vitest';
import {
  isProxyInitiatedWithdrawal, isUrgentProxyWithdrawal, isUrgentProxyBlocking,
  findBlockingUrgentProxy, sortProxyPriorityFirst, proxyPriorityClaimBlockReason,
  PROXY_PRIORITY_BLOCK_MESSAGE, URGENT_PROXY_PRIORITY,
} from '../proxyPriorityQueue';

const base = {
  status: 'pending',
  processed_at: null,
  fin_ops_reference: null,
  assigned_cashout_agent_id: null,
};

const normal = (id: string, created = '2026-08-17T08:00:00Z') => ({
  ...base, id, created_at: created, user_id: 'u1', priority_level: 'standard',
});

const proxy = (id: string, created = '2026-08-17T09:00:00Z') => ({
  ...base, id, created_at: created,
  user_id: 'partner-1', agent_id: 'agent-1', initiated_by: 'agent-1',
  proxy_partner_id: 'partner-1',
  reason: '[Proxy initiated by agent agent-1] partner payout',
  priority_level: URGENT_PROXY_PRIORITY,
});

describe('proxy agent withdrawal creation', () => {
  it('classifies a proxy-initiated withdrawal as urgent', () => {
    expect(isProxyInitiatedWithdrawal(proxy('p1'))).toBe(true);
    expect(isUrgentProxyWithdrawal(proxy('p1'))).toBe(true);
  });

  it('detects a proxy row even when priority_level was not stamped', () => {
    const row = { ...proxy('p1'), priority_level: 'standard' };
    expect(isUrgentProxyWithdrawal(row)).toBe(true);
  });

  it('detects proxy rows by agent-initiated-for-other-user shape only', () => {
    const row = {
      ...base, id: 'p2', user_id: 'partner-9', agent_id: 'agent-9',
      initiated_by: 'agent-9', proxy_partner_id: null, reason: 'payout',
      priority_level: 'standard', created_at: '2026-08-17T09:00:00Z',
    };
    expect(isUrgentProxyWithdrawal(row)).toBe(true);
  });

  it('leaves normal merchant withdrawals as non-urgent', () => {
    expect(isUrgentProxyWithdrawal(normal('n1'))).toBe(false);
  });
});

describe('priority ordering', () => {
  it('puts the urgent proxy withdrawal at the top of the queue', () => {
    const rows = [normal('n1'), normal('n2'), proxy('p1')];
    expect(sortProxyPriorityFirst(rows).map((r) => r.id)).toEqual(['p1', 'n1', 'n2']);
  });

  it('orders multiple proxy withdrawals oldest-first ahead of all normals', () => {
    const rows = [
      normal('n1'),
      proxy('p-late', '2026-08-17T10:00:00Z'),
      proxy('p-early', '2026-08-17T06:00:00Z'),
      normal('n2'),
    ];
    expect(sortProxyPriorityFirst(rows).map((r) => r.id)).toEqual(['p-early', 'p-late', 'n1', 'n2']);
  });

  it('preserves relative order of normal payouts', () => {
    const rows = [normal('n1'), normal('n2'), normal('n3')];
    expect(sortProxyPriorityFirst(rows).map((r) => r.id)).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('blocking normal claims', () => {
  const rows = [normal('n1'), proxy('p1')];

  it('blocks a normal payout while the proxy payout is unclaimed', () => {
    expect(proxyPriorityClaimBlockReason(normal('n1'), rows)).toBe(PROXY_PRIORITY_BLOCK_MESSAGE);
  });

  it('allows the urgent proxy payout itself to be claimed', () => {
    expect(proxyPriorityClaimBlockReason(proxy('p1'), rows)).toBeNull();
  });

  it('identifies the oldest unresolved proxy payout as the blocker', () => {
    const many = [normal('n1'), proxy('p-late', '2026-08-17T10:00:00Z'), proxy('p-early', '2026-08-17T06:00:00Z')];
    expect(findBlockingUrgentProxy(many)?.id).toBe('p-early');
  });
});

describe('successful proxy claim releases the hold', () => {
  it('stops blocking once the proxy payout is claimed by an agent', () => {
    const claimed = { ...proxy('p1'), assigned_cashout_agent_id: 'merchant-row-1' };
    expect(isUrgentProxyBlocking(claimed)).toBe(false);
    expect(proxyPriorityClaimBlockReason(normal('n1'), [normal('n1'), claimed])).toBeNull();
  });
});

describe('queue release after resolution', () => {
  it.each(['completed', 'paid', 'cancelled', 'failed', 'rejected'])(
    'releases the queue when the proxy payout is %s',
    (status) => {
      const resolved = { ...proxy('p1'), status };
      expect(isUrgentProxyBlocking(resolved)).toBe(false);
      expect(proxyPriorityClaimBlockReason(normal('n1'), [normal('n1'), resolved])).toBeNull();
    },
  );

  it('releases when settlement evidence exists even if status lags', () => {
    const settled = { ...proxy('p1'), processed_at: '2026-08-17T10:00:00Z' };
    expect(isUrgentProxyBlocking(settled)).toBe(false);
    const referenced = { ...proxy('p2'), fin_ops_reference: 'TID123' };
    expect(isUrgentProxyBlocking(referenced)).toBe(false);
  });
});

describe('simultaneous claim attempts', () => {
  it('blocks every normal payout for every agent while the proxy payout waits', () => {
    const rows = [normal('n1'), normal('n2'), normal('n3'), proxy('p1')];
    const reasons = ['n1', 'n2', 'n3'].map((id) =>
      proxyPriorityClaimBlockReason(rows.find((r) => r.id === id), rows),
    );
    expect(reasons).toEqual([
      PROXY_PRIORITY_BLOCK_MESSAGE, PROXY_PRIORITY_BLOCK_MESSAGE, PROXY_PRIORITY_BLOCK_MESSAGE,
    ]);
  });

  it('still blocks normals while one proxy payout is claimed and another waits', () => {
    const rows = [
      normal('n1'),
      { ...proxy('p1'), assigned_cashout_agent_id: 'merchant-row-1' },
      proxy('p2', '2026-08-17T11:00:00Z'),
    ];
    expect(proxyPriorityClaimBlockReason(normal('n1'), rows)).toBe(PROXY_PRIORITY_BLOCK_MESSAGE);
    expect(findBlockingUrgentProxy(rows)?.id).toBe('p2');
  });
});

describe('idempotent / repeated claim requests', () => {
  it('is stable across repeated evaluations of the same payout', () => {
    const rows = [normal('n1'), proxy('p1')];
    const results = [1, 2, 3].map(() => proxyPriorityClaimBlockReason(normal('n1'), rows));
    expect(new Set(results).size).toBe(1);
  });

  it('never blocks the proxy payout from being re-submitted by its claimer', () => {
    const claimed = { ...proxy('p1'), assigned_cashout_agent_id: 'merchant-row-1' };
    expect(proxyPriorityClaimBlockReason(claimed, [claimed])).toBeNull();
  });

  it('treats an empty queue as unblocked', () => {
    expect(proxyPriorityClaimBlockReason(normal('n1'), [])).toBeNull();
    expect(findBlockingUrgentProxy(undefined)).toBeNull();
  });
});