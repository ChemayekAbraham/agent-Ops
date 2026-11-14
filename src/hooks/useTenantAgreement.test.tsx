import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Supabase: no acceptance yet; inserts are counted ----------------------
let acceptedRow: Record<string, unknown> | null = null;
const insertSpy = vi.fn();
vi.mock('@/integrations/supabase/client', () => {
  const selectChain = {
    eq: () => selectChain,
    order: () => selectChain,
    limit: () => selectChain,
    maybeSingle: async () => ({ data: acceptedRow, error: null }),
  };
  return {
    supabase: {
      from: () => ({
        select: () => selectChain,
        insert: (row: Record<string, unknown>) => {
          insertSpy(row);
          acceptedRow = { id: 'a1', accepted_at: '2026-11-14T10:22:07Z', ...row };
          return { select: () => ({ single: async () => ({ data: acceptedRow, error: null }) }) };
        },
      }),
    },
  };
});
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'tenant-1' } }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import TenantAgreementNotice from '@/components/tenant/agreement/TenantAgreementNotice';
import { useTenantAgreement, __resetTenantAgreementStore } from './useTenantAgreement';

/** Stands in for the agreement pop-up: a separate component, its own hook call. */
function AcceptButton() {
  const { acceptAgreement } = useTenantAgreement();
  return <button onClick={() => void acceptAgreement()}>I Agree</button>;
}

beforeEach(() => {
  __resetTenantAgreementStore();
  acceptedRow = null;
  insertSpy.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ip: '1.2.3.4' }) })));
});

describe('tenant agreement shared across the dashboard', () => {
  it('hides the "must accept" banner as soon as the pop-up accepts', async () => {
    render(<><TenantAgreementNotice onAcceptClick={() => {}} /><AcceptButton /></>);
    expect(await screen.findByText(/You must accept Terms to continue/)).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByText('I Agree')); });

    await waitFor(() => expect(screen.queryByText(/You must accept Terms to continue/)).toBeNull());
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it('does not save a second acceptance when tapped again', async () => {
    render(<AcceptButton />);
    await act(async () => { fireEvent.click(screen.getByText('I Agree')); });
    await act(async () => { fireEvent.click(screen.getByText('I Agree')); });
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it('shows no banner for a tenant who accepted before', async () => {
    acceptedRow = { id: 'old', status: 'accepted' };
    render(<TenantAgreementNotice onAcceptClick={() => {}} />);
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(screen.queryByText(/You must accept Terms to continue/)).toBeNull();
  });
});
