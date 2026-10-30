/**
 * The "Welile AI" launcher on the sign-in screen is for signed-in people only.
 * A visitor with no session must not see it, and it must disappear the moment
 * the session is cleared — without a page reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';

const state: { session: any } = { session: null };

vi.mock('@/hooks/useAuthForm', () => ({
  useAuthForm: () => ({
    referralId: null, becomeRole: null, preSelectedRole: 'tenant',
    isSignUp: false, setIsSignUp: vi.fn(),
    isForgotPassword: false, setIsForgotPassword: vi.fn(),
    isForgotPhone: false, setIsForgotPhone: vi.fn(),
    email: '', setEmail: vi.fn(),
    signupEmail: '', setSignupEmail: vi.fn(),
    password: '', setPassword: vi.fn(),
    confirmPassword: '', setConfirmPassword: vi.fn(),
    showConfirmPassword: false, setShowConfirmPassword: vi.fn(),
    fullName: '', setFullName: vi.fn(),
    nameParts: { firstName: '', otherNames: '', lastName: '' }, setNameParts: vi.fn(),
    namePartsError: null, setNamePartsError: vi.fn(),
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
  // Read the session through a getter so a sign-out is picked up on re-render.
  useAuth: () => ({
    user: state.session ? { id: 'u-1' } : null,
    session: state.session,
    roles: [],
    loading: false,
    signIn: vi.fn(),
  }),
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
  return render(
    <HelmetProvider>
      <MemoryRouter>
        <Auth />
      </MemoryRouter>
    </HelmetProvider>,
  );
}

beforeEach(() => {
  state.session = null;
  try { localStorage.clear(); } catch { /* noop */ }
});

describe('Auth — "Welile AI" launcher visibility', () => {
  it('is absent for a visitor with no session', async () => {
    await renderAuth();
    expect(screen.queryByRole('button', { name: /welile ai/i })).not.toBeInTheDocument();
  });

  it('appears when the account has a real session', async () => {
    state.session = { access_token: 't', user: { id: 'u-1' } };
    await renderAuth();
    expect(screen.getByRole('button', { name: /welile ai/i })).toBeInTheDocument();
  });

  it('disappears the moment the session is cleared, without a reload', async () => {
    state.session = { access_token: 't', user: { id: 'u-1' } };
    const { rerender } = await renderAuth();
    expect(screen.getByRole('button', { name: /welile ai/i })).toBeInTheDocument();

    state.session = null;
    const Auth = (await import('@/pages/Auth')).default;
    rerender(
      <HelmetProvider>
        <MemoryRouter>
          <Auth />
        </MemoryRouter>
      </HelmetProvider>,
    );
    expect(screen.queryByRole('button', { name: /welile ai/i })).not.toBeInTheDocument();
  });
});
