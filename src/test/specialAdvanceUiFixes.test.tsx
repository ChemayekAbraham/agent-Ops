/**
 * Fixes from the review of the Special Advances screens (2026-11-03):
 *  H1 the authenticator set-up screen asks the auth server once, not in a loop, when set-up fails;
 *  H2 the app-wide authenticator gate clears as soon as a code is accepted (separate hook copies stay in step);
 *  H3 a proof form asks for the authenticator code BEFORE uploading (the proofs bucket refuses a password-only session);
 *  M1 a retry that fails after the code dialog closed still tells the CFO.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticatorSetupScreen } from '@/components/auth/AuthenticatorSetupScreen';
import { StaffAuthenticatorGate } from '@/components/auth/StaffAuthenticatorGate';
import { SpecialAdvanceRecoveryForm } from '@/components/cfo/special-advances/SpecialAdvanceRecoveryForm';
import { SpecialAdvanceStepUpDialog } from '@/components/cfo/special-advances/SpecialAdvanceStepUpDialog';
import type { SpecialAdvanceStatement } from '@/lib/specialAdvances';

const ADVANCE_ID = '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  upload: vi.fn(),
  aal: { level: 'aal1' as 'aal1' | 'aal2' },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  mfa: {
    getAuthenticatorAssuranceLevel: vi.fn(),
    listFactors: vi.fn(),
    enroll: vi.fn(),
    unenroll: vi.fn(),
    challengeAndVerify: vi.fn(),
  },
  refreshSession: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    storage: { from: () => ({ upload: mocks.upload }) },
    auth: { mfa: mocks.mfa, refreshSession: mocks.refreshSession, signOut: vi.fn() },
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'cfo-1' }, session: null, loading: false, signOut: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: mocks.toast }));

const mfaStatus = (over: Record<string, unknown> = {}) => ({
  mode: 'all', is_staff: true, is_admin: true, enrolled: true, required: true, prompt: false, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  if (typeof document !== 'undefined' && !document.elementFromPoint) document.elementFromPoint = () => null;
  mocks.aal.level = 'aal1';
  mocks.mfa.getAuthenticatorAssuranceLevel.mockImplementation(() => Promise.resolve({ data: { currentLevel: mocks.aal.level } }));
  mocks.mfa.listFactors.mockResolvedValue({ data: { all: [], totp: [{ id: 'factor-1' }] } });
  mocks.mfa.challengeAndVerify.mockImplementation(() => {
    mocks.aal.level = 'aal2';
    return Promise.resolve({ error: null });
  });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.rpc.mockImplementation((fn: string) =>
    Promise.resolve(fn === 'my_staff_mfa_status' ? { data: mfaStatus(), error: null } : { data: { reference: 'SAR-1' }, error: null }),
  );
});
afterEach(cleanup);

const withClient = (ui: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const enterCode = (inputId: string, buttonId: string, code = '123456') => {
  fireEvent.change(document.getElementById(inputId) as HTMLInputElement, { target: { value: code } });
  fireEvent.click(document.getElementById(buttonId) as HTMLButtonElement);
};

describe('H1: authenticator set-up asks once when it fails', () => {
  it('does not retry by itself; Retry asks again only when pressed', async () => {
    mocks.mfa.enroll.mockResolvedValue({ data: null, error: { message: 'MFA enroll is disabled for TOTP' } });
    render(<AuthenticatorSetupScreen isDialog />);

    expect(await screen.findByText('Retry')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.mfa.enroll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(mocks.mfa.enroll).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.mfa.enroll).toHaveBeenCalledTimes(2);
  });

  it('does not start a second set-up after the code is accepted', async () => {
    mocks.mfa.enroll.mockResolvedValue({
      data: { id: 'factor-new', totp: { qr_code: 'data:image/svg+xml;utf8,<svg/>', secret: 'JBSWY3DPEHPK3PXP' } },
      error: null,
    });
    render(<AuthenticatorSetupScreen isDialog />);
    await screen.findByAltText('Scan QR code with authenticator app');

    enterCode('authenticator-setup-code', 'authenticator-setup-confirm');
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Authenticator app configured'));
    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.mfa.enroll).toHaveBeenCalledTimes(1);
  });
});

describe('H2: the app-wide gate clears once the code is accepted', () => {
  it('removes the full-screen challenge after a correct code, without a reload', async () => {
    render(<StaffAuthenticatorGate />);
    expect(await screen.findByText('Two-factor authentication')).toBeTruthy();

    enterCode('authenticator-challenge-code', 'authenticator-challenge-verify');

    await waitFor(() => expect(screen.queryByText('Two-factor authentication')).toBeNull());
    expect(mocks.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'factor-1', code: '123456' });
  });

  it('removes the full-screen set-up after the first code, without starting a new set-up', async () => {
    mocks.rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'my_staff_mfa_status' ? { data: mfaStatus({ enrolled: false }), error: null } : { data: null, error: null }),
    );
    mocks.mfa.enroll.mockResolvedValue({
      data: { id: 'factor-new', totp: { qr_code: 'data:image/svg+xml;utf8,<svg/>', secret: 'JBSWY3DPEHPK3PXP' } },
      error: null,
    });
    render(<StaffAuthenticatorGate />);
    await screen.findByAltText('Scan QR code with authenticator app');

    enterCode('authenticator-setup-code', 'authenticator-setup-confirm');

    await waitFor(() => expect(screen.queryByText('Set up authenticator app')).toBeNull());
    expect(mocks.mfa.enroll).toHaveBeenCalledTimes(1);
  });
});

describe('H3: a proof form asks for the code before uploading', () => {
  const fillRecovery = () => {
    fireEvent.change(document.getElementById('recovery-amount') as HTMLInputElement, { target: { value: '50000' } });
    fireEvent.change(document.getElementById('recovery-reference') as HTMLInputElement, { target: { value: 'MTN-12345' } });
    const pdf = new File(['%PDF-1.4'], 'receipt.pdf', { type: 'application/pdf' });
    fireEvent.change(document.getElementById('recovery-proof') as HTMLInputElement, { target: { files: [pdf] } });
  };

  it('opens the code dialog with nothing uploaded, then uploads and records once verified', async () => {
    withClient(<SpecialAdvanceRecoveryForm advance={{ id: ADVANCE_ID } as unknown as SpecialAdvanceStatement} />);
    fillRecovery();
    fireEvent.click(document.getElementById('recovery-submit') as HTMLButtonElement);

    expect(await screen.findByText('Authenticator verification')).toBeTruthy();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith('special_advance_record_recovery', expect.anything());

    enterCode('special-advance-step-up-code', 'special-advance-step-up-submit');

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('special_advance_record_recovery', expect.anything()));
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    const sent = mocks.rpc.mock.calls.find(([fn]) => fn === 'special_advance_record_recovery')![1];
    expect(sent.p_recovery.proof_path).toBe(mocks.upload.mock.calls[0][0]);
  });

  it('uploads straight away when the session is already verified', async () => {
    mocks.aal.level = 'aal2';
    withClient(<SpecialAdvanceRecoveryForm advance={{ id: ADVANCE_ID } as unknown as SpecialAdvanceStatement} />);
    fillRecovery();
    fireEvent.click(document.getElementById('recovery-submit') as HTMLButtonElement);

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('special_advance_record_recovery', expect.anything()));
    expect(screen.queryByText('Authenticator verification')).toBeNull();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
});

describe('M1: a failed retry after the code dialog closed is reported', () => {
  it('shows the refusal instead of losing it', async () => {
    const onSuccess = vi.fn().mockRejectedValue({ message: 'MFA_REQUIRED' });
    render(<SpecialAdvanceStepUpDialog open onOpenChange={() => {}} onSuccess={onSuccess} />);

    enterCode('special-advance-step-up-code', 'special-advance-step-up-submit');

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
