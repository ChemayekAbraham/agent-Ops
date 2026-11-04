import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpc = vi.fn();
const auth = {
  user: { id: 'user-1' } as { id: string } | null,
  loading: false,
  rolesResolved: true,
  roles: ['agent', 'supporter'] as string[],
  enabledRoles: ['supporter'] as string[],
};
const session = {
  current: { user: { id: 'user-1' } } as { user: { id: string } } | null,
};
const roleRow = { current: null as { role: string } | null };

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => auth,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: {
      getSession: () => Promise.resolve({ data: { session: session.current }, error: null }),
    },
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: roleRow.current, error: null });
      return chain;
    },
  },
}));

import {
  readCommunication,
  useCommunicationAcknowledgement,
  useCommunicationInbox,
} from './useCrmCommunications';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function inboxCalls() {
  return rpc.mock.calls.filter(([name]) => name === 'crm_communication_inbox');
}

describe('useCommunicationInbox', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: [], error: null });
    auth.user = { id: 'user-1' };
    auth.loading = false;
    auth.rolesResolved = true;
    auth.roles = ['agent', 'supporter'];
    auth.enabledRoles = ['supporter'];
    session.current = { user: { id: 'user-1' } };
    roleRow.current = null;
  });

  it('does not call crm_communication_inbox for a synthetic agent role', async () => {
    renderHook(() => useCommunicationInbox('agent', true), { wrapper });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(inboxCalls()).toHaveLength(0);
  });

  it('calls the inbox for a role the user has enabled', async () => {
    auth.enabledRoles = ['agent', 'supporter'];
    const { result } = renderHook(() => useCommunicationInbox('agent', true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(inboxCalls()).toHaveLength(1);
    expect(inboxCalls()[0]?.[1]).toEqual({ p_role: 'agent' });
  });

  it('does not call while roles are still unresolved', async () => {
    auth.rolesResolved = false;
    auth.enabledRoles = ['agent'];
    renderHook(() => useCommunicationInbox('agent', true), { wrapper });
    await act(async () => { await Promise.resolve(); });
    expect(inboxCalls()).toHaveLength(0);
  });
});

describe('readCommunication', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: [{ id: 'm1' }], error: null });
    session.current = { user: { id: 'user-1' } };
    roleRow.current = null;
  });

  it('does not call the inbox when that role is not enabled', async () => {
    await expect(readCommunication('agent', 'm1')).resolves.toBeNull();
    expect(inboxCalls()).toHaveLength(0);
  });

  it('reads one message when the role is enabled', async () => {
    roleRow.current = { role: 'agent' };
    await expect(readCommunication('agent', 'm1')).resolves.toMatchObject({ id: 'm1' });
    expect(inboxCalls()).toHaveLength(1);
    expect(inboxCalls()[0]?.[1]).toEqual({ p_role: 'agent', p_id: 'm1' });
  });
});

describe('useCommunicationAcknowledgement', () => {
  beforeEach(() => {
    rpc.mockReset();
    auth.rolesResolved = true;
    auth.enabledRoles = ['supporter'];
  });

  it('does not acknowledge through a role the user does not have enabled', async () => {
    const { result } = renderHook(() => useCommunicationAcknowledgement('agent'), { wrapper });
    await expect(result.current.mutateAsync('m1')).rejects.toThrow(/authorised dashboard/);
    expect(rpc).not.toHaveBeenCalled();
  });
});
