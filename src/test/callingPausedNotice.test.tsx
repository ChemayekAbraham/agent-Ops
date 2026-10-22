/**
 * Calling from the app is paused while the phone line runs automated calls.
 *
 * The server is the gate — it refuses every human call while the pause is on.
 * These tests pin the courtesy layer on top of it:
 *  - the notice states the pause in plain words and for how long;
 *  - the notice disappears the moment the pause is lifted;
 *  - the summary-history sheet's Call button vanishes when no dial action is
 *    offered, and comes back exactly as before when one is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const pauseMock = vi.fn(() => ({ data: { paused: false, reason: null, paused_at: null } }));

vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useHumanCallingPaused: () => pauseMock(),
}));

import { CallingPausedNotice } from '@/components/executive/crm/call-centre/CallingPausedNotice';
import { CallSummaryHistorySheet } from '@/components/executive/crm/call-centre/CallSummaryHistorySheet';

vi.mock('@/hooks/useCrmCallCentre', () => ({
  useCallHistoryFor: () => ({ data: [], isLoading: false }),
}));

const renderNode = (ui: React.ReactElement) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

const bodyText = () => document.body.textContent ?? '';

describe('Calling-paused notice', () => {
  beforeEach(() => {
    pauseMock.mockClear();
    pauseMock.mockReturnValue({ data: { paused: false, reason: null, paused_at: null } });
  });

  it('says nothing while calling is allowed', () => {
    renderNode(<CallingPausedNotice />);
    expect(bodyText()).not.toMatch(/Calling from the app is paused/);
  });

  it('explains the pause in plain words and since when', () => {
    pauseMock.mockReturnValue({
      data: {
        paused: true,
        reason: 'automated calls',
        paused_at: new Date(Date.now() - 12 * 60_000).toISOString(),
      },
    });
    renderNode(<CallingPausedNotice />);
    expect(bodyText()).toMatch(/Calling from the app is paused\. This line is now used for automated calls\./);
    expect(bodyText()).toMatch(/Paused 12 minutes ago/);
  });

  it('comes back when the pause is lifted', () => {
    pauseMock.mockReturnValue({ data: { paused: true, reason: null, paused_at: null } });
    const { unmount } = renderNode(<CallingPausedNotice />);
    expect(bodyText()).toMatch(/Calling from the app is paused/);
    unmount();

    pauseMock.mockReturnValue({ data: { paused: false, reason: null, paused_at: null } });
    renderNode(<CallingPausedNotice />);
    expect(bodyText()).not.toMatch(/Calling from the app is paused/);
  });
});

describe('Summary history sheet Call button', () => {
  const sheet = (withCall: boolean) =>
    renderNode(
      <CallSummaryHistorySheet
        calleeId="u1"
        name="Nabukeera Sarah"
        phone="+256772000111"
        avatarUrl={null}
        open
        onOpenChange={() => {}}
        onCall={withCall ? () => {} : undefined}
      />,
    );

  it('keeps its Call button when dialling is offered', () => {
    sheet(true);
    expect(screen.getByRole('button', { name: 'Call' })).toBeInTheDocument();
  });

  it('loses its Call button while calling is paused', () => {
    sheet(false);
    expect(screen.queryByRole('button', { name: 'Call' })).toBeNull();
    // The history itself stays readable.
    expect(bodyText()).toMatch(/No calls recorded for this person yet\./);
  });
});
