/**
 * useAddTenantNoPaymentNote: the "add note" mutation for the 20+ Days No
 * Payment tab's Notes feature. Must always attribute the note to the
 * currently signed-in user, reject before writing when nobody is signed in,
 * reject an empty note, and never touch anything but
 * tenant_no_payment_notes (append-only — no update/delete path exists).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAddTenantNoPaymentNote } from './useTenantNoPaymentNotes';
import { supabase } from '@/integrations/supabase/client';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: vi.fn() },
    from: vi.fn(),
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useAddTenantNoPaymentNote', () => {
  let insertMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (supabase.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { user: { id: 'officer-1' } } });
    insertMock = vi.fn().mockResolvedValue({ error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert: insertMock });
  });

  it('inserts a note attributed to the currently signed-in user', async () => {
    const { result } = renderHook(() => useAddTenantNoPaymentNote(), { wrapper });

    await result.current.mutateAsync({ tenantId: 'tenant-1', note: 'Called tenant, no answer.' });

    expect(supabase.from).toHaveBeenCalledWith('tenant_no_payment_notes');
    expect(insertMock).toHaveBeenCalledWith({
      tenant_id: 'tenant-1',
      note: 'Called tenant, no answer.',
      created_by: 'officer-1',
    });
  });

  it('trims the note content before inserting', async () => {
    const { result } = renderHook(() => useAddTenantNoPaymentNote(), { wrapper });

    await result.current.mutateAsync({ tenantId: 'tenant-1', note: '  Promised payment by Friday.  ' });

    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'Promised payment by Friday.' }),
    );
  });

  it('rejects an empty (or whitespace-only) note before touching the database', async () => {
    const { result } = renderHook(() => useAddTenantNoPaymentNote(), { wrapper });

    await expect(result.current.mutateAsync({ tenantId: 'tenant-1', note: '   ' })).rejects.toThrow(
      'Note cannot be empty.',
    );
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('rejects when no session user is present, before touching the database', async () => {
    (supabase.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { user: null } });
    const { result } = renderHook(() => useAddTenantNoPaymentNote(), { wrapper });

    await expect(
      result.current.mutateAsync({ tenantId: 'tenant-1', note: 'Called tenant.' }),
    ).rejects.toThrow('You must be signed in to add a note.');
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('surfaces a database error rather than silently succeeding', async () => {
    insertMock.mockResolvedValue({ error: { message: 'permission denied' } });
    const { result } = renderHook(() => useAddTenantNoPaymentNote(), { wrapper });

    await expect(
      result.current.mutateAsync({ tenantId: 'tenant-1', note: 'Called tenant.' }),
    ).rejects.toThrow('permission denied');
  });
});
