import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { state, depositProps, accept } = vi.hoisted(() => ({
  state: { preview: null as any, fresh: null as any, watchState: 'idle', watchThrows: false },
  depositProps: { current: null as any },
  accept: vi.fn(),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'viewer' } }) }));
vi.mock('@/hooks/useUserAvatars', () => ({ useUserAvatars: () => ({ avatarFor: () => null }) }));
vi.mock('@/components/co-support/CoSupportWaitingSection', () => ({ CoSupportInviteRow: () => null }));
vi.mock('@/hooks/useCoSupport', () => ({
  useCoSupportPreview: () => ({ data: state.preview, isLoading: false, error: null }),
  useCoSupportLeadPhoto: () => null,
  useCoSupportFloatWatch: () => {
    if (state.watchThrows) throw new ReferenceError("Cannot access 'depositStatus' before initialization");
    return { state: state.watchState, preview: state.fresh };
  },
  useAcceptCoSupport: () => ({ mutate: accept, isPending: false }),
  useDeclineCoSupport: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/components/payments/DepositFlow', () => ({ default: (props: any) => {
  depositProps.current = props;
  return null;
} }));
import CoSupportInvite from '@/pages/CoSupportInvite';

const page = () => <MemoryRouter initialEntries={['/co-support/AB12CD34EF56']}><Routes><Route path="/co-support/:code" element={<CoSupportInvite />} /></Routes></MemoryRouter>;
beforeEach(() => {
  accept.mockReset();
  state.fresh = null;
  state.watchState = 'idle';
  state.watchThrows = false;
  state.preview = { found: true, signed_in: true, can_accept: false, reason: 'funds_short', kind: 'rent_plan', status: 'open', lead_first_name: 'Benjamin', tenant_first_name: 'Nakasagga', your_share: 1530000, float_needed: 1335514, float_available: 194486 };
});
describe('invitation deposit handoff', () => {
  it('opens the existing payment form with operational float locked and the server shortfall', async () => {
    render(page());
    await userEvent.click(screen.getByRole('button', { name: 'Add float to join Benjamin' }));
    expect(depositProps.current).toMatchObject({ open: true, defaultPurpose: 'operational_float', lockPurpose: true, defaultAmount: 1335514, defaultChannel: 'momo', defaultMomoProvider: 'mtn' });
    expect(accept).not.toHaveBeenCalled();
  });
  it('submitted payment waits, becomes ready on arrival, and never accepts automatically', async () => {
    const view = render(page());
    await userEvent.click(screen.getByRole('button', { name: 'Add float to join Benjamin' }));
    state.watchState = 'waiting';
    act(() => depositProps.current.onSubmitted({ id: 'deposit', amount: 1335514, transactionId: 'MP123456789', provider: 'mtn', outcome: 'no_match' }));
    expect(depositProps.current.open).toBe(false);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    state.watchState = 'arrived';
    state.fresh = { ...state.preview, can_accept: true, reason: null, float_available: 1530000 };
    view.rerender(page());
    await userEvent.click(screen.getByRole('button', { name: 'Join Benjamin now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join Benjamin' })).toBeInTheDocument();
    expect(accept).not.toHaveBeenCalled();
  });
  it('rejected payments reopen the same deposit form without accepting', async () => {
    const view = render(page());
    state.watchState = 'waiting';
    act(() => depositProps.current.onSubmitted({ id: 'deposit', amount: 1335514, transactionId: 'MP123456789', provider: 'mtn', outcome: 'no_match' }));
    state.watchState = 'rejected';
    view.rerender(page());
    await userEvent.click(screen.getAllByRole('button', { name: 'Add float to join Benjamin' }).at(-1) as HTMLElement);
    expect(depositProps.current.open).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });
  it('slow payments keep the invitation usable without automatically accepting', () => {
    render(page());
    state.watchState = 'slow';
    act(() => depositProps.current.onSubmitted({ id: 'deposit', amount: 1335514, transactionId: 'MP123456789', provider: 'mtn', outcome: 'no_match' }));
    expect(screen.getByRole('button', { name: 'Add float to join Benjamin', hidden: true })).toBeEnabled();
    expect(accept).not.toHaveBeenCalled();
  });
  it('a broken optional watcher cannot crash the invitation or imply payment success', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(page());
    state.watchThrows = true;
    act(() => depositProps.current.onSubmitted({ id: 'deposit', amount: 1335514, transactionId: 'MP123456789', provider: 'mtn', outcome: 'no_match' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
    expect(screen.getByRole('button', { name: 'Add float to join Benjamin', hidden: true })).toBeEnabled();
    expect(accept).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});