import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import {
  AGENT_DAILY_ELIGIBILITY_BATCH,
  chunkAgentIds,
  fetchAgentDailyEligibility,
} from './agentDailyEligibilityBatch';

describe('chunkAgentIds', () => {
  it('caps every batch at 25 ids', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `agent-${i}`);
    const chunks = chunkAgentIds(ids);
    expect(AGENT_DAILY_ELIGIBILITY_BATCH).toBe(25);
    expect(chunks.map((chunk) => chunk.length)).toEqual([25, 25, 10]);
    expect(chunks.flat()).toEqual(ids);
  });

  it('drops blanks and repeats without reordering the first sighting', () => {
    expect(chunkAgentIds(['b', '', 'a', 'b', 'a'], 2)).toEqual([['b', 'a']]);
    expect(chunkAgentIds([])).toEqual([]);
  });

  it('rejects a batch size that would not cap the call', () => {
    expect(() => chunkAgentIds(['a'], 0)).toThrow(/positive integer/);
  });
});

describe('fetchAgentDailyEligibility', () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it('sends at most 25 ids per RPC and keeps every returned row', async () => {
    rpc.mockImplementation(async (_name: string, args: { p_agent_ids: string[] }) => ({
      data: args.p_agent_ids.map((agent_id) => ({ agent_id, expected_daily: 1 })),
      error: null,
    }));
    const ids = Array.from({ length: 30 }, (_, i) => `agent-${i}`);
    const { rows, error } = await fetchAgentDailyEligibility(ids);
    expect(error).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][0]).toBe('get_agent_daily_eligibility');
    expect(rpc.mock.calls[0][1].p_agent_ids).toHaveLength(25);
    expect(rpc.mock.calls[1][1].p_agent_ids).toHaveLength(5);
    expect(rows.map((row) => row.agent_id)).toEqual(ids);
  });

  it('returns no rows when one batch fails, so the others are not treated as a complete answer', async () => {
    rpc
      .mockResolvedValueOnce({ data: [{ agent_id: 'a', expected_daily: 10 }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'statement timeout' } });
    const ids = Array.from({ length: 26 }, (_, i) => `agent-${i}`);
    const { rows, error } = await fetchAgentDailyEligibility(ids);
    expect(rows).toEqual([]);
    expect(error).toEqual({ message: 'statement timeout' });
  });
});
