import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], decide: vi.fn() }));
vi.mock('@/hooks/useNationalIdLink', () => ({
  useNationalIdLinkRequestsForHolder: () => ({ data: state.rows }),
  useNationalIdLinkOwnerDecision: () => ({ mutateAsync: state.decide, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import NationalIdLinkGate from '@/components/notifications/NationalIdLinkGate';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'req-1', nin: 'CM0*******U9EC', status: 'awaiting_owner', code_verified_at: null,
  created_at: '2026-11-05T08:00:00Z', expires_at: '2026-11-12T08:00:00Z',
  requester_name: 'Example Agent', requester_phone: null, ...over,
});

beforeEach(() => {
  state.rows = [];
  state.decide.mockReset();
  state.decide.mockResolvedValue({ success: true });
});

describe('National ID holder popup', () => {
  it('stays closed until the asker has entered the code', () => {
    state.rows = [row()];
    render(<NationalIdLinkGate />);
    expect(screen.queryByText('Someone wants to use your National ID')).toBeNull();
  });

  it('opens once the code is entered, with Allow usable and no reason box up front', () => {
    state.rows = [row({ code_verified_at: '2026-11-05T08:01:00Z' })];
    render(<NationalIdLinkGate />);
    expect(screen.getByText('Someone wants to use your National ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, I allow it' })).toBeEnabled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('allows with one confirmation and sends no note', async () => {
    state.rows = [row({ code_verified_at: '2026-11-05T08:01:00Z' })];
    render(<NationalIdLinkGate />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, I allow it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, allow it' }));
    await waitFor(() => expect(state.decide).toHaveBeenCalledWith({ id: 'req-1', approve: true, note: undefined }));
  });

  it('asks for the optional reason only inside the refuse step', async () => {
    state.rows = [row({ code_verified_at: '2026-11-05T08:01:00Z' })];
    render(<NationalIdLinkGate />);
    fireEvent.click(screen.getByRole('button', { name: 'No, I do not agree' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Why are you refusing? (optional)' }), { target: { value: 'I do not know them' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yes, refuse it' }));
    await waitFor(() => expect(state.decide).toHaveBeenCalledWith({ id: 'req-1', approve: false, note: 'I do not know them' }));
  });

  it('skips a waiting request and shows the one whose code was entered', () => {
    state.rows = [row({ id: 'early' }), row({ id: 'ready', requester_name: 'Ready Agent', code_verified_at: '2026-11-05T08:01:00Z' })];
    render(<NationalIdLinkGate />);
    expect(screen.getByText('Ready Agent')).toBeInTheDocument();
  });
});
