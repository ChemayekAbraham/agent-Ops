import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseAgentVetting } from '@/lib/agentVetting';

const state = vi.hoisted(() => ({ value: {} as Record<string, any> }));
vi.mock('@/hooks/useAgentVetting', () => ({ useAgentVetting: () => state.value }));
vi.mock('@/hooks/useIdentityPhotos', () => ({ identityPhotoUrl: vi.fn().mockResolvedValue(null) }));
vi.mock('@/hooks/useMyIdPhotos', () => ({ useMyIdPhotos: () => ({ data: { front: '/test-front.png', back: '/test-back.png' } }) }));
vi.mock('@/components/wallet/IdentityPhotoCapture', () => ({ default: () => null }));
vi.mock('@/components/location/UgLocationPicker', () => ({ UgLocationPicker: () => null }));
vi.mock('@/components/agent-vetting/VettingMap', () => ({ default: () => null }));
import AgentVerification from '@/pages/agent/AgentVerification';

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><AgentVerification /></MemoryRouter></QueryClientProvider>);

beforeEach(() => {
  state.value = {
    applicability: 'ready', isLoading: false, error: null, busy: null,
    vetting: parseAgentVetting({ status: 'unverified', phone: { value: '+256700000001' }, email: { value: 'agent@example.com' } }),
    sendPhoneCode: vi.fn().mockResolvedValue(undefined), sendEmailCode: vi.fn().mockResolvedValue({ challengeId: 'email-1' }),
    confirmEmailCode: vi.fn().mockResolvedValue(undefined), refresh: vi.fn(),
    submit: vi.fn().mockResolvedValue({ success: false, message: 'Finish these steps', missing: ['Confirm your email', 'Capture your location'] }),
  };
  window.scrollTo = vi.fn();
});

describe('Agent KYC navigation and existing actions', () => {
  const identityStep = () => {
    state.value.vetting.residence.district = 'Wakiso';
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  };

  it('shows the complete on-file ID and opens the existing replacement dialog', () => {
    Object.assign(state.value.vetting.national_id, { source: 'own', has_front: true, has_back: true, nin_masked: 'CM0*******QTOE', name_on_id: 'Example Agent', front_uploaded_at: '2026-10-27T10:00:00Z' });
    identityStep();
    expect(screen.getByText('Name on ID: Example Agent')).toBeInTheDocument();
    expect(screen.getByText('NIN: CM0*******QTOE')).toBeInTheDocument();
    expect(screen.queryByText('Flat surface')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add my National ID' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace ID photos' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('lets a partial ID upload missing parts without inline identifier edits', () => {
    Object.assign(state.value.vetting.national_id, { source: 'own', has_front: true, has_back: false, nin_masked: null });
    identityStep();
    expect(screen.getByText('Your National ID number is missing')).toBeInTheDocument();
    expect(screen.getAllByText('Back photo missing').length).toBeGreaterThan(0);
    expect(screen.queryByRole('textbox', { name: /NIN|Name on ID/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Upload missing photos' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('enlarges own ID photos without replacing or submitting anything', () => {
    Object.assign(state.value.vetting.national_id, { has_front: true, has_back: true, nin_masked: 'CM0*******QTOE' });
    identityStep();
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge National ID front' }));
    expect(screen.getByRole('img', { name: 'Enlarged National ID' })).toHaveAttribute('src', '/test-front.png');
    expect(state.value.submit).not.toHaveBeenCalled();
  });

  it('confirms before replacing a verified ID', () => {
    state.value.vetting.status = 'verified';
    Object.assign(state.value.vetting.national_id, { has_front: true, has_back: true, nin_masked: 'CM0*******QTOE' });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Continue' }));
    for (let i = 0; i < 2; i++) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace ID photos' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows already-filled steps instead of skipping them, then walks on with Continue', () => {
    state.value.vetting.phone.verified_at = new Date().toISOString();
    state.value.vetting.email.verified_at = new Date().toISOString();
    mount();
    // Contact is confirmed already, yet it is still shown first rather than skipped.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Contact');
    expect(screen.getByText(/Confirmed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(state.value.vetting.residence.district).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Where you stay');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Identity document');
  });

  it('flags a step that is already filled so it only needs checking', () => {
    state.value.vetting.phone.verified_at = new Date().toISOString();
    state.value.vetting.email.verified_at = new Date().toISOString();
    mount();
    expect(screen.getByText(/^Already saved/)).toBeInTheDocument();
  });

  it('says nothing about checking a step that is still empty', () => {
    mount();
    expect(screen.queryByText(/^Already saved/)).toBeNull();
  });

  it('puts live location last, just before review, so its reading is still fresh at submit', () => {
    state.value.vetting.residence.district = 'Wakiso';
    mount();
    // Opens at Contact; Contact -> Where you stay -> Identity -> Selfie -> Next of kin -> Live location
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Contact');
    for (let step = 0; step < 5; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Live location');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Review and submit');
  });

  it('reconfirms an existing email and retains its challenge when visiting other steps', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Start verification' }));
    const email = screen.getByRole('textbox', { name: 'Email address' });
    const area = email.parentElement;
    if (!area) throw new Error('Email controls missing');
    fireEvent.click(within(area).getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(state.value.sendEmailCode).toHaveBeenCalledWith('agent@example.com'));
    await screen.findByRole('textbox', { name: '6-digit code' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '6-digit code' }), { target: { value: '123456' } });
    fireEvent.click(within(area).getByRole('button', { name: /^Confirm$/ }));
    await waitFor(() => expect(state.value.confirmEmailCode).toHaveBeenCalledWith('email-1', '123456'));
  });

  const completeAll = () => {
    Object.assign(state.value.vetting.phone, { verified_at: new Date().toISOString() });
    Object.assign(state.value.vetting.email, { verified_at: new Date().toISOString() });
    Object.assign(state.value.vetting.residence, { district: 'Wakiso', village: 'Kigungu' });
    Object.assign(state.value.vetting.national_id, { ok: true, source: 'own', has_front: true, has_back: true, nin_masked: 'CM0*******QTOE' });
    Object.assign(state.value.vetting.passport_photo, { path: 'kyc/passport.png' });
    Object.assign(state.value.vetting.next_of_kin, { name: 'Kin Person', phone: '+256700000009' });
    Object.assign(state.value.vetting.gps, { lat: 0.35, lng: 32.58, accuracy_m: 20, captured_at: new Date().toISOString() });
  };

  it('keeps Submit for review disabled and names what is still needed', () => {
    completeAll();
    state.value.vetting.next_of_kin.name = null;
    mount(); // every step is shown, so walk all the way to review
    for (let step = 0; step < 6; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Review and submit');
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next of kin' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Next of kin');
  });

  it('submits once every step is filled', () => {
    completeAll();
    state.value.submit = vi.fn().mockResolvedValue({ success: true, message: 'Sent for review' });
    mount();
    for (let step = 0; step < 6; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(state.value.submit).toHaveBeenCalledTimes(1);
  });

  it('still shows the server list when it refuses a record the wizard considers complete', async () => {
    completeAll();
    mount();
    for (let step = 0; step < 6; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    const dialog = await screen.findByRole('dialog');
    expect(state.value.submit).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Capture your location' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Live location');
  });

  it('requires confirmation before opening verified editing and never submits from view-only review', () => {
    state.value.vetting.status = 'verified';
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Where you stay' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(state.value.submit).not.toHaveBeenCalled();
  });

  it('shows the taken passport photo for review before saving it', async () => {
    URL.createObjectURL = vi.fn().mockReturnValue('blob:preview');
    URL.revokeObjectURL = vi.fn();
    state.value.savePassportPhoto = vi.fn().mockResolvedValue({ status: 'ok' });
    identityStep();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Selfie / passport photo');

    const file = new File(['photo'], 'selfie.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);

    // The capture is staged, not saved: preview shown, no upload yet.
    expect(screen.getByRole('img', { name: 'New passport photo' })).toHaveAttribute('src', 'blob:preview');
    expect(state.value.savePassportPhoto).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Use this photo' }));
    await waitFor(() => expect(state.value.savePassportPhoto).toHaveBeenCalledWith(file));
  });

  it('drops the stale-location notice, leaving recapture one tap away', () => {
    Object.assign(state.value.vetting.gps, { lat: 0.35, lng: 32.58, accuracy_m: 20, captured_at: '2026-10-27T09:00:00Z' });
    mount();
    // Every step body stays mounted, so the notice would be in the DOM if it were shown.
    expect(screen.queryByText(/too old/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Capture again', hidden: true })).toBeInTheDocument();
  });

  it('still explains the location step before anything is captured', () => {
    state.value.vetting.residence.district = 'Wakiso'; // a touched record opens the wizard
    mount();
    expect(screen.getByText(/Capture my location" where you are\./)).toBeInTheDocument();
  });

  it('shows the review contact details as primary-coloured tel/mailto links', () => {
    state.value.vetting.residence.district = 'Wakiso';
    mount();
    for (let step = 0; step < 6; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const phone = screen.getByRole('link', { name: '+256700000001' });
    const email = screen.getByRole('link', { name: 'agent@example.com' });
    expect(phone).toHaveAttribute('href', 'tel:+256700000001');
    expect(email).toHaveAttribute('href', 'mailto:agent@example.com');
    expect(phone).toHaveClass('text-primary');
    expect(email).toHaveClass('text-primary');
  });
});