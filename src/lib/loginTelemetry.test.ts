import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSession, insert, from } = vi.hoisted(() => {
  const insert = vi.fn();
  const from = vi.fn(() => ({ insert }));
  const getSession = vi.fn();
  return { getSession, insert, from };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getSession },
    from,
  },
}));

import { loginPhaseEventUserId, loginTelemetry } from './loginTelemetry';

describe('loginPhaseEventUserId', () => {
  it('omits a recorded id when the request is anonymous', () => {
    expect(loginPhaseEventUserId('user-a', null)).toBeNull();
  });

  it('sends the session user when that is who was recorded', () => {
    expect(loginPhaseEventUserId('user-a', 'user-a')).toBe('user-a');
  });

  it('sends the session user when nothing was recorded', () => {
    expect(loginPhaseEventUserId(null, 'user-b')).toBe('user-b');
  });

  it('omits a recorded id that is not the session user', () => {
    expect(loginPhaseEventUserId('user-a', 'user-b')).toBeNull();
  });
});

describe('login telemetry upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    from.mockImplementation(() => ({ insert }));
    insert.mockResolvedValue({ error: null });
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    loginTelemetry.resetTrace();
    loginTelemetry.setUserId(null);
  });

  it('does not send a cached user id while the client is still anonymous', async () => {
    loginTelemetry.setUserId('cached-user');
    loginTelemetry.mark('auth.signin.attempt', { attempts: 1 }, 'error');
    await loginTelemetry.flushNow();

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0][0].user_id).toBeNull();
    expect(insert.mock.calls[0][0][0].phase).toBe('auth.signin.attempt');
    expect(loginTelemetry.dump().userId).toBeNull();
  });

  it('sends user_id when it is the live session user', async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: 'tok', user: { id: 'user-a' } } },
      error: null,
    });
    loginTelemetry.setUserId('user-a');
    loginTelemetry.mark('app.boot');
    await loginTelemetry.flushNow();

    expect(insert.mock.calls[0][0][0].user_id).toBe('user-a');
  });

  it('attributes a signed-in flush to the session when setUserId was not called', async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: 'tok', user: { id: 'user-a' } } },
      error: null,
    });
    loginTelemetry.mark('auth.signin.attempt', { attempts: 1 }, 'success');
    await loginTelemetry.flushNow();

    expect(insert.mock.calls[0][0][0].user_id).toBe('user-a');
    expect(loginTelemetry.dump().userId).toBe('user-a');
  });

  it('does not send a previous account id on someone else\'s session', async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: 'tok', user: { id: 'user-b' } } },
      error: null,
    });
    loginTelemetry.setUserId('user-a');
    loginTelemetry.mark('auth.signin.attempt', { attempts: 1 }, 'success');
    await loginTelemetry.flushNow();

    expect(insert.mock.calls[0][0][0].user_id).toBeNull();
    expect(loginTelemetry.dump().userId).toBe('user-b');
  });

  it('swallows an RLS reject and does not replay it', async () => {
    loginTelemetry.setUserId('stale-user');
    insert.mockResolvedValue({
      error: {
        code: '42501',
        message: 'new row violates row-level security policy for table "login_phase_events"',
      },
    });
    loginTelemetry.mark('auth.signin.attempt', undefined, 'error');
    await expect(loginTelemetry.flushNow()).resolves.toBeUndefined();
    await loginTelemetry.flushNow();

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0][0].user_id).toBeNull();
  });

  it('resolves when the insert throws so sign-in is not blocked', async () => {
    insert.mockRejectedValue(new Error('network down'));
    loginTelemetry.mark('auth.signin.attempt', undefined, 'error');
    await expect(loginTelemetry.flushNow()).resolves.toBeUndefined();
  });
});
