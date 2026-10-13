import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { isCriticalFlowActive, setCriticalFlowActive } from '@/lib/criticalFlowGuard';
import { useCriticalFlow, useLeavePageWarning } from './useCriticalFlow';

describe('useCriticalFlow', () => {
  beforeEach(() => {
    // leave nothing registered between tests
    ['a', 'b'].forEach((k) => setCriticalFlowActive(k, false));
  });

  it('is active only while the work is live, and releases when it ends or the screen goes', () => {
    const { rerender, unmount } = renderHook(({ on }) => useCriticalFlow('voice-call', on), { initialProps: { on: false } });
    expect(isCriticalFlowActive()).toBe(false);
    rerender({ on: true });
    expect(isCriticalFlowActive()).toBe(true);
    rerender({ on: false });
    expect(isCriticalFlowActive()).toBe(false);
    rerender({ on: true });
    unmount();
    expect(isCriticalFlowActive()).toBe(false);
  });

  it('two screens with live work do not release each other', () => {
    const one = renderHook(() => useCriticalFlow('calling-center-outcome', true));
    const two = renderHook(() => useCriticalFlow('calling-center-outcome', true));
    expect(isCriticalFlowActive()).toBe(true);
    one.unmount();
    expect(isCriticalFlowActive()).toBe(true);
    two.unmount();
    expect(isCriticalFlowActive()).toBe(false);
  });
});

describe('useLeavePageWarning', () => {
  const fire = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event;
  };

  it('asks before leaving only while active', () => {
    const { rerender, unmount } = renderHook(({ on }) => useLeavePageWarning(on), { initialProps: { on: false } });
    expect(fire().defaultPrevented).toBe(false);
    rerender({ on: true });
    expect(fire().defaultPrevented).toBe(true);
    rerender({ on: false });
    expect(fire().defaultPrevented).toBe(false);
    rerender({ on: true });
    unmount();
    expect(fire().defaultPrevented).toBe(false);
  });
});
