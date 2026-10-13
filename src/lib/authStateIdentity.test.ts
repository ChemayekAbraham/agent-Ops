import { describe, it, expect } from 'vitest';
import type { Session, User } from '@supabase/supabase-js';
import { keepRoles, keepSession, keepUser, sameRoles, sameSession, sameUser } from './authStateIdentity';

const user = (over: Record<string, unknown> = {}): User =>
  ({
    id: 'u-1', email: 'ops@welile.com', phone: '', aud: 'authenticated', role: 'authenticated',
    app_metadata: { provider: 'email' }, user_metadata: { full_name: 'Ops One' },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-01T08:00:00Z', ...over,
  }) as unknown as User;

const session = (over: Record<string, unknown> = {}, u: User = user()): Session =>
  ({ access_token: 'tok-1', refresh_token: 'ref-1', expires_at: 2_000_000_000, expires_in: 3600, token_type: 'bearer', user: u, ...over }) as unknown as Session;

describe('sameUser', () => {
  it('a freshly parsed copy of the same user is the same user', () => {
    const a = user();
    const b = JSON.parse(JSON.stringify(a)) as User;
    expect(a).not.toBe(b);
    expect(sameUser(a, b)).toBe(true);
  });

  it('another person, or changed user data, is a change', () => {
    expect(sameUser(user(), user({ id: 'u-2' }))).toBe(false);
    expect(sameUser(user(), user({ updated_at: '2026-10-07T09:00:00Z' }))).toBe(false);
    expect(sameUser(user(), user({ user_metadata: { full_name: 'New Name' } }))).toBe(false);
  });

  it('null is only the same as null', () => {
    expect(sameUser(null, null)).toBe(true);
    expect(sameUser(null, user())).toBe(false);
    expect(sameUser(user(), null)).toBe(false);
  });
});

describe('sameSession', () => {
  it('the same sign-in announced again is the same session', () => {
    const a = session();
    const b = JSON.parse(JSON.stringify(a)) as Session;
    expect(sameSession(a, b)).toBe(true);
  });

  it('a renewed token, another refresh token or another user is a change', () => {
    expect(sameSession(session(), session({ access_token: 'tok-2' }))).toBe(false);
    expect(sameSession(session(), session({ refresh_token: 'ref-2' }))).toBe(false);
    expect(sameSession(session(), session({}, user({ id: 'u-9' })))).toBe(false);
  });
});

describe('keep updaters', () => {
  it('keepUser keeps the held object for an identical copy and swaps for a real change', () => {
    const held = user();
    const copy = JSON.parse(JSON.stringify(held)) as User;
    expect(keepUser(copy)(held)).toBe(held);
    const changed = user({ id: 'u-2' });
    expect(keepUser(changed)(held)).toBe(changed);
    expect(keepUser(null)(held)).toBeNull();
    expect(keepUser(held)(null)).toBe(held);
  });

  it('keepSession keeps the held object for an identical copy, and a renewed token replaces the session but keeps the user object', () => {
    const held = session();
    expect(keepSession(JSON.parse(JSON.stringify(held)))(held)).toBe(held);
    const renewed = session({ access_token: 'tok-2' });
    expect(keepSession(renewed)(held)).toBe(renewed);
    // the user inside the renewed session is the same person with the same data, so the held user is kept
    const heldUser = held.user;
    expect(keepUser(renewed.user)(heldUser)).toBe(heldUser);
  });
});

describe('roles', () => {
  it('the same roles in the same order keep the same array', () => {
    const held = ['supporter', 'tenant_ops'] as string[];
    expect(sameRoles(held, ['supporter', 'tenant_ops'])).toBe(true);
    expect(keepRoles<string>(['supporter', 'tenant_ops'])(held)).toBe(held);
  });

  it('a different role list is a change', () => {
    const held = ['supporter'] as string[];
    const next: string[] = ['supporter', 'tenant_ops'];
    expect(sameRoles(held, next)).toBe(false);
    expect(keepRoles<string>(next)(held)).toBe(next);
  });
});
