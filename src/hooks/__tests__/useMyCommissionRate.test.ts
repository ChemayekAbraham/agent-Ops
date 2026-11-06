import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));

import {
  FALLBACK_COMMISSION_RATE,
  formatRateLabel,
  parseCommissionRate,
} from '@/hooks/useMyCommissionRate';
import { commissionLineLabel } from '@/lib/rentCollectionReceipt';

describe('parseCommissionRate (get_my_commission_rate jsonb)', () => {
  it('reads a sub-agent on 6% with a 2% parent override', () => {
    expect(
      parseCommissionRate({
        agent_rate: 0.06, recruiter_rate: 0.02, total_rate: 0.08,
        is_subagent: true, whitelisted: false, recruiter_id: 'p1', label: '6%',
      }),
    ).toEqual({
      agentRate: 0.06, recruiterRate: 0.02, totalRate: 0.08,
      isSubagent: true, whitelisted: false, label: '6%',
    });
  });

  it('reads a whitelisted sub-agent keeping the full 8%', () => {
    const r = parseCommissionRate({
      agent_rate: 0.08, recruiter_rate: 0, total_rate: 0.08,
      is_subagent: true, whitelisted: true, label: '8%',
    });
    expect(r.agentRate).toBe(0.08);
    expect(r.recruiterRate).toBe(0);
    expect(r.whitelisted).toBe(true);
  });

  it('accepts numeric strings and derives a missing label', () => {
    const r = parseCommissionRate({ agent_rate: '0.06', recruiter_rate: '0.02' });
    expect(r.agentRate).toBe(0.06);
    expect(r.totalRate).toBeCloseTo(0.08, 10);
    expect(r.label).toBe('6%');
  });

  it('falls back to the 8% no-parent rate on junk', () => {
    expect(parseCommissionRate(null)).toEqual(FALLBACK_COMMISSION_RATE);
    expect(parseCommissionRate([1, 2])).toEqual(FALLBACK_COMMISSION_RATE);
    expect(FALLBACK_COMMISSION_RATE.agentRate).toBe(0.08);
    expect(FALLBACK_COMMISSION_RATE.label).toBe('8%');
  });

  it('formats labels without float noise', () => {
    expect(formatRateLabel(0.08)).toBe('8%');
    expect(formatRateLabel(0.06)).toBe('6%');
    expect(formatRateLabel(0.065)).toBe('6.5%');
  });
});

describe('commissionLineLabel (rent collection receipt)', () => {
  const base = {
    reference: 'r', tenantName: 't', totalCollected: 100_000,
    tenantDeducted: 100_000, agentDeducted: 0, reason: 'x', date: new Date(0),
  };

  it('uses the server label when given', () => {
    expect(commissionLineLabel({ ...base, commissionPaid: 6_000, commissionRateLabel: '6%' }))
      .toBe('Agent commission (6%)');
  });

  it('derives the rate from what was paid, never a hard-coded 10%', () => {
    expect(commissionLineLabel({ ...base, commissionPaid: 8_000 })).toBe('Agent commission (8%)');
    expect(commissionLineLabel({ ...base, commissionPaid: 6_000 })).toBe('Agent commission (6%)');
  });

  it('omits the rate when nothing was paid', () => {
    expect(commissionLineLabel({ ...base, commissionPaid: 0 })).toBe('Agent commission');
  });
});
