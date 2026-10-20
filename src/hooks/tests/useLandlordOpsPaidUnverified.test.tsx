import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke } } }));
import { fetchLandlordReport, useLandlordOpsList, useLandlordScopedCounts } from '../useLandlordOps';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => invoke.mockReset());

describe('paid unverified landlord server contract', () => {
  it('keeps the paid-unverified category when searching and paginating', async () => {
    invoke.mockResolvedValue({ data: { rows: [{ id: 'pending-paid', verification_status: 'pending' }, { id: 'rejected-paid', verification_status: 'rejected' }], totalMatched: 23 }, error: null });
    const { result } = renderHook(() => useLandlordOpsList({ search: 'Mukama', sort: 'oldest', category: 'paid_unverified', pendingFilter: 'all', page: 2, perPage: 20 }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invoke).toHaveBeenCalledWith('landlord-ops', { body: { action: 'rows', search: 'Mukama', sort: 'oldest', category: 'paid_unverified', pending_filter: 'all', limit: 20, offset: 20 } });
    expect(result.current.data?.rows.map(row => row.id)).toEqual(['pending-paid', 'rejected-paid']);
  });

  it('uses the server count instead of the visible page length', async () => {
    invoke.mockResolvedValue({ data: { counts: { paid_unverified: 23 } }, error: null });
    const { result } = renderHook(() => useLandlordScopedCounts({ search: '' }), { wrapper });
    await waitFor(() => expect(result.current.data?.counts.paid_unverified).toBe(23));
  });

  it('exports the same category without applying pending-only quick filters', async () => {
    invoke.mockResolvedValue({ data: { rows: [], totalMatched: 0 }, error: null });
    await fetchLandlordReport({ category: 'paid_unverified', pendingFilter: 'all', search: 'Mukama' });
    expect(invoke).toHaveBeenCalledWith('landlord-ops', { body: { action: 'report', category: 'paid_unverified', pending_filter: 'all', search: 'Mukama' } });
  });

  it('surfaces an unavailable server filter rather than returning an all-landlords list', async () => {
    invoke.mockResolvedValue({ data: { error: 'Filter update unavailable' }, error: null });
    await expect(fetchLandlordReport({ category: 'paid_unverified', pendingFilter: 'all', search: '' })).rejects.toThrow('Filter update unavailable');
  });
});