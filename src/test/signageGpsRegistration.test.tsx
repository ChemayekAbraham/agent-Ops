import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), submit: vi.fn(), gps: vi.fn() }));
vi.mock('@/lib/reverseGeocode', () => ({ reverseGeocode: mocks.lookup }));
vi.mock('@/hooks/useWelileSignages', () => ({
  useMySignages: () => ({ data: [], isLoading: false }),
  useSubmitSignage: () => ({ mutateAsync: mocks.submit, isPending: false }),
  useDeleteSignage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useResubmitSignage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useLoadSignageDetail: () => vi.fn(),
}));
vi.mock('@/components/signages/SignageEvidence', () => ({ SignageEvidence: () => null }));
import AgentWelileSignages from '@/pages/agent/AgentWelileSignages';
const renderPage = () => render(<MemoryRouter><AgentWelileSignages /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: mocks.gps } });
  mocks.gps.mockImplementation(success => success({ coords: { latitude: 0.35, longitude: 32.6, accuracy: 8 } }));
  mocks.lookup.mockResolvedValue({ address: 'Jinja Road, Naguru, Kampala', raw: { address: { country_code: 'ug', county: 'Kampala', suburb: 'Naguru' } } });
});
describe('GPS-only signage registration', () => {
  it('fills every location field from GPS and prevents manual overrides', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Capture Live Location' }));
    await waitFor(() => expect(screen.getByLabelText('District')).toHaveValue('Kampala'));
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith(0.35, 32.6);
    expect(screen.getByLabelText('Village / Locality')).toHaveValue('Naguru');
    expect(screen.getByLabelText('Plot / Street / Immediate Landmark')).toHaveValue('Jinja Road, Naguru, Kampala');
    for (const label of ['District', 'County', 'Sub-County', 'Parish', 'Village / Locality', 'Plot / Street / Immediate Landmark']) {
      expect(screen.getByLabelText(label)).toHaveAttribute('readonly');
    }
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('clears the previous address and blocks saving when recapture cannot resolve it', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Capture Live Location' }));
    await waitFor(() => expect(screen.getByLabelText('District')).toHaveValue('Kampala'));
    mocks.lookup.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Re-capture Location' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit Signage for Ops Review' })).toBeDisabled());
    expect(screen.getByLabelText('District')).toHaveValue('');
    expect(screen.getByLabelText('Plot / Street / Immediate Landmark')).toHaveValue('');
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('prevents overlapping captures and blocks saving while the address lookup is pending', async () => {
    let finish: ((value: unknown) => void) | undefined;
    mocks.lookup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Capture Live Location' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-capture Location' }));
    });
    // While capture is pending the re-capture control is disabled.
    expect(screen.getByRole('button', { name: 'Re-capture Location' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Submit Signage for Ops Review' })).toBeDisabled();
    await act(async () => finish?.(null));
    expect(screen.getByLabelText('District')).toHaveValue('');
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});