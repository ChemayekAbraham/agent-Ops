import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// The invitation page's sentences come from coSupportInviteCopy (the server's
// figures, addressed to the person who opened the link). This guards that the
// page really renders them instead of its own wording.
const { state, acceptMock } = vi.hoisted(() => ({
  state: { preview: null as any },
  acceptMock: { mutate: vi.fn(), isPending: false },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/components/co-support/CoSupportWaitingSection', () => ({ CoSupportInviteRow: () => null }));
vi.mock('@/hooks/useCoSupport', () => ({
  useCoSupportPreview: () => ({ data: state.preview, isLoading: false, error: null }),
  useAcceptCoSupport: () => acceptMock,
  useDeclineCoSupport: () => ({ mutate: vi.fn(), isPending: false }),
}));

import CoSupportInvite from '@/pages/CoSupportInvite';

const CODE = 'AB12CD34EF56';

/** The real case from 12 Nov 2026: half 1,530,000; 551,486 float; 357,000 held for an own share. */
const fixture = (over: Record<string, unknown> = {}) => ({
  found: true,
  kind: 'rent_plan',
  status: 'open',
  lead_first_name: 'Benjamin',
  tenant_first_name: 'Nakasagga',
  your_share: 1530000,
  your_monthly_rent_profit_share: 229500,
  expires_at: new Date(Date.now() + (46 * 60 + 34) * 60_000).toISOString(),
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={[`/co-support/${CODE}`]}>
      <Routes>
        <Route path="/co-support/:code" element={<CoSupportInvite />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  acceptMock.mutate.mockReset();
  acceptMock.isPending = false;
});

const SHORT_DETAIL =
  "You have UGX 551,486 of float. UGX 357,000 is set aside for Mary's Rent Plan that you're sharing, " +
  'so UGX 194,486 is free right now. Add UGX 1,335,514 to your wallet, then open this link again to join Benjamin.';

describe('invitation page uses the copy helper', () => {
  it('signed out: names the sharer, shows the half and the two labels', () => {
    state.preview = fixture({ signed_in: false });
    renderPage();

    expect(screen.getByText("Benjamin invited you to support Nakasagga's home together")).toBeInTheDocument();
    expect(screen.getByText(/^Benjamin has already set aside one half\./)).toBeInTheDocument();
    expect(screen.getByText('Your half: UGX 1,530,000')).toBeInTheDocument();
    expect(screen.getByText(/^Benjamin is holding this for you for \d+h \d{2}m$/)).toBeInTheDocument();
    expect(screen.getByText(/^Sign in to join Benjamin\. New to Welile\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I have a Welile account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "I'm new to Welile" })).toBeInTheDocument();
  });

  it('can accept: own Rent Profit Share and the accept / decline labels', () => {
    state.preview = fixture({ signed_in: true, can_accept: true });
    renderPage();

    expect(screen.getByText("You'd earn UGX 229,500 a month in Rent Profit Share")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join Benjamin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not this time' })).toBeInTheDocument();
  });

  it('short of funds: title, the set-aside breakdown and the wallet button', () => {
    state.preview = fixture({
      signed_in: true,
      can_accept: false,
      reason: 'funds_short',
      float_available: 194486,
      float_needed: 1335514,
      float_balance: 551486,
      float_held_for_your_shares: 357000,
      float_held_other: 0,
      your_open_shares: [{ id: 'x', kind: 'rent_plan', title: "Mary's Rent Plan", held: 357000, expires_at: '' }],
    });
    renderPage();

    expect(screen.getByText("You're UGX 1,335,514 short of your half")).toBeInTheDocument();
    expect(screen.getByText(SHORT_DETAIL)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add float to your wallet' })).toBeInTheDocument();
    // the float figures live inside the sentence, never as bare numbers of their own
    expect(screen.queryAllByText(/^UGX 551,486$/)).toHaveLength(0);
    expect(screen.queryAllByText(/^UGX 357,000$/)).toHaveLength(0);
  });

  it('a house says so, and shows the house title and place', () => {
    state.preview = fixture({
      kind: 'house',
      tenant_first_name: null,
      house_title: "Nakasagga's home",
      city: 'Kampala',
      signed_in: true,
      can_accept: true,
    });
    renderPage();

    expect(screen.getByText('Benjamin invited you to support an empty house together')).toBeInTheDocument();
    expect(screen.getByText("Nakasagga's home")).toBeInTheDocument();
    expect(screen.getByText('Kampala')).toBeInTheDocument();
    expect(screen.getByText(/Partner Ops approve shared houses before any money moves\./)).toBeInTheDocument();
  });

  it('after accepting: the copy\'s success title and detail', async () => {
    acceptMock.mutate.mockImplementation((_code: string, opts: any) =>
      opts.onSuccess({ ok: true, status: 'accepted', kind: 'rent_plan', your_share: 1530000 }),
    );
    state.preview = fixture({ signed_in: true, can_accept: true });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Join Benjamin' }));

    expect(screen.getByText('You and Benjamin now support Nakasagga\'s home together')).toBeInTheDocument();
    expect(
      screen.getByText('Your portfolio: UGX 1,530,000. You earn UGX 229,500 a month in Rent Profit Share.'),
    ).toBeInTheDocument();
  });

  it('never uses the banned words', () => {
    state.preview = fixture({ signed_in: true, can_accept: true });
    renderPage();
    expect(document.body.textContent ?? '').not.toMatch(/\b(loan|lender|interest|ROI|returns?)\b/i);
  });
});
