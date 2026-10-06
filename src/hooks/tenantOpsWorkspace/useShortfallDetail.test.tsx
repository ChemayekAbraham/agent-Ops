import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import { fetchAllShortfallDetail, fetchShortfallDetail, useShortfallDetail } from './useShortfallDetail';
import { useShortfallBreakdown } from './useShortfallBreakdown';
import { SHORTFALL_BREAKDOWN_RPC, SHORTFALL_DETAIL_RPC } from './shortfallRpcNames';

const BASE = { startIso: '2026-10-05T00:00:00.000Z', endIso: '2026-10-05T23:59:59.999Z' };

function row(i: number, overrides: Record<string, unknown> = {}) {
  return {
    rent_request_id: `rr-${i}`,
    plan_code: `plan${i}`,
    tenant_id: `t-${i}`,
    tenant_name: `Tenant ${i}`,
    tenant_phone: '+256700000001',
    agent_id: 'a-1',
    agent_name: 'Agent One',
    agent_phone: '+256700000002',
    service_centre_id: null,
    service_centre: 'No service centre',
    district: 'Wakiso',
    expected_ugx: '5000.00',
    collected_ugx: 0,
    short_ugx: '5000.00',
    days_behind: null,
    periods_behind: null,
    cadence: 'daily',
    cadence_label: null,
    oldest_unpaid_due: null,
    last_paid_at: null,
    ...overrides,
  };
}

function pageOf(total: number, offset: number, limit: number) {
  const n = Math.max(0, Math.min(limit, total - offset));
  return { total_count: total, total_short_ugx: String(total * 5000), rows: Array.from({ length: n }, (_, k) => row(offset + k)) };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('fetchShortfallDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes every filter to the shortfall detail RPC and maps numbers, nulls and the server-built label', async () => {
    rpcMock.mockResolvedValue({
      data: {
        total_count: 1,
        total_short_ugx: '5000.00',
        rows: [row(1, { days_behind: 14, periods_behind: 2, cadence: 'weekly', cadence_label: '2 weeks' })],
      },
      error: null,
    });

    const res = await fetchShortfallDetail({
      ...BASE, group: 'agent', groupKey: 'a-1', areaLevel: 'village', search: '  joyce ', sort: 'days_behind', dir: 'asc', limit: 25, offset: 50,
    });

    expect(rpcMock).toHaveBeenCalledWith(SHORTFALL_DETAIL_RPC, {
      p_start: BASE.startIso, p_end: BASE.endIso, p_group: 'agent', p_group_key: 'a-1', p_area_level: 'village',
      p_search: 'joyce', p_sort: 'days_behind', p_dir: 'asc', p_limit: 25, p_offset: 50,
    });
    expect(res.totalCount).toBe(1);
    expect(res.totalShortUgx).toBe(5000);
    expect(res.rows[0].expected_ugx).toBe(5000);
    expect(res.rows[0].days_behind).toBe(14);
    expect(res.rows[0].cadence_label).toBe('2 weeks');
    expect(res.rows[0].last_paid_at).toBeNull();
  });

  it('defaults to every short Rent Plan, biggest shortfall first, and sends a blank search as null', async () => {
    rpcMock.mockResolvedValue({ data: pageOf(0, 0, 50), error: null });
    await fetchShortfallDetail({ ...BASE, search: '   ' });
    expect(rpcMock).toHaveBeenCalledWith(SHORTFALL_DETAIL_RPC, expect.objectContaining({
      p_group: null, p_group_key: null, p_search: null, p_sort: 'short_ugx', p_dir: 'desc', p_limit: 50, p_offset: 0,
    }));
  });

  it('throws the RPC error rather than returning empty data', async () => {
    rpcMock.mockResolvedValue({ data: null, error: new Error('not authorized') });
    await expect(fetchShortfallDetail(BASE)).rejects.toThrow('not authorized');
  });
});

describe('fetchAllShortfallDetail (CSV export)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('walks every 200-row page of the same filters until the total is reached', async () => {
    rpcMock.mockImplementation((_fn: string, args: { p_limit: number; p_offset: number }) =>
      Promise.resolve({ data: pageOf(450, args.p_offset, args.p_limit), error: null }));

    const all = await fetchAllShortfallDetail({ ...BASE, group: 'area', groupKey: '50', areaLevel: 'district', search: 'x' });

    expect(rpcMock).toHaveBeenCalledTimes(3);
    expect(rpcMock.mock.calls.map((c) => (c[1] as { p_offset: number }).p_offset)).toEqual([0, 200, 400]);
    expect(rpcMock.mock.calls.every((c) => (c[1] as { p_limit: number }).p_limit === 200)).toBe(true);
    expect(rpcMock.mock.calls.every((c) => (c[1] as { p_group_key: string }).p_group_key === '50')).toBe(true);
    expect(all.rows).toHaveLength(450);
    expect(new Set(all.rows.map((r) => r.rent_request_id)).size).toBe(450);
    expect(all.truncated).toBe(false);
  });

  it('stops after one call when everything fits on the first page', async () => {
    rpcMock.mockImplementation((_fn: string, args: { p_limit: number; p_offset: number }) =>
      Promise.resolve({ data: pageOf(37, args.p_offset, args.p_limit), error: null }));
    const all = await fetchAllShortfallDetail(BASE);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(all.rows).toHaveLength(37);
  });

  it('stops on an empty page instead of looping if the total is out of step with the rows', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: pageOf(1000, 0, 200), error: null })
      .mockResolvedValueOnce({ data: { total_count: 1000, total_short_ugx: '1', rows: [] }, error: null });
    const all = await fetchAllShortfallDetail(BASE);
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(all.rows).toHaveLength(200);
    expect(all.truncated).toBe(true);
  });
});

describe('useShortfallDetail — previous data', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the previous page on screen while the next page loads, but not across a different group', async () => {
    let release: (v: unknown) => void = () => {};
    rpcMock.mockImplementation((_fn: string, args: { p_offset: number; p_group_key: string }) => {
      if (args.p_offset === 25 || args.p_group_key === 'a-2') {
        return new Promise((resolve) => { release = resolve; });
      }
      return Promise.resolve({ data: pageOf(60, args.p_offset, 25), error: null });
    });

    const { result, rerender } = renderHook(
      (p: { groupKey: string; offset: number }) =>
        useShortfallDetail({ ...BASE, group: 'agent', groupKey: p.groupKey, limit: 25, offset: p.offset }),
      { wrapper, initialProps: { groupKey: 'a-1', offset: 0 } },
    );
    await waitFor(() => expect(result.current.data?.rows).toHaveLength(25));
    const firstPage = result.current.data;

    // Next page: previous rows stay mounted while it loads.
    rerender({ groupKey: 'a-1', offset: 25 });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data).toBe(firstPage);
    expect(result.current.isPlaceholderData).toBe(true);

    // Different group: the old group's rows must NOT be shown under the new one.
    rerender({ groupKey: 'a-2', offset: 0 });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data).toBeUndefined();
    release({ data: pageOf(5, 0, 25), error: null });
  });
});

describe('useShortfallBreakdown — previous data', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps rows while the date range changes, never across a different grouping', async () => {
    rpcMock.mockImplementation((_fn: string, args: { p_group: string; p_start: string }) => {
      if (args.p_start === 'later' || args.p_group === 'agent') return new Promise(() => {});
      return Promise.resolve({
        data: [{
          group_key: 'k1', group_name: 'Tenant One', parent_name: '+256700000001', plan_count: 1, tenant_count: 1,
          expected_ugx: '5000', collected_ugx: '0', short_ugx: '5000', short_pct: '100.00',
          avg_days_behind: null, max_days_behind: null, oldest_unpaid_due: null,
        }],
        error: null,
      });
    });

    const { result, rerender } = renderHook(
      (p: { group: 'tenant' | 'agent'; startIso: string }) =>
        useShortfallBreakdown({ startIso: p.startIso, endIso: BASE.endIso, group: p.group }),
      { wrapper, initialProps: { group: 'tenant' as 'tenant' | 'agent', startIso: BASE.startIso } },
    );
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data![0].short_pct).toBe(100);
    expect(result.current.data![0].avg_days_behind).toBeNull();

    rerender({ group: 'tenant', startIso: 'later' });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data).toHaveLength(1);

    rerender({ group: 'agent', startIso: BASE.startIso });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
