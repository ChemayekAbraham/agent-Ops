import { describe, it, expect, beforeEach } from 'vitest';
import { postSignInPath, rememberReturnPath, safeInternalPath, takeReturnPath } from './returnPath';

describe('return to the previous page after sign-in', () => {
  beforeEach(() => localStorage.clear());

  it('sends the same person back to the page they were on', () => {
    rememberReturnPath('u1', '/dashboard/funder/portfolio?tab=active');
    expect(postSignInPath('u1', null)).toBe('/dashboard/funder/portfolio?tab=active');
  });

  it('applies to one sign-in only', () => {
    rememberReturnPath('u1', '/dashboard/tenant');
    takeReturnPath('u1');
    expect(postSignInPath('u1', null)).toBe('/dashboard');
  });

  it('never hands one person another person’s page', () => {
    rememberReturnPath('u1', '/dashboard/coo');
    expect(postSignInPath('u2', null)).toBe('/dashboard');
    expect(postSignInPath('u1', null)).toBe('/dashboard/coo');
  });

  it('does not remember sign-in or landing pages', () => {
    rememberReturnPath('u1', '/dashboard/agent');
    rememberReturnPath('u1', '/auth?reason=signed_out');
    rememberReturnPath('u1', '/');
    expect(postSignInPath('u1', null)).toBe('/dashboard/agent');
  });

  it('prefers an explicit ?redirect= and consumes the remembered page', () => {
    rememberReturnPath('u1', '/dashboard/agent');
    expect(postSignInPath('u1', '/repay')).toBe('/repay');
    expect(takeReturnPath('u1')).toBeNull();
  });

  it('rejects paths that leave the app', () => {
    expect(safeInternalPath('//evil.com')).toBeNull();
    expect(safeInternalPath('/\\evil.com')).toBeNull();
    expect(safeInternalPath('https://evil.com')).toBeNull();
    expect(postSignInPath('u1', '//evil.com')).toBe('/dashboard');
  });
});
