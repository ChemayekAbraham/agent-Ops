import { describe, it, expect } from 'vitest';
import { isSessionPastMaxAge, sessionSignedInAtMs, SESSION_MAX_AGE_MS } from './sessionCache';

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenWith = (payload: unknown) => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;
const DAY = 24 * 60 * 60 * 1000;

describe('7-day session limit', () => {
  it('reads sign-in time from the access token amr, not last_sign_in_at', () => {
    const signedIn = Date.now() - 2 * DAY;
    const session = {
      access_token: tokenWith({ amr: [{ method: 'password', timestamp: Math.floor(signedIn / 1000) }] }),
      user: { last_sign_in_at: new Date(Date.now() - 20 * DAY).toISOString() },
    };
    expect(Math.abs((sessionSignedInAtMs(session) ?? 0) - signedIn)).toBeLessThan(1000);
    expect(isSessionPastMaxAge(session)).toBe(false);
  });

  it('expires a session signed in more than 7 days ago', () => {
    const ts = Math.floor((Date.now() - SESSION_MAX_AGE_MS - DAY) / 1000);
    expect(isSessionPastMaxAge({ access_token: tokenWith({ amr: [{ method: 'otp', timestamp: ts }] }) })).toBe(true);
  });

  it('falls back to last_sign_in_at when the token has no amr', () => {
    const session = { access_token: tokenWith({}), user: { last_sign_in_at: new Date(Date.now() - 8 * DAY).toISOString() } };
    expect(isSessionPastMaxAge(session)).toBe(true);
  });

  it('never expires a session whose age is unknown', () => {
    expect(isSessionPastMaxAge({ access_token: 'not-a-jwt' })).toBe(false);
    expect(isSessionPastMaxAge(null)).toBe(false);
  });
});
