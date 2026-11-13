import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

import { collectionInfoLine, fetchMyCollectionPct, formatPct, parseCollectionPct } from '@/lib/agentCollectionInfo';

beforeEach(() => mocks.rpc.mockReset());

describe('E100: collection is information, never a gate', () => {
  it('reads pct from the 50% rule, or collected ÷ due', () => {
    expect(parseCollectionPct({ eligible: true, pct: 52.8 })).toBe(52.8);
    expect(parseCollectionPct([{ pct: '31' }])).toBe(31);
    expect(parseCollectionPct(JSON.stringify({ due: 200000, collected: 105600 }))).toBe(52.8);
    expect(parseCollectionPct({ due: 0, collected: 0 })).toBeNull();
    expect(parseCollectionPct(null)).toBeNull();
  });

  it('asks agent_eligibility_of for the agent, and gives null when it cannot', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { pct: 52.8 }, error: null });
    await expect(fetchMyCollectionPct('veron')).resolves.toBe(52.8);
    expect(mocks.rpc).toHaveBeenCalledWith('agent_eligibility_of', { p_agent: 'veron' });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    await expect(fetchMyCollectionPct('veron')).resolves.toBeNull();
  });

  it('says it as the COO wrote it', () => {
    expect(formatPct(52.8)).toBe('52.8');
    expect(formatPct(53)).toBe('53');
    expect(collectionInfoLine(52.8)).toBe(
      "Your collection: 52.8% of what is due across all your plans. Below 50%, your requests still move but wait at the COO desk and can't be funded.",
    );
  });
});
