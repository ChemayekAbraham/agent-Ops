/**
 * Pilot coverage for the split person-name capture in `useAuthForm`.
 * The UI captures first / other / last, but `fullName` and the submitted
 * payload must remain the exact same single string as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type React from 'react';

const signUpMock = vi.fn();
const toastMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(''), vi.fn()],
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signIn: vi.fn(),
    signUpWithoutRole: signUpMock,
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
    resetPassword: vi.fn(),
    user: null,
    roles: [],
  }),
}));

vi.mock('@/hooks/usePhoneDuplicateCheck', () => ({
  usePhoneDuplicateCheck: () => ({ isDuplicate: false, isChecking: false, duplicateMessage: null }),
}));

vi.mock('@/hooks/useOtpVerification', () => ({
  useOtpVerification: () => ({
    otpSent: false,
    otpVerified: false,
    otpLoading: false,
    otpError: null,
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
    resetOtp: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/hooks/useGeolocation', () => ({ getLocationData: () => Promise.resolve(null) }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: any[]) => rpcMock(...args),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    })),
  },
}));

async function loadHook() {
  const mod = await import('@/hooks/useAuthForm');
  return mod.useAuthForm;
}

const fakeFormEvent = () => ({ preventDefault: () => {} }) as unknown as React.FormEvent;

beforeEach(() => {
  signUpMock.mockReset();
  toastMock.mockReset();
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: null, error: null });
  signUpMock.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  try { localStorage.clear(); } catch { /* noop */ }
});

describe('useAuthForm — fullName derivation from parts', () => {
  it('derives first + last', async () => {
    const useAuthForm = await loadHook();
    const { result } = renderHook(() => useAuthForm());
    act(() => result.current.setNameParts({ firstName: 'Timothy', otherNames: '', lastName: 'Waniaye' }));
    expect(result.current.fullName).toBe('Timothy Waniaye');
  });

  it('derives first + other + last', async () => {
    const useAuthForm = await loadHook();
    const { result } = renderHook(() => useAuthForm());
    act(() => result.current.setNameParts({ firstName: 'Timothy', otherNames: 'Christian', lastName: 'Waniaye' }));
    expect(result.current.fullName).toBe('Timothy Christian Waniaye');
  });

  it('derives first only and last only', async () => {
    const useAuthForm = await loadHook();
    const { result } = renderHook(() => useAuthForm());
    act(() => result.current.setNameParts({ firstName: 'Timothy', otherNames: '', lastName: '' }));
    expect(result.current.fullName).toBe('Timothy');
    act(() => result.current.setNameParts({ firstName: '', otherNames: '', lastName: 'Waniaye' }));
    expect(result.current.fullName).toBe('Waniaye');
    act(() => result.current.setNameParts({ firstName: '', otherNames: '', lastName: '' }));
    expect(result.current.fullName).toBe('');
  });

  it('normalises whitespace', async () => {
    const useAuthForm = await loadHook();
    const { result } = renderHook(() => useAuthForm());
    act(() => result.current.setNameParts({ firstName: '  Timothy ', otherNames: ' Christian   Paul ', lastName: ' Waniaye ' }));
    expect(result.current.fullName).toBe('Timothy Christian Paul Waniaye');
  });

  it('setFullName hydrates the parts', async () => {
    const useAuthForm = await loadHook();
    const { result } = renderHook(() => useAuthForm());
    act(() => result.current.setFullName('Timothy Christian Waniaye'));
    expect(result.current.nameParts).toEqual({ firstName: 'Timothy', otherNames: 'Christian', lastName: 'Waniaye' });
    expect(result.current.fullName).toBe('Timothy Christian Waniaye');
  });
});

describe('useAuthForm — signup gating on name parts', () => {
  const prime = (result: any, parts: { firstName: string; otherNames: string; lastName: string }) => {
    act(() => {
      result.current.setIsSignUp(true);
      result.current.setNameParts(parts);
      result.current.setPassword('hunter22');
      result.current.setConfirmPassword('hunter22');
      result.current.setPhone('774839201');
      result.current.setSignupEmail('timothy@example.com');
    });
  };

  it('blocks submit when the first name is empty', async () => {
    const useAuthForm = await loadHook();
    const { result } = renderHook(() => useAuthForm());
    prime(result, { firstName: '', otherNames: '', lastName: 'Waniaye' });
    await act(async () => { await result.current.handleSubmit(fakeFormEvent()); });
    expect(signUpMock).not.toHaveBeenCalled();
    expect(result.current.namePartsError).toBe('First name is required');
  });

  it('blocks submit when the last name is empty', async () => {
    const useAuthForm = await loadHook();
    const { result } = renderHook(() => useAuthForm());
    prime(result, { firstName: 'Timothy', otherNames: '', lastName: '   ' });
    await act(async () => { await result.current.handleSubmit(fakeFormEvent()); });
    expect(signUpMock).not.toHaveBeenCalled();
    expect(result.current.namePartsError).toBe('Last name is required');
  });

  it('still blocks junk names through validateFullName', async () => {
    const useAuthForm = await loadHook();
    const { result } = renderHook(() => useAuthForm());
    prime(result, { firstName: 'a', otherNames: '', lastName: 'b' });
    await act(async () => { await result.current.handleSubmit(fakeFormEvent()); });
    expect(signUpMock).not.toHaveBeenCalled();
    expect(result.current.namePartsError).toBeTruthy();
  });

  it('submits the exact concatenated full name for first + other + last', async () => {
    const useAuthForm = await loadHook();
    const { result } = renderHook(() => useAuthForm());
    prime(result, { firstName: 'Timothy', otherNames: 'Christian', lastName: 'Waniaye' });
    await act(async () => { await result.current.handleSubmit(fakeFormEvent()); });
    expect(signUpMock).toHaveBeenCalled();
    expect(signUpMock.mock.calls[0][2]).toBe('Timothy Christian Waniaye');
  });

  it('submits the exact concatenated full name for first + last', async () => {
    const useAuthForm = await loadHook();
    const { result } = renderHook(() => useAuthForm());
    prime(result, { firstName: 'Timothy', otherNames: '', lastName: 'Waniaye' });
    await act(async () => { await result.current.handleSubmit(fakeFormEvent()); });
    expect(signUpMock).toHaveBeenCalled();
    expect(signUpMock.mock.calls[0][2]).toBe('Timothy Waniaye');
  });
});
