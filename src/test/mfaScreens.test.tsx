import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticatorSetupScreen } from '@/components/auth/AuthenticatorSetupScreen';
import { AuthenticatorChallengeScreen } from '@/components/auth/AuthenticatorChallengeScreen';
import { AuthenticatorPromptBanner } from '@/components/auth/AuthenticatorPromptBanner';
import { AuthenticatorAppCard } from '@/components/settings/AuthenticatorAppCard';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  auth: {
    mfa: {
      getAuthenticatorAssuranceLevel: vi.fn(() => Promise.resolve({ data: { currentLevel: 'aal1' } })),
      listFactors: vi.fn(() => Promise.resolve({ data: { totp: [{ id: 'factor-1' }] } })),
      enroll: vi.fn(() =>
        Promise.resolve({
          data: {
            id: 'factor-new-1',
            totp: {
              qr_code: 'data:image/svg+xml;utf8,<svg>mock-qr</svg>',
              secret: 'JBSWY3DPEHPK3PXP',
            },
          },
          error: null,
        })
      ),
      unenroll: vi.fn(),
      challengeAndVerify: vi.fn(),
    },
    refreshSession: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    auth: mocks.auth,
  },
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));

beforeEach(() => {
  vi.clearAllMocks();
  if (typeof document !== 'undefined' && !document.elementFromPoint) {
    document.elementFromPoint = () => null;
  }
  mocks.rpc.mockImplementation((fn: string) => {
    if (fn === 'my_staff_mfa_status') {
      return Promise.resolve({
        data: {
          mode: 'shadow',
          is_staff: true,
          is_admin: false,
          enrolled: false,
          required: false,
          prompt: true,
        },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
});

afterEach(cleanup);

describe('Authenticator MFA Screens', () => {
  it('AuthenticatorSetupScreen renders QR code, secret key, steps, and allows confirmation', async () => {
    mocks.auth.mfa.challengeAndVerify.mockResolvedValueOnce({ error: null });
    const onSuccess = vi.fn();

    render(<AuthenticatorSetupScreen isDialog onSuccess={onSuccess} />);

    expect(await screen.findByAltText('Scan QR code with authenticator app')).toBeTruthy();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    expect(screen.getByText(/Google Authenticator/)).toBeTruthy();

    const input = document.getElementById('authenticator-setup-code') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '654321' } });

    fireEvent.click(document.getElementById('authenticator-setup-confirm') as HTMLButtonElement);

    await waitFor(() => {
      expect(mocks.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
        factorId: 'factor-new-1',
        code: '654321',
      });
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it('AuthenticatorChallengeScreen renders 6-digit input and lost phone assistance', async () => {
    mocks.auth.mfa.challengeAndVerify.mockResolvedValueOnce({ error: null });
    const onSuccess = vi.fn();

    render(<AuthenticatorChallengeScreen isDialog onSuccess={onSuccess} />);

    expect(screen.getByText('Two-factor authentication')).toBeTruthy();
    expect(screen.getByText(/Lost your phone\? Ask a super admin to reset your authenticator/)).toBeTruthy();

    const input = document.getElementById('authenticator-challenge-code') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '112233' } });

    fireEvent.click(document.getElementById('authenticator-challenge-verify') as HTMLButtonElement);

    await waitFor(() => {
      expect(mocks.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
        factorId: 'factor-1',
        code: '112233',
      });
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it('AuthenticatorPromptBanner renders message and can be dismissed for session', () => {
    render(<AuthenticatorPromptBanner />);

    expect(screen.getByText('Set up your authenticator app. It will soon be required to sign in.')).toBeTruthy();

    const dismissBtn = screen.getByLabelText('Dismiss banner');
    fireEvent.click(dismissBtn);

    expect(screen.queryByText('Set up your authenticator app. It will soon be required to sign in.')).toBeNull();
  });

  it('AuthenticatorAppCard renders setup button for unenrolled staff in settings', async () => {
    render(<AuthenticatorAppCard />);

    await waitFor(() => {
      expect(screen.getByText('Set up authenticator app')).toBeTruthy();
      expect(document.getElementById('settings-setup-authenticator')).toBeTruthy();
    });
  });
});
