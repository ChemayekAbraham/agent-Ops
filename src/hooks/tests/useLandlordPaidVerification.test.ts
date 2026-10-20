import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
import { fetchFilteredLandlordPaidList } from '../useLandlordPaidLists';

beforeEach(() => rpc.mockReset());
describe('paid verification full-list fetching', () => {
  it('includes rejected landlords beyond the first server page and retains search and paid scope', async () => {
    rpc.mockResolvedValueOnce({ data: { total: 3, rows: [{ landlord_id: 'v', verified: true, verification_status: 'verified' }, { landlord_id: 'p', verified: false, verification_status: 'pending' }] }, error: null });
    rpc.mockResolvedValueOnce({ data: { total: 3, rows: [{ landlord_id: 'r', verified: false, verification_status: 'rejected' }] }, error: null });
    const data = await fetchFilteredLandlordPaidList('paid_repaying', ' Sarah ', 'rejected');
    expect(data.total).toBe(1);
    expect(data.rows.map(row => row.landlord_id)).toEqual(['r']);
    expect(rpc).toHaveBeenLastCalledWith('landlord_ops_paid_lists', { p_tab: 'paid_repaying', p_search: 'Sarah', p_limit: 200, p_offset: 2 });
  });
  it('does not silently return partial matches if a subsequent page fails', async () => {
    rpc.mockResolvedValueOnce({ data: { total: 2, rows: [{ landlord_id: 'p', verified: false, verification_status: 'pending' }] }, error: null });
    rpc.mockResolvedValueOnce({ data: null, error: new Error('timeout') });
    await expect(fetchFilteredLandlordPaidList('paid_repaying', '', 'not_verified')).rejects.toThrow('timeout');
  });
});