import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { rentPlan, subAgentFixture } from '@/test/fixtures/serviceCenter';
import { SubAgentRankingsBoard } from './SubAgentRankingsBoard';

/** Row order as the board renders it, read off each row's open-details button. */
const renderedOrder = () =>
  screen
    .getAllByRole('button', { name: /^Open .+ details$/ })
    .map((b) => (b.getAttribute('aria-label') ?? '').replace(/^Open /, '').replace(/ details$/, ''));

const roster = () => [
  subAgentFixture('a', [rentPlan({ total_repayment: 1_000_000, amount_repaid: 900_000 })], {
    full_name: 'Aisha Nakato',
  }),
  subAgentFixture('b', [rentPlan({ total_repayment: 1_000_000, amount_repaid: 500_000 })], {
    full_name: 'Bosco Okello',
  }),
  subAgentFixture('c', [rentPlan({ total_repayment: 4_000_000, amount_repaid: 100_000 })], {
    full_name: 'Carol Atim',
  }),
];

/** Rows are only tappable when the page passes a handler, so default one in. */
const renderBoard = (props: Partial<React.ComponentProps<typeof SubAgentRankingsBoard>> = {}) =>
  render(<SubAgentRankingsBoard subAgents={roster()} onOpenSubAgent={() => {}} {...props} />);

describe('SubAgentRankingsBoard', () => {
  it('lists sub-agents best-collector first', () => {
    renderBoard();
    expect(renderedOrder()).toEqual(['Aisha Nakato', 'Bosco Okello', 'Carol Atim']);
  });

  it('reorders to biggest arrears first when Outstanding is picked', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('radio', { name: 'Outstanding' }));
    expect(renderedOrder()).toEqual(['Carol Atim', 'Bosco Okello', 'Aisha Nakato']);
  });

  it('ranks on collection rate rather than plan size when Rate is picked', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('radio', { name: 'Rate' }));
    // Carol collected the least of a much bigger book, so she stays last.
    expect(renderedOrder()).toEqual(['Aisha Nakato', 'Bosco Okello', 'Carol Atim']);
  });

  it('opens the detail sheet for the sub-agent whose row was tapped', () => {
    const onOpenSubAgent = vi.fn();
    renderBoard({ onOpenSubAgent });
    fireEvent.click(screen.getByRole('button', { name: 'Open Bosco Okello details' }));
    expect(onOpenSubAgent).toHaveBeenCalledWith('b');
  });

  it('renders read-only rows when the page passes no open handler', () => {
    render(<SubAgentRankingsBoard subAgents={roster()} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^Open .+ details$/ })).not.toBeInTheDocument();
  });

  it('shows only the top five until the manager asks for the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      subAgentFixture(`s${i}`, [rentPlan({ total_repayment: 1_000_000, amount_repaid: (i + 1) * 10_000 })], {
        full_name: `Agent ${i}`,
      }),
    );
    renderBoard({ subAgents: many });

    expect(renderedOrder()).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7 sub-agents' }));
    expect(renderedOrder()).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Show top 5 only' }));
    expect(renderedOrder()).toHaveLength(5);
  });

  it('prompts the manager to invite sub-agents when the roster is empty', () => {
    renderBoard({ subAgents: [] });
    expect(screen.getByText(/Invite sub-agents to see how they rank/i)).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('explains the tie instead of implying a winner when nothing is collected yet', () => {
    renderBoard({
      subAgents: [
        subAgentFixture('a', [rentPlan({ amount_repaid: 0 })], { full_name: 'Aisha Nakato' }),
        subAgentFixture('b', [rentPlan({ amount_repaid: 0 })], { full_name: 'Bosco Okello' }),
      ],
    });
    expect(screen.getByText(/No collections recorded yet/i)).toBeInTheDocument();
  });

  it('shows a failure note instead of an empty podium when the roster query failed', () => {
    renderBoard({ subAgents: [], error: new Error('boom') });
    expect(screen.getByText(/Could not load rankings/i)).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('holds back rows while the roster is still loading', () => {
    renderBoard({ subAgents: [], isLoading: true });
    expect(screen.getByText(/Loading your team/i)).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('collapses away so it never buries the roster below it', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Hide sub-agent rankings' }));
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show sub-agent rankings' }));
    expect(renderedOrder()).toHaveLength(3);
  });

  it('excludes referral-only plans so the same shillings are never counted twice', () => {
    renderBoard({
      subAgents: [
        subAgentFixture(
          'a',
          [rentPlan({ total_repayment: 1_000_000, amount_repaid: 900_000, owned_by_subagent: false })],
          { full_name: 'Aisha Nakato' },
        ),
      ],
    });
    expect(screen.getByText('No funded rent plans yet')).toBeInTheDocument();
  });
});
