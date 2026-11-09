import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AgentVerificationSettingsEntry } from './Settings';

const state = vi.hoisted(() => ({ value: null as 'verified' | 'unverified' | null }));
vi.mock('@/hooks/useAgentVetting', () => ({
  useAgentVerifiedState: () => state.value,
  AGENT_VERIFICATION_PATH: '/dashboard/agent/verification',
}));
function Destination() { return <output aria-label="Destination">{useLocation().pathname}</output>; }
function entry() { return render(<MemoryRouter initialEntries={['/settings']}><AgentVerificationSettingsEntry /><Destination /></MemoryRouter>); }
beforeEach(() => { cleanup(); state.value = null; });
describe('Settings agent verification eligibility and navigation', () => {
  it('renders no entry when the hook is null, including partners without agent work', () => {
    entry();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('lets an unverified agent navigate to their verification', () => {
    state.value = 'unverified'; entry();
    fireEvent.click(screen.getByRole('button', { name: 'Verify my account' }));
    expect(screen.getByLabelText('Destination')).toHaveTextContent('/dashboard/agent/verification');
  });
  it('lets a verified agent view verification details', () => {
    state.value = 'verified'; entry();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByLabelText('Destination')).toHaveTextContent('/dashboard/agent/verification');
  });
  it('removes the entry when applicability returns to null', () => {
    state.value = 'unverified'; const view = entry();
    state.value = null;
    view.rerender(<MemoryRouter><AgentVerificationSettingsEntry /><Destination /></MemoryRouter>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});