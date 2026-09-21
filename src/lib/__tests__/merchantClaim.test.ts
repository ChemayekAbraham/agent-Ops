import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CLAIM_MESSAGES, isAmbiguousTransportError, outcomeFromClaimResponse, outcomeFromClaimStatus, outcomeFromRpcError,
  reconcileClaim, removeFromQueuePage, upsertClaimedRow, readCachedActiveClaims, persistActiveClaims,
  type ClaimStatusResponse,
} from '../merchantClaim';

const claimRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  assigned_cashout_agent_id: 'desk-A',
  dispatched_at: '2026-09-12T01:00:00Z',
  amount: 10000,
  status: 'pending',
  mobile_money_number: '0731727650',
  mobile_money_name: 'Nabwire Resty',
  profiles: { full_name: 'Nabwire Resty', phone: '+256731727650' },
  ...extra,
});

describe('claim RPC response -> visible outcome', () => {
  it('success carries the full claim so it renders without a second read', () => {
    const o = outcomeFromClaimResponse({ success: true, idempotent: false, claim: claimRow('X') });
    expect(o).toMatchObject({ kind: 'claimed', idempotent: false, message: CLAIM_MESSAGES.claimed });
    expect(o.kind === 'claimed' && o.claim?.id).toBe('X');
  });

  it('idempotent retry is "already yours", never an error', () => {
    const o = outcomeFromClaimResponse({ success: true, idempotent: true, already_owned_by_you: true, claim: claimRow('X') });
    expect(o).toMatchObject({ kind: 'claimed', idempotent: true, message: CLAIM_MESSAGES.alreadyYours });
  });

  it.each([
    ['already_claimed', 'rejected', CLAIM_MESSAGES.otherAgent],
    ['not_available', 'rejected', CLAIM_MESSAGES.closed],
    ['claim_failed', 'not_claimed_retry', 'Nothing was reserved'],
  ])('%s -> %s', (error, kind, msg) => {
    const o = outcomeFromClaimResponse({ success: false, error, message: error === 'claim_failed' ? 'Nothing was reserved or assigned' : 'x' });
    expect(o.kind).toBe(kind);
    expect('message' in o && o.message).toContain(msg);
  });

  it('active claim elsewhere -> blocked with the blocking id', () => {
    const o = outcomeFromClaimResponse({ success: false, error: 'active_claim_exists', blocking_withdrawal_id: 'X' });
    expect(o).toEqual({ kind: 'blocked_active_claim', blockingWithdrawalId: 'X', message: CLAIM_MESSAGES.finishExisting });
  });

  it('permission, priority and float refusals keep the server explanation', () => {
    expect(outcomeFromClaimResponse({ success: false, error: 'not_authorized_for_payout', message: 'outside your channels' }))
      .toMatchObject({ kind: 'rejected', tone: 'error', message: 'outside your channels' });
    expect(outcomeFromClaimResponse({ success: false, error: 'proxy_priority_hold', message: 'Priority Proxy first' }))
      .toMatchObject({ kind: 'rejected', message: 'Priority Proxy first' });
    expect(outcomeFromClaimResponse({ success: false, error: 'pool_exhausted', result_code: 'CLAIM_RESERVATION_FAILED', message: 'needs UGX 10,500' }))
      .toMatchObject({ kind: 'rejected', message: 'needs UGX 10,500' });
  });

  it('dispatch pop-up response (ok key) maps the same way', () => {
    expect(outcomeFromClaimResponse({ ok: true, success: true, claim: claimRow('X') }).kind).toBe('claimed');
    expect(outcomeFromClaimResponse({ ok: false, error: 'already_claimed' }).kind).toBe('rejected');
  });

  it('a missing / unreadable body is ambiguous, not a failure', () => {
    expect(outcomeFromClaimResponse(null)).toEqual({ kind: 'ambiguous' });
    expect(outcomeFromClaimResponse({})).toEqual({ kind: 'ambiguous' });
  });
});

describe('transport errors: unknown vs definite', () => {
  it.each([
    [{ name: 'AbortError', message: 'aborted' }, false, true],
    [{ name: 'TypeError', message: 'Failed to fetch' }, false, true],
    [{ message: 'TypeError: Failed to fetch', code: '' }, false, true],
    [{ status: 504, code: 'PGRST000', message: 'gateway timeout' }, false, true],
    [{ status: 0, message: '' }, false, true],
    [{ message: 'anything' }, true, true],
    [{ status: 404, code: 'PGRST202', message: 'function not found' }, false, false],
    [{ status: 403, code: '42501', message: 'permission denied' }, false, false],
  ])('%j aborted=%s -> ambiguous=%s', (err, aborted, expected) => {
    expect(isAmbiguousTransportError(err, aborted as boolean)).toBe(expected);
  });
});

describe('RPC errors', () => {
  it('a lost/aborted request is ambiguous; a coded 4xx is a definite refusal with its message', () => {
    expect(outcomeFromRpcError({ name: 'TypeError', message: 'Failed to fetch' })).toEqual({ kind: 'ambiguous' });
    expect(outcomeFromRpcError(null, true)).toEqual({ kind: 'ambiguous' });
    expect(outcomeFromRpcError({ status: 403, code: '42501', message: 'permission denied' }))
      .toEqual({ kind: 'rejected', code: '42501', tone: 'error', message: 'permission denied' });
  });
});

describe('TEST 6 — response lost after the server committed', () => {
  it('reconciliation finds the claim is ours -> success with the claim to render', async () => {
    const fetchStatus = vi.fn(async (): Promise<ClaimStatusResponse> => ({ state: 'mine', claim: claimRow('X') }));
    const o = await reconcileClaim(fetchStatus, { sleep: async () => {} });
    expect(o).toMatchObject({ kind: 'claimed', idempotent: true, message: CLAIM_MESSAGES.recoveredAfterNetwork });
    expect(o.kind === 'claimed' && o.claim?.id).toBe('X');
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps asking through connectivity failures, then answers definitely', async () => {
    let n = 0;
    const fetchStatus = vi.fn(async (): Promise<ClaimStatusResponse> => {
      n++;
      if (n < 3) throw new TypeError('Failed to fetch');
      return { state: 'mine', claim: claimRow('X') };
    });
    const o = await reconcileClaim(fetchStatus, { sleep: async () => {} });
    expect(o.kind).toBe('claimed');
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it.each<[ClaimStatusResponse['state'], string, string]>([
    ['other', 'rejected', CLAIM_MESSAGES.otherAgent],
    ['unassigned', 'not_claimed_retry', CLAIM_MESSAGES.notClaimed],
    ['not_actionable', 'rejected', CLAIM_MESSAGES.closed],
  ])('server says %s -> %s', async (state, kind, message) => {
    const o = await reconcileClaim(async () => ({ state }), { sleep: async () => {} });
    expect(o).toMatchObject({ kind, message });
  });

  it('still unreachable -> UNKNOWN ("do not pay"), never "claim failed"', async () => {
    const o = await reconcileClaim(async () => { throw new TypeError('Failed to fetch'); }, { attempts: 3, sleep: async () => {} });
    expect(o).toEqual({ kind: 'unconfirmed', message: CLAIM_MESSAGES.unconfirmed });
    expect(outcomeFromClaimStatus({ state: 'unknown' }).kind).toBe('unconfirmed');
  });
});

describe('TEST 8 — returned claim is shown immediately (cache writes, no refetch)', () => {
  it('adds the claim to "Claimed by you" and removes it from the queue page', () => {
    const claimed = upsertClaimedRow([], claimRow('X'));
    expect(claimed.map((r) => r.id)).toEqual(['X']);
    const page = { rows: [{ id: 'X' }, { id: 'Y' }], count: 2 };
    expect(removeFromQueuePage(page, 'X')).toEqual({ rows: [{ id: 'Y' }], count: 1 });
  });

  it('a retry replaces (never duplicates) the cached claim; order follows dispatched_at', () => {
    const earlier = claimRow('W', { dispatched_at: '2026-09-12T00:00:00Z' });
    const first = upsertClaimedRow([earlier], claimRow('X', { amount: 1 }));
    const again = upsertClaimedRow(first, claimRow('X', { amount: 2 }));
    expect(again.map((r) => r.id)).toEqual(['W', 'X']);
    expect(again.find((r) => r.id === 'X')?.amount).toBe(2);
  });

  it('leaves pages without the row untouched', () => {
    const page = { rows: [{ id: 'Y' }], count: 1 };
    expect(removeFromQueuePage(page, 'X')).toBe(page);
    expect(removeFromQueuePage(undefined, 'X')).toBeUndefined();
  });
});

describe('TEST 9 — local display cache survives a mobile browser discarding the page', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips what was persisted', () => {
    persistActiveClaims('agent-1', [claimRow('X')]);
    expect(readCachedActiveClaims('agent-1')).toEqual([claimRow('X')]);
  });

  it('is scoped per user — another user id sees nothing', () => {
    persistActiveClaims('agent-1', [claimRow('X')]);
    expect(readCachedActiveClaims('agent-2')).toEqual([]);
  });

  it('clears the entry when the live list becomes empty (claim completed/released)', () => {
    persistActiveClaims('agent-1', [claimRow('X')]);
    persistActiveClaims('agent-1', []);
    expect(readCachedActiveClaims('agent-1')).toEqual([]);
  });

  it('never throws for a missing/no user id', () => {
    expect(() => persistActiveClaims(undefined, [claimRow('X')])).not.toThrow();
    expect(readCachedActiveClaims(undefined)).toEqual([]);
    expect(readCachedActiveClaims(null)).toEqual([]);
  });

  it('treats corrupted JSON as no cache rather than throwing', () => {
    localStorage.setItem('welile:cashout-active-claims:agent-1', 'not json');
    expect(readCachedActiveClaims('agent-1')).toEqual([]);
  });

  it('discards an entry older than the max age instead of showing stale ghost claims', () => {
    const key = 'welile:cashout-active-claims:agent-1';
    localStorage.setItem(key, JSON.stringify({ at: Date.now() - 7 * 60 * 60 * 1000, claims: [claimRow('X')] }));
    expect(readCachedActiveClaims('agent-1')).toEqual([]);
  });

  it('keeps a recent entry within the max age', () => {
    const key = 'welile:cashout-active-claims:agent-1';
    localStorage.setItem(key, JSON.stringify({ at: Date.now() - 60 * 1000, claims: [claimRow('X')] }));
    expect(readCachedActiveClaims('agent-1')).toEqual([claimRow('X')]);
  });
});
