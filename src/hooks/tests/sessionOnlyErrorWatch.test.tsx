import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useWeeklyChampionTeam } from '@/hooks/useAgentCollectionLeague';
import { useMyEliteRank } from '@/components/agent/AgentRankCelebrationDialog';
import { pendingForMe } from '@/hr/bonuses/api';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), rpc: vi.fn(),
  auth: { user: { id: 'agent-1' }, session: { user: { id: 'agent-1' }, access_token: 'test-token' }, loading: false, roles: ['agent'] },
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, auth: { getSession: mocks.getSession } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mocks.auth }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } })}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ data: { session: mocks.auth.session }, error: null });
  mocks.rpc.mockResolvedValue({ data: [], error: null });
});

describe('error-watch session-only reads', () => {
  for (const [name, hook] of [['get_agent_weekly_champion_team', useWeeklyChampionTeam], ['get_my_elite_rank', useMyEliteRank]] as const) {
    it(`${name} skips a missing live session despite stale React auth and never retries`, async () => {
      mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
      const { result, unmount } = renderHook(() => hook(), { wrapper });
      await waitFor(() => expect(result.current.isError).toBe(true));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
      expect(mocks.getSession).toHaveBeenCalledTimes(1);
      expect(mocks.rpc).not.toHaveBeenCalled();
      unmount();
    });

    it(`${name} still reads when signed in and does not retry a permission refusal`, async () => {
      mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: `permission denied for function ${name}` } });
      const { result, unmount } = renderHook(() => hook(), { wrapper });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mocks.rpc.mock.calls[0][0]).toBe(name);
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
      unmount();
    });
  }

  it('hr_pay_bonus_pending_for_me skips signed-out and expired sessions', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await pendingForMe()).toEqual([]);
    mocks.getSession.mockResolvedValue({ data: { session: { ...mocks.auth.session, expires_at: 1 } }, error: null });
    expect(await pendingForMe()).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('hr_pay_bonus_pending_for_me preserves signed-in results', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ pool_id: 'pool-1' }], error: null });
    expect(await pendingForMe()).toEqual([{ pool_id: 'pool-1' }]);
    expect(mocks.rpc).toHaveBeenCalledWith('hr_pay_bonus_pending_for_me');
  });
});