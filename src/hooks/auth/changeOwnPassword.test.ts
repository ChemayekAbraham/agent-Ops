import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSession, signInWithPassword, updateUser, invoke } = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession, signInWithPassword, updateUser }, functions: { invoke } },
}));

import { changeOwnPassword, classifyAuthError, isOAuthOnly } from './changeOwnPassword';

const phoneSignupUser = {
  id: 'u1',
  email: '0771234567@welile.user',
  phone: '',
  identities: [{ provider: 'email' }],
  app_metadata: { provider: 'email', providers: ['email'] },
};
const input = { currentPassword: 'old-pass', newPassword: 'new-pass-1', confirmPassword: 'new-pass-1' };

describe('changeOwnPassword', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({ data: { session: { user: phoneSignupUser } } });
    signInWithPassword.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    updateUser.mockResolvedValue({ data: {}, error: null });
    invoke.mockResolvedValue({});
  });

  it('re-checks the current password against the auth login email, not the profile email', async () => {
    const res = await changeOwnPassword(input);
    expect(res).toEqual({ ok: true });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: '0771234567@welile.user', password: 'old-pass' });
    expect(updateUser).toHaveBeenCalledWith({ password: 'new-pass-1' });
    expect(invoke).toHaveBeenCalledWith('record-password-change');
  });

  it('uses the phone for a phone-only auth account', async () => {
    getSession.mockResolvedValue({ data: { session: { user: { ...phoneSignupUser, email: '', phone: '256771234567', identities: [{ provider: 'phone' }], app_metadata: {} } } } });
    await changeOwnPassword(input);
    expect(signInWithPassword).toHaveBeenCalledWith({ phone: '256771234567', password: 'old-pass' });
  });

  it('explains a failed re-check on a Google-only account instead of "incorrect"', async () => {
    getSession.mockResolvedValue({ data: { session: { user: { ...phoneSignupUser, email: 'a@gmail.com', identities: [{ provider: 'google' }], app_metadata: { providers: ['google'] } } } } });
    signInWithPassword.mockResolvedValue({ data: {}, error: { message: 'Invalid login credentials', status: 400, code: 'invalid_credentials' } });
    const res = await changeOwnPassword(input);
    expect(res).toMatchObject({ ok: false, reason: 'no_password_login' });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'a@gmail.com', password: 'old-pass' });
  });

  it('still lets a Google-only account that has a password change it', async () => {
    getSession.mockResolvedValue({ data: { session: { user: { ...phoneSignupUser, email: 'a@gmail.com', identities: [{ provider: 'google' }], app_metadata: { providers: ['google'] } } } } });
    expect(await changeOwnPassword(input)).toEqual({ ok: true });
  });

  it('does not report a rate limit as a wrong password', async () => {
    signInWithPassword.mockResolvedValue({ data: {}, error: { message: 'Request rate limit reached', status: 429, code: 'over_request_rate_limit' } });
    const res = await changeOwnPassword(input);
    expect(res).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('reports a wrong current password', async () => {
    signInWithPassword.mockResolvedValue({ data: {}, error: { message: 'Invalid login credentials', status: 400, code: 'invalid_credentials' } });
    expect(await changeOwnPassword(input)).toMatchObject({ ok: false, reason: 'wrong_current_password' });
  });

  it('validates before touching the network', async () => {
    expect(await changeOwnPassword({ ...input, newPassword: 'abc', confirmPassword: 'abc' })).toMatchObject({ reason: 'too_short' });
    expect(await changeOwnPassword({ ...input, confirmPassword: 'other-pass' })).toMatchObject({ reason: 'mismatch' });
    expect(await changeOwnPassword({ ...input, newPassword: 'old-pass', confirmPassword: 'old-pass' })).toMatchObject({ reason: 'same_password' });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('fails cleanly with no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    expect(await changeOwnPassword(input)).toMatchObject({ ok: false, reason: 'no_session' });
  });
});

describe('classifyAuthError', () => {
  it('maps Supabase codes', () => {
    expect(classifyAuthError({ code: 'same_password', status: 422 }, 'update')).toBe('same_password');
    expect(classifyAuthError({ code: 'weak_password', status: 422 }, 'update')).toBe('weak_password');
    expect(classifyAuthError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 }, 'verify')).toBe('network');
    expect(classifyAuthError({ status: 504, message: 'context deadline exceeded' }, 'verify')).toBe('network');
  });
});

describe('isOAuthOnly', () => {
  it('treats a password account that also linked Google as having a password', () => {
    expect(isOAuthOnly({ identities: [{ provider: 'email' }, { provider: 'google' }] as never, app_metadata: {} })).toBe(false);
    expect(isOAuthOnly({ identities: [{ provider: 'google' }] as never, app_metadata: {} })).toBe(true);
  });
});
