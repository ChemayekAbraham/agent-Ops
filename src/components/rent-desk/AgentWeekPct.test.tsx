import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentWeekPct } from './AgentWeekPct';
import { normalizeAgentWeekPct } from '@/lib/agentWeekPct';

const [mixed] = normalizeAgentWeekPct([{
  agent_id: 'a1', week_start: '2026-10-22', week_end: '2026-10-28', days_left: 2, book: 'mixed',
  in_window_plans: 4, in_window_collected: 125000, in_window_due_so_far: 160000, in_window_projected_due: 200000, in_window_required_pct: 0.5,
  expired_plans: 2, expired_collected: 20000, expired_due_so_far: 40000, expired_projected_due: 50000, expired_required_pct: 0.2,
  last_week_start: '2026-10-15', last_week_end: '2026-10-21', last_book: 'mixed', last_in_window_pct: 0.7125, last_expired_pct: 0.4, last_passes: true,
}]);
const [empty] = normalizeAgentWeekPct([{ agent_id: 'a2', week_start: '2026-10-22', week_end: '2026-10-28', book: 'none' }]);

describe('AgentWeekPct', () => {
  it('shows the main figure to one decimal, the expired figure beside it, and the full detail on hover', () => {
    render(<AgentWeekPct week={mixed} />);
    expect(screen.getByTestId('agent-week-pct-main').textContent).toContain('78.1%');
    expect(screen.getByTestId('agent-week-pct-expired').textContent).toContain('50.0%');
    expect(screen.getByTestId('agent-week-pct').getAttribute('title')).toContain('UGX 125,000 collected of UGX 160,000 expected so far');
  });
  it('shows a dash when nothing was billed this week', () => {
    render(<AgentWeekPct week={empty} />);
    expect(screen.getByTestId('agent-week-pct-main').textContent).toContain('-');
    expect(screen.queryByTestId('agent-week-pct-expired')).toBeNull();
  });
  it('shows a placeholder while loading and nothing when it could not load', () => {
    const { rerender } = render(<AgentWeekPct week={undefined} loading />);
    expect(screen.getByTestId('agent-week-pct-loading')).toBeTruthy();
    rerender(<AgentWeekPct week={undefined} />);
    expect(screen.queryByTestId('agent-week-pct')).toBeNull();
    expect(screen.queryByTestId('agent-week-pct-loading')).toBeNull();
  });
  it('names who it is for when the name beside it is not the registering agent', () => {
    render(<AgentWeekPct week={mixed} forName="Sam Registered" />);
    expect(screen.getByTestId('agent-week-pct').getAttribute('title')).toContain('For Sam Registered.');
  });
});
