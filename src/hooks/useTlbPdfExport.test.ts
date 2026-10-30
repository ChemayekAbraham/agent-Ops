import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const m = vi.hoisted(() => ({
  fetchMulti: vi.fn(), log: vi.fn(), build: vi.fn(), deliver: vi.fn(), touch: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('@/hooks/useTenantLocationsBrowser', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useTenantLocationsBrowser')>()),
  fetchTlbTenantsMulti: m.fetchMulti, logTlbLocationPdfExport: m.log,
}));
vi.mock('@/lib/tenantLocationReportPdf', () => ({
  buildTenantLocationPdf: m.build, deliverPdf: m.deliver, isTouchDevice: m.touch,
}));

import { useTlbPdfExport } from './useTlbPdfExport';
import { placeFromPath } from '@/hooks/useTenantLocationsBrowser';

const places = [placeFromPath({ region: 'Central', districtId: 7, districtName: 'Kampala' })];
const built = { blob: new Blob(['x']), filename: 'f.pdf' };

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.fetchMulti.mockResolvedValue({ rows: [], total: 10 });
  m.log.mockResolvedValue(undefined);
  m.build.mockReturnValue(built);
  m.deliver.mockResolvedValue('downloaded');
  m.touch.mockReturnValue(false);
});

describe('useTlbPdfExport', () => {
  it('desktop: fetches everything, audits, builds, downloads', async () => {
    const { result } = renderHook(() => useTlbPdfExport());
    await act(() => result.current.generate(places, 'active', 'Ops'));
    expect(m.fetchMulti).toHaveBeenCalledWith(places, 'active');
    expect(m.log).toHaveBeenCalledWith({ places, tenants: 10, status: 'active' });
    expect(m.deliver).toHaveBeenCalledWith(built.blob, 'f.pdf');
    expect(result.current.state.phase).toBe('done');
  });

  it('touch: generates first and waits for the next tap before sharing', async () => {
    m.touch.mockReturnValue(true);
    const { result } = renderHook(() => useTlbPdfExport());
    await act(() => result.current.generate(places, 'all', 'Ops'));
    expect(result.current.state.phase).toBe('ready');
    expect(m.deliver).not.toHaveBeenCalled();
    await act(() => result.current.deliver());
    expect(m.deliver).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe('done');
  });

  it('touch: cancelling the share sheet keeps the PDF ready', async () => {
    m.touch.mockReturnValue(true);
    m.deliver.mockResolvedValue('cancelled');
    const { result } = renderHook(() => useTlbPdfExport());
    await act(() => result.current.generate(places, 'all', 'Ops'));
    await act(() => result.current.deliver());
    expect(result.current.state.phase).toBe('ready');
  });

  it('refuses beyond 5000 tenants without auditing or building', async () => {
    m.fetchMulti.mockResolvedValue({ rows: [], total: 5001 });
    const { result } = renderHook(() => useTlbPdfExport());
    await act(() => result.current.generate(places, 'all', 'Ops'));
    expect(result.current.state).toMatchObject({ phase: 'error' });
    expect((result.current.state as { message: string }).message).toMatch(/Select fewer places/);
    expect(m.log).not.toHaveBeenCalled();
    expect(m.build).not.toHaveBeenCalled();
  });

  it('does not hand over the PDF when the audit write fails', async () => {
    m.log.mockRejectedValue(new Error('rls'));
    const { result } = renderHook(() => useTlbPdfExport());
    await act(() => result.current.generate(places, 'all', 'Ops'));
    expect(result.current.state.phase).toBe('error');
    expect(m.build).not.toHaveBeenCalled();
    expect(m.deliver).not.toHaveBeenCalled();
  });
});
