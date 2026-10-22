import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  enabled: true,
  pending: false,
  call: vi.fn().mockResolvedValue('call-id'),
  scripts: [
    { id: 'tenant-script', category: 'tenant', name: 'Rent due today', version: 1, is_active: true },
    { id: 'employee-script', category: 'employee', name: 'Employee greeting', version: 1, is_active: true },
    { id: 'partner-script', category: 'partner', name: 'Supporter greeting', version: 1, is_active: true },
  ],
}));
vi.mock('@/hooks/useVoiceAutocall', () => ({
  useAutocallScripts: () => ({ data: state.scripts, isPending: false, error: null }),
  useAutocallDemoConfig: () => ({ data: state.enabled ? { phone: '0701355245' } : undefined, error: state.enabled ? null : new Error('Unavailable'), isPending: false }),
  useAutocallDemoCall: () => ({ mutateAsync: state.call, isPending: state.pending }),
}));
import { AutocallDemoCalls } from '@/components/crm/autocall/AutocallDemoCalls';
afterEach(() => { cleanup(); vi.clearAllMocks(); state.enabled = true; state.pending = false; });
describe('Overview test calling', () => {
  it.each([
    ['Tenant', 'tenant-script'],
    ['Employee', 'employee-script'],
    ['Supporter', 'partner-script'],
  ])('requires confirmation before calling with the %s script', async (label, scriptId) => {
    render(<AutocallDemoCalls/>);
    fireEvent.click(screen.getByRole('button', { name: `Call as ${label}` }));
    expect(state.call).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').textContent).toContain('0701355245');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm test call' }));
    await waitFor(() => expect(state.call).toHaveBeenCalledExactlyOnceWith({ scriptId }));
  });
  it('cannot request calls before the server enables the approved destination', () => {
    state.enabled = false;
    render(<AutocallDemoCalls/>);
    for (const label of ['Tenant', 'Employee', 'Supporter']) expect(screen.getByRole('button', { name: `Call as ${label}` })).toBeDisabled();
    expect(state.call).not.toHaveBeenCalled();
  });
  it('cancelling confirmation never requests a call', () => {
    render(<AutocallDemoCalls/>);
    fireEvent.click(screen.getByRole('button', { name: 'Call as Tenant' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(state.call).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('disables all call controls while a request is pending', () => {
    state.pending = true;
    render(<AutocallDemoCalls/>);
    for (const label of ['Tenant', 'Employee', 'Supporter']) expect(screen.getByRole('button', { name: `Call as ${label}` })).toBeDisabled();
  });
});