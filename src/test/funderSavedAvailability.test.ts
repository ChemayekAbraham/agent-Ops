import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
vi.mock('@/hooks/useAuthenticatedPoll', () => ({ requireUserSession: vi.fn().mockResolvedValue(undefined) }));
import { loadFunderSavedItems } from '@/components/funder-new/loadFunderSavedItems';

describe('saved opportunity availability', () => {
  beforeEach(() => { rpc.mockReset(); });
  const signal = () => new AbortController().signal;
  const response = (data: unknown, error: unknown = null) => ({ abortSignal: () => Promise.resolve({ data, error }) });
  it('checks both saved types independently of the visible filters', async () => {
    rpc.mockImplementation((name: string) => response(name === 'agent_list_empty_house_opportunities'
      ? { houses: [{ house_id: 'house-1' }] } : { plans: [{ rent_request_id: 'plan-1' }] }));
    const result = await loadFunderSavedItems({ empty: ['house-1', 'claimed-house'], ready: ['plan-1', 'taken-plan'] }, signal());
    expect(result.map((entry) => entry.category)).toEqual(['empty', 'ready']);
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_search');
    expect(rpc.mock.calls[1][1]).not.toHaveProperty('p_city');
  });
  it('does not infer unavailability from a partial page', async () => {
    rpc.mockImplementation((_name: string, args: { p_offset: number }) => response({ houses: args.p_offset === 0
      ? Array.from({ length: 100 }, (_, i) => ({ house_id: `other-${i}` })) : [{ house_id: 'saved-on-next-page' }] }));
    const result = await loadFunderSavedItems({ empty: ['saved-on-next-page'], ready: [] }, signal());
    expect(result).toEqual([{ category: 'empty', item: { house_id: 'saved-on-next-page' } }]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('fails rather than authorizing deletion when availability cannot be read', async () => {
    rpc.mockReturnValue(response(null, new Error('Not authorized')));
    await expect(loadFunderSavedItems({ empty: ['keep-me'], ready: [] }, signal())).rejects.toThrow('Not authorized');
  });
  it('fails on malformed availability rather than treating it as an empty market', async () => {
    rpc.mockReturnValue(response({}));
    await expect(loadFunderSavedItems({ empty: ['keep-me'], ready: [] }, signal())).rejects.toThrow('incomplete');
  });
});