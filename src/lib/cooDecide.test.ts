import { describe, expect, it, vi } from 'vitest';
import { classifyCooDecideError, cooDecide, CooDecisionCancelled, cooDecisionSummary, mergeApproveResults } from './cooDecide';

const ok = { decision: 'approve', done: 1, not_followed: 1, items: [{ id: 'a', ok: true, followed: false,
  result: { approved: [{ id: 'a', rent_amount: 100 }], over_cap: [], skipped: [], approved_total: 100, room_left: 5, status: {} } }] };

describe('COO decision reason retry', () => {
  it('following the system is one call with no reason and no question', async () => {
    const call = vi.fn().mockResolvedValue({ data: ok, error: null });
    const ask = vi.fn();
    await cooDecide(call, { ids: ['a'], decision: 'approve' }, ask);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1]).toEqual({ p_request_ids: ['a'], p_decision: 'approve' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('REASON_REQUIRED asks once, then retries with the chosen code', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'REASON_REQUIRED: 1 against the system' } })
      .mockResolvedValueOnce({ data: ok, error: null });
    const ask = vi.fn().mockResolvedValue({ code: 'LANDLORD_DEADLINE' });
    const o = await cooDecide(call, { ids: ['a'], decision: 'approve' }, ask);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ needsText: false }));
    expect(call.mock.calls[1][1]).toEqual({ p_request_ids: ['a'], p_decision: 'approve', p_reason_code: 'LANDLORD_DEADLINE' });
    expect(o.reasonCode).toBe('LANDLORD_DEADLINE');
  });

  it('"needs a short explanation" asks for text and sends it', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'Reason OTHER needs a short explanation' } })
      .mockResolvedValueOnce({ data: ok, error: null });
    const ask = vi.fn().mockResolvedValue({ code: 'OTHER', text: 'Landlord leaving town today' });
    await cooDecide(call, { ids: ['a'], decision: 'approve', reasonCode: 'OTHER' }, ask);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ needsText: true, code: 'OTHER' }));
    expect(call.mock.calls[1][1].p_reason_text).toBe('Landlord leaving town today');
  });

  it('a return keeps the dialog reason as p_reason_text on the retry', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'REASON_REQUIRED' } })
      .mockResolvedValueOnce({ data: { ...ok, decision: 'return' }, error: null });
    await cooDecide(call, { ids: ['a'], decision: 'return', reasonText: 'Wrong landlord phone' }, async () => ({ code: 'X' }));
    expect(call.mock.calls[1][1]).toEqual({ p_request_ids: ['a'], p_decision: 'return', p_reason_code: 'X', p_reason_text: 'Wrong landlord phone' });
  });

  it('cancelling the picker writes nothing more', async () => {
    const call = vi.fn().mockResolvedValue({ data: null, error: { message: 'REASON_REQUIRED' } });
    await expect(cooDecide(call, { ids: ['a'], decision: 'approve' }, async () => null)).rejects.toBeInstanceOf(CooDecisionCancelled);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('other errors are not treated as a reason request', () => {
    expect(classifyCooDecideError('OVER_BUDGET: no room')).toBeNull();
  });

  it('rebuilds the approval shape and the summary line', () => {
    const r = mergeApproveResults(ok as never);
    expect(r.approved.map((a) => a.id)).toEqual(['a']);
    expect(r.approved_total).toBe(100);
    expect(cooDecisionSummary(ok as never, 'Landlord deadline')).toBe('1 done, 1 against the system (reason: Landlord deadline)');
  });
});
