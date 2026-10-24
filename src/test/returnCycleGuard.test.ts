import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reserveReturnCycle, wasPostedBeforeThisCall, isPartnerReturnCredit } from '../../supabase/functions/_shared/returnCycleGuard';
import { returnCycleAnchor, returnCycleMonth } from '@/lib/returnCycle';

/**
 * Partner Return duplicate-payment guard — approval side and screens, with a MOCKED database client.
 * No network, no Supabase project, no payment service. The real-database guarantees (locks, unique index,
 * ledger backstop, concurrency) are proven in src/__tests__/returnCycleGuard.integration.test.ts against an
 * isolated local Postgres.
 */

const CLAIM = '9f0c7b1e-1111-4222-8333-444455556666';
const KEY = `return-cycle:${CLAIM}:cash`;
const OP = 'a1b2c3d4-0000-4000-8000-000000000001';

const client = (answer: { data?: unknown; error?: { code?: string; message?: string } | null } | Error) => ({
  rpc: vi.fn(async (_fn: string, _args: Record<string, unknown>) => {
    if (answer instanceof Error) throw answer;
    return { data: answer.data ?? null, error: answer.error ?? null };
  }),
});

describe('reserveReturnCycle (approval decision)', () => {
  it('asks the database for this request\'s reservation, by operation id only', async () => {
    const c = client({ data: { applies: true, claim_id: CLAIM, ledger_key: KEY, already_posted: false, advance_next_roi_date: true } });
    const d = await reserveReturnCycle(c, OP);
    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(c.rpc).toHaveBeenCalledWith('claim_return_cycle_for_operation', { p_operation_id: OP });
    expect(d).toMatchObject({ action: 'post', ledgerKey: KEY });
  });

  it('a retry whose Return is already in the ledger posts nothing', async () => {
    const d = await reserveReturnCycle(client({ data: { applies: true, claim_id: CLAIM, ledger_key: KEY, already_posted: true } }), OP);
    expect(d.action).toBe('already_posted');
  });

  it('a cycle that already has a Return is a duplicate (reject the request)', async () => {
    const d = await reserveReturnCycle(client({ error: { code: '23505', message: 'Duplicate Return blocked: portfolio WIP1 (already_claimed)' } }), OP);
    expect(d).toMatchObject({ action: 'blocked', duplicate: true, code: '23505' });
  });

  it.each([
    ['23514', 'not yet due / too close / before reliable history'],
    ['42501', 'override missing, used, expired or same person'],
    ['22023', 'invalid cycle date'],
    ['P0002', 'operation or portfolio not found'],
  ])('a deliberate refusal %s (%s) blocks without calling it a duplicate', async (code) => {
    const d = await reserveReturnCycle(client({ error: { code, message: 'refused' } }), OP);
    expect(d).toMatchObject({ action: 'blocked', duplicate: false, code });
  });

  it('fails closed when the database function is missing (migration not applied yet)', async () => {
    const d = await reserveReturnCycle(client({ error: { code: 'PGRST202', message: 'Could not find the function' } }), OP);
    expect(d.action).toBe('fail_closed');
  });

  it('fails closed on a network error', async () => {
    const d = await reserveReturnCycle(client(new Error('fetch failed')), OP);
    expect(d.action).toBe('fail_closed');
  });

  it.each([
    [{ applies: true }],
    [{ applies: true, ledger_key: `roi-cycle-${CLAIM}-2026-10-07` }],
    [{ applies: true, ledger_key: `return-cycle:${CLAIM}:retained` }],
    [{ applies: 'yes', ledger_key: KEY }],
    [null],
  ])('fails closed on an unexpected answer %j', async (data) => {
    const d = await reserveReturnCycle(client({ data }), OP);
    expect(d.action).toBe('fail_closed');
  });

  it('a non-portfolio Return is outside the cycle guard', async () => {
    expect((await reserveReturnCycle(client({ data: { applies: false } }), OP)).action).toBe('not_a_portfolio_return');
  });

  it('keeps a catch-up from moving the schedule', async () => {
    const d = await reserveReturnCycle(client({ data: { applies: true, ledger_key: KEY, advance_next_roi_date: false } }), OP);
    expect(d.action === 'post' && d.reservation.advance_next_roi_date).toBe(false);
  });

  it('concurrent approvals of the same request: both get the same key, so the ledger posts once', async () => {
    const c = client({ data: { applies: true, claim_id: CLAIM, ledger_key: KEY, already_posted: false } });
    const [a, b] = await Promise.all([reserveReturnCycle(c, OP), reserveReturnCycle(c, OP)]);
    expect(a.action === 'post' && b.action === 'post' && a.ledgerKey === b.ledgerKey).toBe(true);
  });
});

describe('wasPostedBeforeThisCall (idempotent hit on the ledger key)', () => {
  const start = Date.parse('2026-10-24T08:00:00Z');
  it('a row older than this call means another approval posted it', () => {
    expect(wasPostedBeforeThisCall('2026-10-24T07:59:57Z', start)).toBe(true);
  });
  it('a row written by this call is ours', () => {
    expect(wasPostedBeforeThisCall('2026-10-24T08:00:00.300Z', start)).toBe(false);
  });
  it('no row / unreadable date is not treated as a hit', () => {
    expect(wasPostedBeforeThisCall(null, start)).toBe(false);
    expect(wasPostedBeforeThisCall('not a date', start)).toBe(false);
  });
});

describe('isPartnerReturnCredit (direct and scheduled credits)', () => {
  it('flags any credit coded as a Partner Return', () => {
    expect(isPartnerReturnCredit('credit', 'roi_wallet_credit', 'roi_expense')).toBe(true);
    expect(isPartnerReturnCredit('credit', 'roi_payout', 'system_balance_correction')).toBe(true);
    expect(isPartnerReturnCredit('credit', 'wallet_deposit', 'roi_expense')).toBe(true);
  });
  it('leaves debits and other categories alone', () => {
    expect(isPartnerReturnCredit('debit', 'roi_wallet_credit', 'roi_expense')).toBe(false);
    expect(isPartnerReturnCredit('credit', 'wallet_transfer', 'wallet_transfer')).toBe(false);
    expect(isPartnerReturnCredit('credit', 'agent_commission_earned', 'agent_commission_earned')).toBe(false);
  });
});

describe('returnCycle helpers', () => {
  it('names the cycle from next_roi_date, then the effective payout date, then today', () => {
    expect(returnCycleAnchor({ nextRoiDate: '2026-09-10', nextPayoutDate: '2026-09-11' })).toBe('2026-09-10');
    expect(returnCycleAnchor({ nextRoiDate: null, nextPayoutDate: '2026-09-11T00:00:00Z' })).toBe('2026-09-11');
    expect(returnCycleAnchor({ nextRoiDate: '', nextPayoutDate: '' }, new Date(2026, 9, 24))).toBe('2026-10-24');
  });
  it('a cycle is the calendar month: the 10th and the 11th are the same cycle', () => {
    expect(returnCycleMonth('2026-09-10')).toBe('2026-09-01');
    expect(returnCycleMonth('2026-09-11')).toBe(returnCycleMonth('2026-09-10'));
    expect(returnCycleMonth('2026-10-10')).not.toBe(returnCycleMonth('2026-09-30'));
    expect(() => returnCycleMonth('Sep 10')).toThrow();
  });
});

const ROOT = resolve(__dirname, '..', '..');
const approveSrc = readFileSync(resolve(ROOT, 'supabase/functions/approve-wallet-operation/index.ts'), 'utf8');
const cooSrc = readFileSync(resolve(ROOT, 'src/components/coo/COOPartnersPage.tsx'), 'utf8');

describe('approve-wallet-operation uses the database reservation (source guards)', () => {
  it('derives the posting key only from the reservation', () => {
    expect(approveSrc).toMatch(/import \{ reserveReturnCycle, wasPostedBeforeThisCall \} from '\.\.\/_shared\/returnCycleGuard\.ts'/);
    expect(approveSrc).toMatch(/const decision = await reserveReturnCycle\(adminClient, op\.id\)/);
    expect(approveSrc).toMatch(/roiCycleKey = decision\.ledgerKey;/);
    expect(approveSrc).toMatch(/idempotency_key: roiCycleKey \?\? undefined/);
  });
  it('no longer builds a key from correction_key, cycle_anchor or the date', () => {
    expect(approveSrc).not.toMatch(/roi-cycle-correction-\$\{/);
    expect(approveSrc).not.toMatch(/`roi-cycle-\$\{op\.source_id\}/);
    expect(approveSrc).not.toMatch(/metadata\?\.cycle_anchor/);
  });
  it('posts nothing on fail_closed, blocked or already_posted', () => {
    for (const action of ['fail_closed', 'blocked', 'already_posted']) {
      const block = approveSrc.slice(approveSrc.indexOf(`decision.action === '${action}'`));
      expect(block.slice(0, block.indexOf('continue;'))).not.toMatch(/create_ledger_transaction|apply_wallet_movement/);
    }
  });
  it('a concurrent idempotent hit stops before wallet recovery and does not mark the request rejected', () => {
    const hit = approveSrc.slice(approveSrc.indexOf('if (wasPostedBeforeThisCall('));
    const body = hit.slice(0, hit.indexOf('continue;'));
    expect(body).not.toMatch(/status: 'rejected'/);
    expect(approveSrc.indexOf('if (wasPostedBeforeThisCall(')).toBeLessThan(approveSrc.indexOf("rpc('apply_wallet_movement'"));
  });
  it('only advances next_roi_date when the reservation says so', () => {
    expect(approveSrc).toMatch(/if \(advanceNextRoiDate && \(op\.category === 'roi_payout'/);
  });
});

describe('every other manual path is closed (source guards)', () => {
  const directSrc = readFileSync(resolve(ROOT, 'supabase/functions/cfo-direct-credit/index.ts'), 'utf8');
  it('cfo-direct-credit refuses a Return credit before it posts anything', () => {
    const guardAt = directSrc.indexOf('if (isPartnerReturnCredit(op, walletCat, platformCat))');
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(directSrc.indexOf("rpc('create_ledger_transaction'") === -1 ? Infinity : directSrc.indexOf("rpc('create_ledger_transaction'"));
    expect(guardAt).toBeLessThan(directSrc.indexOf('.rpc("create_ledger_transaction"') === -1 ? Infinity : directSrc.indexOf('.rpc("create_ledger_transaction"'));
    expect(directSrc.slice(guardAt, guardAt + 600)).toMatch(/RETURN_CREDIT_NOT_ALLOWED_HERE/);
  });
  it('approval refuses a Return request that names no portfolio', () => {
    expect(approveSrc).toMatch(/if \(op\.category === 'roi_payout' && !\(op\.source_table === 'investor_portfolios' && op\.source_id\)\) \{/);
  });
});

describe('COO screens name the cycle and post before changing the portfolio (source guards)', () => {
  it('a payout request pins its cycle', () => {
    expect(cooSrc).toMatch(/cycle_anchor: cycleAnchor,/);
  });
  it('every compound and split posting states its cycle date', () => {
    const blocks = cooSrc.split("rpc('post_portfolio_roi_ledger'").slice(1).map((b) => b.slice(0, b.indexOf('} as never)')));
    expect(blocks).toHaveLength(3);
    for (const b of blocks) expect(b).toMatch(/p_cycle_date: /);
  });
  it('the three handlers leave the portfolio change to the server (same transaction as the posting)', () => {
    for (const start of ['const handlePortfolioCompound = async', 'const handleCompound = async', 'const handleSplitPayout = async']) {
      const src = cooSrc.replace(/\r\n/g, '\n');
      const from = src.indexOf(start);
      const end = src.indexOf('\n  };\n', from);
      expect(from).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(from);
      const body = src.slice(from, end);
      expect(body).toMatch(/rpc\('post_portfolio_roi_ledger'/);
      expect(body).not.toMatch(/\.from\('investor_portfolios'\)\s*\.update\(/);
    }
  });
});
