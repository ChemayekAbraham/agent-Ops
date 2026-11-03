import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeSessionPopup,
  claimSessionPopup,
  dismissSessionPopup,
  registerSessionPopup,
  resetSessionPopupForTests,
  SESSION_POPUP_HOLD_MS,
  setSessionPopupClockForTests,
} from './sessionPopup';

afterEach(() => {
  resetSessionPopupForTests();
  vi.useRealTimers();
});

describe('sessionPopup', () => {
  it('shows concerns ahead of email when both are ready', () => {
    registerSessionPopup('email', 'ready');
    registerSessionPopup('concerns', 'ready');
    expect(activeSessionPopup()).toBe('concerns');
  });

  it('waits while a higher-priority dialog is still loading', () => {
    registerSessionPopup('concerns', 'unknown');
    registerSessionPopup('email', 'ready');
    expect(activeSessionPopup()).toBeNull();
    registerSessionPopup('concerns', 'idle');
    expect(activeSessionPopup()).toBe('email');
  });

  it('lets email open after the hold when concerns never mounts', () => {
    let now = 1_000;
    setSessionPopupClockForTests(() => now);
    vi.useFakeTimers();
    registerSessionPopup('email', 'ready');
    expect(activeSessionPopup()).toBeNull();
    now += SESSION_POPUP_HOLD_MS;
    vi.advanceTimersByTime(SESSION_POPUP_HOLD_MS);
    expect(activeSessionPopup()).toBe('email');
  });

  it('one dismissal blocks every other dialog for the session', () => {
    registerSessionPopup('concerns', 'ready');
    claimSessionPopup('concerns');
    dismissSessionPopup();
    registerSessionPopup('email', 'ready');
    registerSessionPopup('budget', 'ready');
    expect(activeSessionPopup()).toBeNull();
  });

  it('a cleared session can show a dialog again', () => {
    registerSessionPopup('concerns', 'idle');
    registerSessionPopup('email', 'ready');
    dismissSessionPopup();
    expect(activeSessionPopup()).toBeNull();
    sessionStorage.clear();
    expect(activeSessionPopup()).toBe('email');
  });
});
