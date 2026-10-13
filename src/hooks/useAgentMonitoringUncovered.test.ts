import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
vi.mock('@/lib/kampalaDays', () => ({ kampalaTodayYmd: () => '2026-10-13' }));

import { fetchUncoveredPlans, toUncoveredRow } from './useAgentMonitoringUncovered';

const row = (id: string, bucket: string, extra: Record<string, unknown> = {}, total = 3) => ({
  rent_request_id: id, bucket, tenant_id: `t-${id}`, tenant_name: `Tenant ${id}`, tenant_phone: '0700000000',
  agent_id: 'a1', agent_name: 'Agent One', funded_amount: '300000.00', total_repayment: '360000.00',
  repaid: '60000.00', still_owed: '300000.00', funded_on: '2026-09-01', days_since_funding: 42,
  payout_kind: 'none', payout_paid_amount: '0', payout_allocated_amount: '0', pipeline_status: 'repaying',
  total_rows: total, ...extra,
});

describe('fetchUncoveredPlans', () => {
  beforeEach(() => rpc.mockReset());

  it('makes one call for the whole list and splits it into the two lists', async () => {
    rpc.mockResolvedValue({
      data: [row('1', 'tenant_paying_no_landlord'), row('2', 'awaiting_landlord'), row('3', 'tenant_paying_no_landlord')],
      error: null,
    });
    const out = await fetchUncoveredPlans();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('am_uncovered_plans', { p_as_at: '2026-10-13', p_limit: 500, p_offset: 0 });
    expect(out.tenantPaying.map((r) => r.id)).toEqual(['1', '3']);
    expect(out.awaiting.map((r) => r.id)).toEqual(['2']);
    expect(out.asOf).toBe('2026-10-13');
  });

  it('keeps reading pages until the server total is reached', async () => {
    rpc
      .mockResolvedValueOnce({ data: Array.from({ length: 500 }, (_, i) => row(`a${i}`, 'awaiting_landlord', {}, 520)), error: null })
      .mockResolvedValueOnce({ data: Array.from({ length: 20 }, (_, i) => row(`b${i}`, 'awaiting_landlord', {}, 520)), error: null });
    const out = await fetchUncoveredPlans();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_offset: 500 });
    expect(out.awaiting).toHaveLength(520);
  });

  it('returns two empty lists when there are no uncovered plans', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const out = await fetchUncoveredPlans();
    expect(out.tenantPaying).toEqual([]);
    expect(out.awaiting).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('throws the server message when the call fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Not authorized' } });
    await expect(fetchUncoveredPlans()).rejects.toThrow('Not authorized');
  });
});

describe('toUncoveredRow', () => {
  it('turns the server row into the list row, including the part-paid amount', () => {
    const out = toUncoveredRow(row('9', 'tenant_paying_no_landlord', {
      payout_kind: 'part_paid', payout_paid_amount: '150000.00', payout_allocated_amount: '300000.00',
    }) as never);
    expect(out).toMatchObject({
      id: '9', tenantName: 'Tenant 9', agentName: 'Agent One', fundedAmount: 300000, totalRepayment: 360000,
      repaid: 60000, stillOwed: 300000, fundedOn: '2026-09-01', daysSinceFunding: 42, pipelineStatus: 'repaying',
      payout: { kind: 'part_paid', paidAmount: 150000, allocatedAmount: 300000 },
    });
  });

  it('falls back to readable names when the profile has none', () => {
    const a = toUncoveredRow(row('1', 'awaiting_landlord', { tenant_name: null, agent_name: null }) as never);
    expect(a.tenantName).toBe('Unnamed tenant');
    expect(a.agentName).toBe('Unnamed agent');
    const b = toUncoveredRow(row('2', 'awaiting_landlord', { agent_id: null, agent_name: null }) as never);
    expect(b.agentName).toBe('No agent');
  });
});
