import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rest: {},
    rpc(this: { rest?: unknown } | undefined, ...args: unknown[]) {
      if (!this?.rest) throw new TypeError("Cannot read properties of undefined (reading 'rest')");
      return rpcMock(...args);
    },
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ roles: ['crm'] }) }));

import { useAutocallOverview, useAutocallCampaigns, useAutocallScripts, useAutocallCalls, useAutocallPauses } from './useVoiceAutocall';

beforeEach(() => rpcMock.mockReset());
afterEach(cleanup);

describe('Automated Calls client connection', () => {
  it.each([
    ['overview', () => useAutocallOverview(), 'voice_autocall_overview'],
    ['campaigns', () => useAutocallCampaigns(), 'voice_autocall_campaigns_list'],
    ['scripts', () => useAutocallScripts(), 'voice_autocall_scripts_list'],
    ['call log', () => useAutocallCalls({}), 'voice_autocall_calls_feed'],
    ['paused people', () => useAutocallPauses(), 'voice_autocall_pauses_list'],
  ] as const)('preserves the Supabase receiver for %s', async (_view, useView, functionName) => {
    const response = { connected: true };
    rpcMock.mockResolvedValue({ data: response, error: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, unmount } = renderHook(useView, { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual(response);
    expect(rpcMock.mock.calls[0]?.[0]).toBe(functionName);
    unmount();
    client.clear();
  });
});