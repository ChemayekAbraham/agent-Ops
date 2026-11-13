import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { returnCycleAnchor, returnCycleMonth } from '@/lib/returnCycle';

// Exercise the actual handler's read-only preflight plus the request insert, so the rules that
// gate a Return (CFO permission, misdated-key correction) are tested against the real code.
const source = readFileSync(resolve(__dirname, '../components/coo/COOPartnersPage.tsx'), 'utf8');
const start = source.indexOf('      let roiAmount =', source.indexOf('  const handlePay = async'));
const endMarker = '      if (pendErr) throw pendErr;';
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('Nearing Payout handler shape changed — update this test');
const preflight = source.slice(start, end + endMarker.length)
  .replace('let roiAmount =', 'let roiAmount =')
  .replace(/ as unknown as Array<\{ id: string; max_amount: number \| null; requester_id: string \| null \}>/g, '')
  .replace(/ as unknown\[\] \| null/g, '')
  .replace(/ as never/g, '')
  .replace(/: string \| null/g, '');
const run = new Function(
  'supabase', 'toast', 'setProcessing', 'generateRef', 'returnCycleAnchor', 'returnCycleMonth',
  'p', 'mode', 'reason', 'correctionReason', 'getSessionCheckedUser', 'safeUUID', 'managedInfo', 'formatUGX',
  `return (async () => { ${preflight}\n return { overrideId, roiAmount }; })();`,
);
const portfolio = { portfolioId: 'daeb181e-cf9e-47f9-a184-5bdac542a714', name: 'Musa Sekalaala', investmentAmount: 4025000, roiPercentage: 15, nextRoiDate: '2026-10-28' };
const permission = { id: '50222bdd-a60d-40c1-9e40-3f35351a7a28', max_amount: 603750, requester_id: 'requester' };
/** Ruth Amaa's live case: October's UGX 185,750 was saved under the November cycle key. */
const correctable = { ...portfolio, name: 'Ruth Amaa', nextRoiDate: '2026-11-13', correctionEligible: true, misdatedPaidOn: '2026-10-14', misdatedAmount: 185750 };
const GOOD_REASON = 'October payout was saved under the November cycle key by mistake';

async function check(options: {
  override?: typeof permission | null; user?: string; pending?: boolean; credited?: boolean; claimed?: boolean;
  error?: object; correction?: string; target?: typeof portfolio;
} = {}) {
  const filters: unknown[][] = [];
  const inserted: Record<string, unknown>[] = [];
  const toast = { error: vi.fn(), success: vi.fn() };
  const from = vi.fn((table: string) => {
    const answer = table === 'portfolio_return_cycle_overrides'
      ? { data: options.override ? [options.override] : [], error: options.error }
      : { data: (table === 'pending_wallet_operations' ? options.pending : table === 'general_ledger' ? options.credited : options.claimed !== false) ? [{ id: 'existing' }] : [] };
    const query: Record<string, unknown> = { then: (resolve: (value: unknown) => unknown) => Promise.resolve(answer).then(resolve) };
    for (const method of ['select', 'eq', 'is', 'gt', 'in', 'limit']) query[method] = (...args: unknown[]) => { filters.push([table, method, ...args]); return query; };
    query.insert = (payload: Record<string, unknown>) => { inserted.push(payload); return Promise.resolve({ error: null }); };
    return query;
  });
  const supabase = { from, auth: { getUser: async () => ({ data: { user: { id: options.user ?? 'requester' } } }) } };
  const p = options.target ?? portfolio;
  const result = await run(
    supabase, toast, vi.fn(), () => 'PAY-test', returnCycleAnchor, returnCycleMonth,
    p, 'wallet', 'Payout for the cycle', options.correction,
    async () => ({ data: { user: { id: options.user ?? 'requester' } } }),
    () => '11111111-1111-4111-8111-111111111111', {}, (n: number) => `UGX ${n}`,
  );
  return { result, toast, filters, inserted };
}

describe('Nearing Payout CFO permission preflight', () => {
  it('permits Musa’s UGX 603,750 request despite the original October claim', async () => {
    const { result, toast, filters } = await check({ override: permission });
    expect(result).toEqual({ overrideId: permission.id, roiAmount: 603750 });
    expect(toast.error).not.toHaveBeenCalled();
    expect(filters).toContainEqual(['portfolio_return_cycle_overrides', 'eq', 'cycle_month', '2026-10-01']);
    expect(filters).toContainEqual(['portfolio_return_cycle_overrides', 'is', 'consumed_at', null]);
    expect(filters).toContainEqual(['portfolio_return_cycle_overrides', 'is', 'revoked_at', null]);
    expect(filters.some(f => f[0] === 'portfolio_return_cycle_overrides' && f[1] === 'gt' && f[2] === 'expires_at')).toBe(true);
  });
  it('also honors permission when an original legacy ledger mark exists', async () => {
    expect((await check({ override: permission, credited: true })).result?.overrideId).toBe(permission.id);
  });
  it('does not let another account use the requester’s permission', async () => {
    const { result, toast } = await check({ override: permission, user: 'other' });
    expect(result).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Only the person'), expect.anything());
  });
  it('never queues again while another payout is pending', async () => {
    const { result, toast } = await check({ override: permission, pending: true });
    expect(result).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith('Payout already in the approval queue', expect.anything());
  });
  it('retains the already-paid block without a valid permission', async () => {
    const { result, toast } = await check();
    expect(result).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith('Already paid this cycle', expect.anything());
  });
  it('caps the request at the CFO-approved amount', async () => {
    expect((await check({ override: { ...permission, max_amount: 500000 } })).result?.roiAmount).toBe(500000);
  });
  it('stops when the fresh permission read fails', async () => {
    await expect(check({ error: { message: 'permission read failed' } })).rejects.toMatchObject({ message: 'permission read failed' });
  });
});

describe('Nearing Payout correction for a misdated cycle key', () => {
  it('queues Ruth Amaa’s November Return for COO approval despite the misdated October credit', async () => {
    const { result, toast, inserted } = await check({
      target: correctable, credited: true, claimed: true, correction: GOOD_REASON,
    });
    expect(result).toEqual({ overrideId: null, roiAmount: 603750 });
    expect(toast.error).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    const op = inserted[0];
    expect(op).toMatchObject({
      status: 'pending_coo_approval',
      category: 'roi_payout',
      amount: 603750,
      source_id: correctable.portfolioId,
    });
    expect(op.metadata).toMatchObject({ correction: 'misdated_cycle_key', correction_reason: GOOD_REASON, cycle_anchor: '2026-11-13' });
  });
  it('refuses a correction reason shorter than 20 characters', async () => {
    const { result, toast, inserted } = await check({ target: correctable, credited: true, correction: 'wrong month' });
    expect(result).toBeUndefined();
    expect(inserted).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledWith('Correction not possible', expect.objectContaining({
      description: 'Give a correction reason of at least 20 characters.',
    }));
  });
  it('refuses a correction the database does not confirm', async () => {
    const { result, toast, inserted } = await check({ target: correctable, credited: true, correction: GOOD_REASON });
    expect(result).toEqual({ overrideId: null, roiAmount: 603750 });
    expect(inserted).toHaveLength(1);
    const notConfirmed = { ...correctable, correctionEligible: false };
    const { result: r2, toast: t2, inserted: i2 } = await check({ target: notConfirmed, credited: true, correction: GOOD_REASON });
    expect(r2).toBeUndefined();
    expect(i2).toHaveLength(0);
    expect(t2.error).toHaveBeenCalledWith('Correction not possible', expect.objectContaining({
      description: `${notConfirmed.name}'s 2026-11-13 cycle is not blocked by a misdated payout.`,
    }));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
