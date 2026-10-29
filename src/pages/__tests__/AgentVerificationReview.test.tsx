import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({ detail: {} as Record<string, unknown>, mutate: vi.fn() }));
vi.mock('@/hooks/useAgentVettingQueue', () => ({
  useAgentVettingQueue: () => ({ data: { total: 1, counts: {}, rows: [{ agent_id: 'fixture', name: 'Example Agent' }] } }),
  useAgentVettingDetail: () => ({ data: state.detail }),
  useAgentVettingPhotos: () => ({ data: { id_front: '/front.png', id_back: '/back.png', prev_id_front: '/old-front.png', prev_id_back: '/old-back.png' }, refetch: vi.fn() }),
  useDecideAgentVetting: () => ({ mutate: state.mutate, isPending: false }),
  useAgentKycOverview: () => ({ data: undefined, isLoading: false }),
  useAgentKycIdentitySummary: () => ({ data: { fixture: 0 } }),
  useAgentKycIdentityGroup: () => ({ data: { total: 0, linked_count: 0, members: [] } }),
}));
vi.mock('@/components/agent-vetting/VettingMap', () => ({ default: () => null }));
import AgentVerificationReview from '@/pages/agent-ops/AgentVerificationReview';

beforeEach(() => {
  state.mutate.mockClear();
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
});