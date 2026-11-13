import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), submit: vi.fn(), gps: vi.fn(), saveDraft: vi.fn() }));
vi.mock('@/lib/signageGpsLocation', async (orig) => {
  const real = await orig<typeof import('@/lib/signageGpsLocation')>();
  return { ...real, lookupSignageGpsLocation: async (lat: number, lng: number) => {
    const r = await mocks.lookup(lat, lng);
    const loc = real.signageGpsLocation(r);
    return loc ? { kind: 'ok', location: loc } : { kind: 'unresolved' };
  } };
});
vi.mock('@/hooks/useWelileSignages', () => ({
  useMySignages: () => ({ data: [], isLoading: false }),
  useSubmitSignage: () => ({ mutateAsync: mocks.submit, isPending: false }),
  useDeleteSignage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useResubmitSignage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useLoadSignageDetail: () => vi.fn(),
  useSaveSignageDraft: () => ({ mutateAsync: mocks.saveDraft, isPending: false }),
  usePostSignageInstallation: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
  it('fills every location field from GPS and prevents manual overrides where the lookup found them', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Capture Live Location' }));
    await waitFor(() => expect(screen.getByLabelText('District')).toHaveValue('Kampala'));
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith(0.35, 32.6);
    expect(screen.getByLabelText('Village / Locality')).toHaveValue('Naguru');
    for (const label of ['District', 'County', 'Sub-County', 'Parish', 'Village / Locality']) {
      expect(screen.getByLabelText(label)).toHaveAttribute('readonly');
    }
    // No street came back, so the landmark line is left for the agent to type.
    const landmark = screen.getByLabelText('Plot / Street / Immediate Landmark');
    expect(landmark).not.toHaveAttribute('readonly');
    expect(landmark).toHaveValue('');
    expect(screen.getByText('No street or landmark was found here. Type the plot, street or nearest landmark.')).toBeInTheDocument();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('lets the agent type the village and landmark when the lookup found neither', async () => {
    mocks.lookup.mockResolvedValue({ address: 'Kampala', raw: { address: { country_code: 'ug', county: 'Kampala' } } });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Capture Live Location' }));
    await waitFor(() => expect(screen.getByLabelText('District')).toHaveValue('Kampala'));
    const village = screen.getByLabelText('Village / Locality');
    expect(village).not.toHaveAttribute('readonly');
    expect(village).toHaveValue('');
    expect(screen.getByText('The address lookup could not find a village for this spot. Type it so Ops can locate the property.')).toBeInTheDocument();
    fireEvent.change(village, { target: { value: 'Kireka' } });
    expect(village).toHaveValue('Kireka');
    const landmark = screen.getByLabelText('Plot / Street / Immediate Landmark');
    expect(landmark).not.toHaveAttribute('readonly');
    fireEvent.change(landmark, { target: { value: 'Shop opposite Kireka stage' } });
    expect(landmark).toHaveValue('Shop opposite Kireka stage');
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('keeps the village and landmark read-only when the lookup returned a street', async () => {
    mocks.lookup.mockResolvedValue({ address: 'Entebbe Road, Kololo', raw: { address: { country_code: 'ug', county: 'Kampala', road: 'Entebbe Road' } } });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Capture Live Location' }));
    await waitFor(() => expect(screen.getByLabelText('District')).toHaveValue('Kampala'));
    expect(screen.getByLabelText('Plot / Street / Immediate Landmark')).toHaveValue('Entebbe Road, Kololo');
    expect(screen.getByLabelText('Plot / Street / Immediate Landmark')).toHaveAttribute('readonly');
    // A road is not a village: the line is prefilled but still editable.
    const village = screen.getByLabelText('Village / Locality');
    expect(village).toHaveValue('Entebbe Road');
    expect(village).not.toHaveAttribute('readonly');
  });
  it('clears the previous address and blocks saving when recapture cannot resolve it', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Capture Live Location' }));
    await waitFor(() => expect(screen.getByLabelText('District')).toHaveValue('Kampala'));
    mocks.lookup.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Re-capture Location' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit Signage for Ops Review' })).toBeDisabled());
    expect(screen.getByLabelText('District')).toHaveValue('');
    expect(screen.getByLabelText('Village / Locality')).toHaveValue('');
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
  it('saves an incomplete application as a draft without submitting it', async () => {
    mocks.saveDraft.mockResolvedValue('draft-1');
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Capture Live Location' }));
    await waitFor(() => expect(screen.getByLabelText('District')).toHaveValue('Kampala'));
    fireEvent.click(screen.getByRole('button', { name: 'Save as Draft' }));
    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledTimes(1));
    const arg = mocks.saveDraft.mock.calls[0][0];
    expect(arg.draftId).toBeUndefined();
    expect(arg.payload).toMatchObject({ gps_latitude: 0.35, gps_longitude: 32.6, district_name: 'Kampala' });
    expect(mocks.submit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update Draft' })).toBeInTheDocument());
  });
});
