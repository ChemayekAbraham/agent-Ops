import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({ detail: {} as Record<string, unknown>, mutate: vi.fn(), reupload: vi.fn(), userId: 'reviewer', confirm: vi.fn(), missing: [] as string[], lc1: null as string | null }));
vi.mock('@/hooks/useAgentVettingQueue', () => ({
  useAgentVettingQueue: () => ({ data: { total: 1, counts: {}, rows: [{ agent_id: 'fixture', name: 'Example Agent' }] } }),
  useAgentVettingDetail: () => ({ data: state.detail, refetch: vi.fn() }),
  useAgentVettingPhotos: () => ({ data: { id_front: '/front.png', id_back: '/back.png', passport: '/selfie.png', prev_id_front: '/old-front.png', prev_id_back: '/old-back.png' }, refetch: vi.fn() }),
  useAgentVettingMissing: () => ({ data: state.missing, isLoading: false, error: null, refetch: vi.fn() }),
  useConfirmVettingItem: () => ({ mutate: state.confirm, isPending: false }),
  useHomeLc1Letter: () => ({ data: state.lc1, isLoading: false }),
  useDecideAgentVetting: () => ({ mutate: state.mutate, isPending: false }),
  useRequestIdReupload: () => ({ mutateAsync: state.reupload, isPending: false }),
  useAgentKycOverview: () => ({ data: undefined, isLoading: false }),
  useAgentKycIdentitySummary: () => ({ data: { fixture: 0 } }),
  useAgentKycIdentityGroup: () => ({ data: { total: 0, linked_count: 0, members: [] } }),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: state.userId } }) }));
// No Supabase env is needed: every server call above is mocked, and nothing reaches the client.
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() }, auth: { getSession: vi.fn(), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) } } }));
vi.mock('@/components/agent-vetting/VettingMap', () => ({ default: () => null }));
vi.mock('@/hooks/useUserAvatars', () => ({ useUserAvatars: () => ({ avatarFor: () => null }) }));
import AgentVerificationReview from '@/pages/agent-ops/AgentVerificationReview';

beforeEach(() => {
  state.mutate.mockReset();
  state.confirm.mockReset();
  state.missing = [];
  state.lc1 = null;
  state.reupload.mockReset(); state.reupload.mockResolvedValue({ success: true }); state.userId = 'reviewer';
  state.detail = { agent_id: 'fixture', name: 'Example Agent', status: 'submitted', events: [], id_source: 'own', id_name: 'New Name', id_nin_masked: 'CM0*******QTOE', id_captured_at: '2026-10-28T08:00:00Z' };
});
const openPanel = () => {
  render(<MemoryRouter><AgentVerificationReview /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Example Agent' }));
};
describe('Agent Ops ID review', () => {
  it('shows current ID and enlarges it without making a decision', () => {
    openPanel();
    expect(screen.getByText('Name on ID: New Name')).toBeInTheDocument();
    expect(screen.getByText('NIN: CM0*******QTOE')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge ID front' }));
    expect(screen.getByRole('img', { name: 'Zoomed photo' })).toHaveAttribute('src', '/front.png');
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('shows both recorded versions and retains the replacement event', () => {
    Object.assign(state.detail, { prev_id_name: 'Previous Name', prev_id_nin_masked: 'CM1*******ABCD', prev_id_front_path: 'old/front', id_changed_at: '2026-10-28T08:00:00Z', events: [{ event: 'id_replaced', at: '2026-10-28T08:00:00Z' }] });
    openPanel();
    expect(screen.getByText('Name on ID: Previous Name')).toBeInTheDocument();
    expect(screen.getByText('Name on ID: New Name')).toBeInTheDocument();
    expect(screen.getByText('NIN: CM1*******ABCD')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge Previous ID back' }));
    expect(screen.getByRole('img', { name: 'Zoomed photo' })).toHaveAttribute('src', '/old-back.png');
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('asks the agent to re-upload the ID with a required reason', async () => {
    Object.assign(state.detail, { id_front_path: 'a/front' });
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Ask agent to re-upload ID' }));
    const send = screen.getByRole('button', { name: 'Send back to agent' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'abc' } });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'The NIN on the card does not match' } });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(state.reupload).toHaveBeenCalledWith({ agentId: 'fixture', reason: 'The NIN on the card does not match' }));
  });
  it('offers re-upload on your own record even after your identity is verified for withdrawals', () => {
    Object.assign(state.detail, { id_front_path: 'a/front', identity_verified: true });
    state.userId = 'fixture';
    openPanel();
    expect(screen.getByRole('button', { name: 'Ask agent to re-upload ID' })).toBeInTheDocument();
  });
  it('offers re-upload on your own record while your identity is not yet verified', () => {
    Object.assign(state.detail, { id_front_path: 'a/front', identity_verified: false });
    state.userId = 'fixture';
    openPanel();
    expect(screen.getByRole('button', { name: 'Ask agent to re-upload ID' })).toBeInTheDocument();
  });
  it('still offers re-upload for another agent whose identity is verified', () => {
    Object.assign(state.detail, { id_front_path: 'a/front', identity_verified: true });
    openPanel();
    expect(screen.getByRole('button', { name: 'Ask agent to re-upload ID' })).toBeInTheDocument();
  });
  it('offers re-upload for an agent with ID photos who never submitted', () => {
    Object.assign(state.detail, { status: 'unverified', id_front_path: null, id_back_path: null, has_id_photos: true });
    openPanel();
    expect(screen.getByRole('button', { name: 'Ask agent to re-upload ID' })).toBeInTheDocument();
  });
  it('hides re-upload when the agent has no ID photos at all', () => {
    Object.assign(state.detail, { status: 'unverified', id_front_path: null, id_back_path: null, has_id_photos: false });
    openPanel();
    expect(screen.queryByRole('button', { name: 'Ask agent to re-upload ID' })).toBeNull();
  });
});

/* ───────────── E78: the review's own checks and what is still missing ───────────── */

import { within } from '@testing-library/react';

describe('Agent Ops verification review (E78)', () => {
  it('shows the passport selfie beside the ID front for the face check, and confirms it', () => {
    openPanel();
    const face = document.querySelector('[data-face-check]') as HTMLElement;
    expect(within(face).getByRole('img', { name: 'Passport photo' })).toHaveAttribute('src', '/selfie.png');
    expect(within(face).getByRole('img', { name: 'ID front for the face check' })).toHaveAttribute('src', '/front.png');
    fireEvent.click(screen.getByRole('button', { name: 'Selfie matches the ID' }));
    expect(state.confirm).toHaveBeenCalledWith({ agentId: 'fixture', item: 'face_match', note: undefined }, expect.anything());
  });

  it('next of kin: the note is required, then one confirm call with it', () => {
    openPanel();
    const btn = screen.getByRole('button', { name: 'Next of kin confirmed by call' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What the next of kin said on the call'), { target: { value: 'ok' } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What the next of kin said on the call'), { target: { value: 'Sister: he lives in Kawempe' } });
    fireEvent.click(btn);
    expect(state.confirm).toHaveBeenCalledWith({ agentId: 'fixture', item: 'nok_call', note: 'Sister: he lives in Kawempe' }, expect.anything());
  });

  it("a refused confirm shows the server's words", () => {
    state.confirm.mockImplementation((_a: unknown, o: { onError: (e: Error) => void }) => o.onError(new Error('A staff ID is required')));
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Selfie matches the ID' }));
    expect(screen.getByRole('alert')).toHaveTextContent('A staff ID is required');
  });

  it('confirmed items show when, and their buttons go', () => {
    Object.assign(state.detail, { face_match_confirmed_at: '2026-11-11T08:00:00Z', nok_confirmed_at: '2026-11-11T09:00:00Z', nok_call_note: 'Brother confirmed' });
    openPanel();
    expect(screen.queryByRole('button', { name: 'Selfie matches the ID' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next of kin confirmed by call' })).toBeNull();
    expect(screen.getByText(/Selfie matches the ID ·/)).toBeInTheDocument();
    expect(screen.getByText('“Brother confirmed”')).toBeInTheDocument();
  });

  it('the home LC1 letter from its signed link', () => {
    Object.assign(state.detail, { home_lc1_letter_path: 'agent/lc1.jpg', home_lc1_letter_bucket: 'agent-docs' });
    state.lc1 = 'https://signed/agent-docs/agent/lc1.jpg';
    openPanel();
    const lc1 = document.querySelector('[data-home-lc1]') as HTMLElement;
    expect(within(lc1).getByRole('img', { name: 'Home LC1 letter' })).toHaveAttribute('src', state.lc1);
    expect(within(lc1).getByRole('link', { name: /Open the LC1 letter/ })).toHaveAttribute('href', state.lc1);
  });

  it("lists what is missing, and Approve shows the server's \"Not ready to approve: …\" as-is", () => {
    state.missing = ['selfie matches the ID photo (Agent Ops to confirm)', "LC1 letter for the agent's home"];
    const refusal = "Not ready to approve: selfie matches the ID photo (Agent Ops to confirm); LC1 letter for the agent's home";
    state.mutate.mockImplementation((_a: unknown, o: { onError: (e: Error) => void }) => o.onError(new Error(refusal)));
    openPanel();
    const list = screen.getByRole('list', { name: 'Still missing' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(state.missing);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }));
    expect(state.mutate).toHaveBeenCalledWith({ agentId: 'fixture', approve: true, note: undefined }, expect.anything());
    expect(document.querySelector('[data-approve-error]')).toHaveTextContent(refusal);
  });

  it('nothing missing says so', () => {
    openPanel();
    expect(screen.getByText('Nothing missing')).toBeInTheDocument();
  });
});
