import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmailCollectionGate from '@/components/notifications/EmailCollectionGate';
import { resetSessionPopupForTests } from '@/lib/sessionPopup';
import EmailEditor from '@/components/profile/EmailEditor';

const mocks = vi.hoisted(() => ({
  currentEmail: '0700000000@welile.agent',
  requestCode: vi.fn(), confirmCode: vi.fn(), update: vi.fn(), insert: vi.fn(),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'test-user' } }) }));
vi.mock('@/hooks/useEmailVerification', () => ({ useEmailVerification: () => ({
  requestCode: mocks.requestCode, confirmCode: mocks.confirmCode,
  sending: false, confirming: false, attemptsLeft: 2,
}) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: mocks.currentEmail }, error: null }) }) }),
    update: mocks.update, insert: mocks.insert,
  }),
  auth: { getUser: async () => ({ data: { user: { id: 'test-agent' } } }) },
} }));

beforeEach(() => {
  resetSessionPopupForTests();
  sessionStorage.clear();
  mocks.currentEmail = '0700000000@welile.agent';
  mocks.requestCode.mockReset().mockResolvedValue({ challengeId: 'challenge-1', expiresAt: '2026-10-21T10:00:00Z' });
  mocks.confirmCode.mockReset().mockResolvedValue({ email: 'person@protonmail.com', authSynced: true });
  mocks.update.mockReset().mockReturnValue({ eq: async () => ({ error: null }) });
  mocks.insert.mockReset().mockResolvedValue({ error: null });
});
afterEach(cleanup);

describe('verified email screens', () => {
  it('dismisses for this session and returns when the session dismissal is cleared', async () => {
    const first = render(<EmailCollectionGate />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(sessionStorage.getItem('welile:email-collection:dismissed-session')).toBe('1');
    first.unmount();
    const second = render(<EmailCollectionGate />);
    expect(screen.queryByRole('dialog')).toBeNull();
    second.unmount();
    sessionStorage.clear();
    render(<EmailCollectionGate />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it.each(['protonmail.com', 'proton.me', 'pm.me', 'gmail.com', 'icloud.com', 'outlook.com'])('does not prompt a %s account', async (domain) => {
    mocks.currentEmail = `person@${domain}`;
    render(<EmailCollectionGate />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.requestCode).not.toHaveBeenCalled();
  });

  it('only confirms a six-digit code and never writes the profile itself', async () => {
    render(<EmailCollectionGate />);
    fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'person@protonmail.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    const code = await screen.findByLabelText('6-digit code');
    fireEvent.change(code, { target: { value: '12x345' } });
    expect(code).toHaveValue('12345');
    expect(screen.getByRole('button', { name: 'Confirm email' })).toBeDisabled();
    fireEvent.change(code, { target: { value: '1234567' } });
    expect(code).toHaveValue('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
    await waitFor(() => expect(mocks.confirmCode).toHaveBeenCalledWith('challenge-1', '123456'));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('self-editor retains the two-step flow and displays the server error', async () => {
    mocks.confirmCode.mockRejectedValueOnce(new Error('That code is not correct. You have 2 attempts left.'));
    const saved = vi.fn();
    render(<EmailEditor mode="self" userId="test-user" currentEmail="old@gmail.com" onSaved={saved} />);
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'person@protonmail.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not correct. You have 2 attempts left.');
    expect(saved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith('person@protonmail.com'));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('agent mode keeps the direct save and action log without email verification', async () => {
    const saved = vi.fn();
    render(<EmailEditor mode="agent" userId="managed-user" currentEmail="old@gmail.com" onSaved={saved} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'person@protonmail.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Email' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith('person@protonmail.com'));
    expect(mocks.update).toHaveBeenCalledWith({ email: 'person@protonmail.com' });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'test-agent', user_id: 'managed-user', action_type: 'email_updated' }));
    expect(mocks.requestCode).not.toHaveBeenCalled();
    expect(mocks.confirmCode).not.toHaveBeenCalled();
  });
});