/**
 * ActivatePartner page data code (design v2 §3.4.3, §8.6): the lookup and activation go through the
 * edge functions, the activation body keeps `user_id` for the old function, every refusal maps to
 * the right message, and a sign-in looks the note up again. The page's JSX (rate card, success card)
 * is Gemini's (§6.2 #1) and is not asserted here.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getUser: vi.fn(),
  getSession: vi.fn(),
  signIn: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
    auth: {
      getUser: mocks.getUser,
      getSession: mocks.getSession,
      signInWithPassword: mocks.signIn,
      signUp: vi.fn(),
    },
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock('@/lib/signupGuard', () => ({ getSignupDeviceFp: async () => null }));

import ActivatePartner from '@/pages/ActivatePartner';

const NOTE = { partner_name: 'Jane Doe', amount: 1_000_000, contribution_type: 'once_off', return_rate: null, monthly_return: null };
const SESSION = { data: { session: { access_token: 'jwt', user: { id: 'user-1' } } } };
const httpError = (status: number, body: unknown) => ({ message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify(body), { status }) });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/activate-partner?token=tok-1']}>
      <Routes>
        <Route path="/activate-partner" element={<ActivatePartner />} />
        <Route path="/dashboard/funder" element={<div>funder dashboard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const activateCalls = () => mocks.invoke.mock.calls.filter(([fn]) => fn === 'activate-promissory-note');
const lookupCalls = () => mocks.invoke.mock.calls.filter(([fn]) => fn === 'lookup-promissory-note');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  mocks.getSession.mockResolvedValue(SESSION);
});

function routeInvoke(activate: () => unknown) {
  mocks.invoke.mockImplementation(async (fn: string) =>
    fn === 'lookup-promissory-note' ? { data: { note: NOTE }, error: null } : activate());
}

describe('ActivatePartner data code', () => {
  it('looks the note up by token and activates with { token, user_id } (old function still reads user_id)', async () => {
    routeInvoke(() => ({ data: { success: true, already_active: false, return_rate: 10, monthly_return: 100_000, your_rate: 10 }, error: null }));
    renderPage();
    const button = await screen.findByRole('button', { name: /Activate Support/i });
    expect(lookupCalls()[0][1]).toEqual({ body: { token: 'tok-1' } });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(activateCalls()).toHaveLength(1);
    expect(activateCalls()[0][1]).toEqual({ body: { token: 'tok-1', user_id: 'user-1' } });
  });

  it('a pre-cut-off note for another contact (403 NOTE_CONTACT_MISMATCH) says Partner Ops will link it', async () => {
    routeInvoke(() => ({ data: null, error: httpError(403, { error: 'Contact does not match.', code: 'NOTE_CONTACT_MISMATCH' }) }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Activate Support/i }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    // The kind comes from `code` (unit-tested in partnerReturnsBrowserLogic); whatever the server's wording,
    // the person is told Partner Ops can link the note.
    expect(mocks.toastError).toHaveBeenCalledWith('This note was written for another phone number or email. Partner Ops can link it for you.');
  });

  it('a note linked to another account (403) is not reported as a contact mismatch', async () => {
    routeInvoke(() => ({ data: null, error: httpError(403, { error: 'This note is already linked to another account', code: 'NOTE_LINKED_ELSEWHERE' }) }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Activate Support/i }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('This note is already linked to another account'));
  });

  it('a 409 race looks the note up again; a 500 never shows raw server text', async () => {
    routeInvoke(() => ({ data: null, error: httpError(409, { error: 'This note changed while you were activating it. Please open the link again.', code: 'NOTE_CHANGED' }) }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Activate Support/i }));
    await waitFor(() => expect(lookupCalls()).toHaveLength(2));

    mocks.toastError.mockClear();
    routeInvoke(() => ({ data: null, error: httpError(500, { error: 'duplicate key value violates unique constraint', code: 'ACTIVATION_FAILED' }) }));
    fireEvent.click(screen.getByRole('button', { name: /Activate Support/i }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Activation failed. Please try again.'));
  });

  it('no session: no activation call, back to the sign-in form', async () => {
    routeInvoke(() => ({ data: { success: true }, error: null }));
    renderPage();
    const button = await screen.findByRole('button', { name: /Activate Support/i });
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Please sign in to activate this note'));
    expect(activateCalls()).toHaveLength(0);
    expect(await screen.findByRole('button', { name: /Create Account/i })).toBeInTheDocument();
  });

  it('signing in looks the note up again (a note linked to this account then shows its own rate)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    mocks.signIn.mockResolvedValue({ error: null });
    routeInvoke(() => ({ data: { success: true }, error: null }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /I Have an Account/i }));
    fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /^Sign In$/i }));
    await waitFor(() => expect(lookupCalls()).toHaveLength(2));
    expect(await screen.findByRole('button', { name: /Activate Support/i })).toBeInTheDocument();
  });

  it('an invalid token shows the invalid-link screen and never activates', async () => {
    mocks.invoke.mockResolvedValue({ data: null, error: httpError(404, { error: 'Note not found' }) });
    renderPage();
    expect(await screen.findByText('This activation link is invalid or has expired')).toBeInTheDocument();
    expect(activateCalls()).toHaveLength(0);
  });
});
