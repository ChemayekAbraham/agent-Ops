import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

import { fetchClassificationRowsForExport } from './useTenantClassification';

const row = (i: number, total: number) => ({ tenant_id: `t${i}`, total_rows: total });
const filters = { category: 'dormant' as const, sub: 'renewal_in_progress' as const, needsReview: true, search: ' ann ' };

describe('fetchClassificationRowsForExport', () => {
  beforeEach(() => rpc.mockReset());

  it('passes the filter to the list function and reads pages until it has every row', async () => {
    rpc
      .mockResolvedValueOnce({ data: Array.from({ length: 1000 }, (_, i) => row(i, 1200)), error: null })
      .mockResolvedValueOnce({ data: Array.from({ length: 200 }, (_, i) => row(1000 + i, 1200)), error: null });
    const out = await fetchClassificationRowsForExport(filters);
    expect(out.rows).toHaveLength(1200);
    expect(out.total).toBe(1200);
    expect(out.truncated).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(['tops_tenant_classification_list', {
      p_category: 'dormant', p_sub: 'renewal_in_progress', p_search: 'ann', p_limit: 1000, p_offset: 0, p_needs_review: true,
    }]);
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_offset: 1000 });
  });

  it('stops at the cap and says the export was cut short', async () => {
    rpc.mockResolvedValue({ data: Array.from({ length: 1000 }, (_, i) => row(i, 57751)), error: null });
    const out = await fetchClassificationRowsForExport({ ...filters, category: null, sub: null, needsReview: false, search: '' }, 2500);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[2][1]).toMatchObject({ p_limit: 500, p_offset: 2000, p_category: null, p_search: null });
    expect(out.rows).toHaveLength(3000);
    expect(out.total).toBe(57751);
    expect(out.truncated).toBe(true);
  });

  it('returns nothing for an empty filter and throws the server message on failure', async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await fetchClassificationRowsForExport(filters)).toEqual({ rows: [], total: 0, truncated: false });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'not authorized' } });
    await expect(fetchClassificationRowsForExport(filters)).rejects.toThrow('not authorized');
  });
});
