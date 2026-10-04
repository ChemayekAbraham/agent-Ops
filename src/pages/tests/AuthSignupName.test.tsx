/**
 * Render coverage for the signup name capture on `Auth`.
 * The submitted payload itself is asserted in
 * `src/hooks/tests/useAuthForm.personName.test.ts` (mocked call argument);
 * here we assert the UI renders the three split fields and surfaces errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';

const state: any = {
  nameParts: { firstName: '', otherNames: '', lastName: '' },
  namePartsError: null as string | null,
};
const setNameParts = vi.fn((next: any) => { state.nameParts = next; });

vi.mock('@/hooks/useAuthForm', () => ({
  useAuthForm: () => ({
    referralId: null, becomeRole: null, preSelectedRole: 'tenant',
    isSignUp: true, setIsSignUp: vi.fn(),
    isForgotPassword: false, setIsForgotPassword: vi.fn(),
    isForgotPhone: false, setIsForgotPhone: vi.fn(),
    email: '', setEmail: vi.fn(),
    signupEmail: '', setSignupEmail: vi.fn(),
    password: '', setPassword: vi.fn(),
    confirmPassword: '', setConfirmPassword: vi.fn(),
    showConfirmPassword: false, setShowConfirmPassword: vi.fn(),
    fullName: '', setFullName: vi.fn(),
    nameParts: state.nameParts, setNameParts,
    namePartsError: state.namePartsError, setNamePartsError: vi.fn(),
    phone: '', setPhone: vi.fn(),
    countryCode: '256', setCountryCode: vi.fn(),
    isLoading: false, loginStage: null,
    loginError: null, setLoginError: vi.fn(),
    failedAttempts: 0,
    rememberMe: true, setRememberMe: vi.fn(),
    showPassword: false, setShowPassword: vi.fn(),
    isGoogleLoading: false, isAppleLoading: false,
    phoneInputRef: { current: null }, passwordInputRef: { current: null },
    isDuplicate: false, isCheckingDuplicate: false, duplicateMessage: null,
    otpSent: false, otpVerified: false, otpLoading: false, otpError: null,
    otpSendStatus: null, otpCooldownSeconds: 0,
    sendOtp: vi.fn(), verifyOtp: vi.fn(), resetOtp: vi.fn(),
    resetStep: 'phone', setResetStep: vi.fn(),
    resetPhone: '', setResetPhone: vi.fn(),
    resetOtpCode: '', setResetOtpCode: vi.fn(),
    resetNewPassword: '', setResetNewPassword: vi.fn(),
    resetConfirmPassword: '', setResetConfirmPassword: vi.fn(),
    resetLoading: false, resetError: null,
    handleSendResetOtp: vi.fn(), handleVerifyResetOtp: vi.fn(), handleResetPassword: vi.fn(),
    handleSubmit: vi.fn(), handleGoogleSignIn: vi.fn(), handleAppleSignIn: vi.fn(),
    handleForgotPassword: vi.fn(), handleForgotPhone: vi.fn(),
    selectedRole: 'tenant', setSelectedRole: vi.fn(),
    archivedAccount: null, setArchivedAccount: vi.fn(),
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: null, roles: [], loading: false }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    })),
  },
}));

async function renderAuth() {
  const Auth = (await import('@/pages/Auth')).default;
  const utils = render(
    <HelmetProvider>
      <MemoryRouter>
        <Auth />
      </MemoryRouter>
    </HelmetProvider>,
  );
  // The signup screen opens on the role picker — choose a role to reveal the form.
  const roleButton = screen.queryByText(/I need rent help/i);
  if (roleButton) fireEvent.click(roleButton);
  return utils;
}

beforeEach(() => {
  setNameParts.mockClear();
  state.nameParts = { firstName: '', otherNames: '', lastName: '' };
  state.namePartsError = null;
  try { localStorage.clear(); } catch { /* noop */ }
});

describe('Auth signup — split name capture', () => {
  it('renders the three labelled name inputs', async () => {
    await renderAuth();
    expect(screen.getByLabelText(/First name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Last name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Other names/i)).toBeInTheDocument();
  });

  it('sends the edited part up through onChange', async () => {
    await renderAuth();
    fireEvent.change(screen.getByLabelText(/First name/i), { target: { value: 'Timothy' } });
    expect(setNameParts).toHaveBeenLastCalledWith({ firstName: 'Timothy', otherNames: '', lastName: '' });
  });

  it('shows the validation error when the last name is blank', async () => {
    state.nameParts = { firstName: 'Timothy', otherNames: '', lastName: '' };
    state.namePartsError = 'Last name is required';
    await renderAuth();
    expect(screen.getByText('Last name is required')).toBeInTheDocument();
  });
});
