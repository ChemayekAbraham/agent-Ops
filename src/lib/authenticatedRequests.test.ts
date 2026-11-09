import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionCheckedUser, withUserSession } from './authenticatedRequests';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), getUser: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: mocks } }));
const session = { user: { id: '14247b23-b000-4000-8000-0123456789ab' }, access_token: 'test-user-session' };
beforeEach(() => { vi.clearAllMocks(); });
describe('authenticated requests', () => {
  it('never sends an authenticated table request without a session', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const request = vi.fn(async () => ({ data: [], error: null }));
    expect(await withUserSession(request)).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    expect(request).not.toHaveBeenCalled();
  });
  it('stops requests after sign-out', async () => {
    mocks.getSession.mockResolvedValueOnce({ data: { session }, error: null })
      .mockResolvedValueOnce({ data: { session: null }, error: null });
    const request = vi.fn(async () => ({ data: [1], error: null }));
    await withUserSession(request);
    await withUserSession(request);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not validate an anonymous or expired session through getUser', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect((await getSessionCheckedUser()).data.user).toBeNull();
    mocks.getSession.mockResolvedValue({ data: { session: { ...session, expires_at: 1 } }, error: null });
    await getSessionCheckedUser();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
  it('uses the real session token for server identity validation', async () => {
    mocks.getSession.mockResolvedValue({ data: { session }, error: null });
    mocks.getUser.mockResolvedValue({ data: { user: session.user }, error: null });
    await getSessionCheckedUser();
    expect(mocks.getUser).toHaveBeenCalledWith(session.access_token);
  });
});