import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeeklyChampionTeamDialog } from './WeeklyChampionTeamDialog';

vi.mock('@/hooks/useAgentCollectionLeague', () => ({
  useWeeklyChampionTeam: () => ({
    data: {
      has_champion: true,
      week_start: '2026-11-02',
      week_end: '2026-11-08',
      team: {
        team_name: 'Champion team',
        performance_percentage: 80,
        collected_amount: 4000,
        active_collectors: 3,
        total_members: 4,
      },
      top_collectors: [
        { agent_id: 'collector-one', name: 'Collector One', collected_amount: 1000, payments: 2 },
      ],
    },
  }),
}));

describe('weekly champion percentage figures', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T09:20:00Z'));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows the collector share of team collections as a percentage', () => {
    render(<WeeklyChampionTeamDialog />);
    expect(screen.getByText('25.0%')).toBeInTheDocument();
  });

  it('keeps the team target performance percentage unchanged', () => {
    render(<WeeklyChampionTeamDialog />);
    expect(screen.getByText('80%')).toBeInTheDocument();
  });
});