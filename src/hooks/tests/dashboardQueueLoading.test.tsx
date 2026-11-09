import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { usePendingAdvanceCount } from '@/hooks/usePendingAdvanceCount';
import { useCfoAdvanceDisbursementCount } from '@/hooks/useCfoAdvanceDisbursementCount';
import { useCfoApprovalNotifications } from '@/hooks/useCfoApprovalNotifications';

const mocks = vi.hoisted(() => ({ from: vi.fn(), channel: vi.fn(), subscribe: vi.fn(), removeChannel: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: mocks }));
let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const response = () => Promise.resolve({ count: 7, error: null });
  mocks.from.mockReturnValue({ select: () => ({ eq: response, in: response }) });
  const channel = { on: () => channel, subscribe: mocks.subscribe };
  mocks.channel.mockReturnValue(channel); mocks.subscribe.mockReturnValue(channel);
});
describe('Inactive dashboard queue badges', () => {
  it.each([usePendingAdvanceCount, useCfoAdvanceDisbursementCount])('defers requests and realtime until the section is needed', async (hook) => {
    const { result, rerender } = renderHook(({ active }) => hook(active), { initialProps: { active: false }, wrapper });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.channel).not.toHaveBeenCalled();
    rerender({ active: true });
    await waitFor(() => expect(result.current).toBe(7));
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    rerender({ active: false });
    expect(mocks.removeChannel).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(7);
  });
  it('defers all CFO approval notification queue reads until the bell opens', async () => {
    const response = { count: 2, error: null };
    const chain: any = { select: () => chain, eq: () => chain, in: () => chain, or: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(response).then(resolve) };
    mocks.from.mockReturnValue(chain);
    const { result, rerender } = renderHook(({ open }) => useCfoApprovalNotifications(open), { initialProps: { open: false }, wrapper });
    expect(mocks.from).not.toHaveBeenCalled();
    rerender({ open: true });
    await waitFor(() => expect(result.current.total).toBe(28));
    expect(mocks.from).toHaveBeenCalledTimes(14);
  });
});