import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const mock = vi.hoisted(() => ({ user: null as null | { id: string }, invoke: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mock.user }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: mock.invoke } } }));
import { useAssistantAccess } from '@/hooks/useAssistantAccess';
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>; }
beforeEach(() => { mock.user = null; mock.invoke.mockReset(); });
describe('public assistant access', () => {
  it('shows the assistant signed out without a personal access request', () => {
    const { result } = renderHook(useAssistantAccess, { wrapper });
    expect(result.current).toMatchObject({ enabled: true, isLoading: false, isAgentAccess: false });
    expect(mock.invoke).not.toHaveBeenCalled();
  });
  it('shows non-agents without granting telemetry', async () => {
    mock.user = { id: 'TEST_USER' }; mock.invoke.mockResolvedValue({ data: { enabled: true, reason: 'not_an_agent' }, error: null });
    const { result } = renderHook(useAssistantAccess, { wrapper });
    await waitFor(() => expect(result.current.reason).toBe('not_an_agent'));
    expect(result.current).toMatchObject({ enabled: true, isLoading: false, isAgentAccess: false });
  });
  it('grants telemetry only after an affirmative server response', async () => {
    mock.user = { id: 'TEST_USER' }; mock.invoke.mockResolvedValue({ data: { enabled: true, reason: 'ok' }, error: null });
    const { result } = renderHook(useAssistantAccess, { wrapper });
    await waitFor(() => expect(result.current.isAgentAccess).toBe(true));
    expect(result.current.enabled).toBe(true);
  });
});
