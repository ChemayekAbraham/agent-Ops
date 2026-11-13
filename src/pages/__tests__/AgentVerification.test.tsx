import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseAgentVetting } from '@/lib/agentVetting';

const state = vi.hoisted(() => ({ value: {} as Record<string, any> }));
vi.mock('@/hooks/useAgentVetting', () => ({ useAgentVetting: () => state.value }));
const v2 = vi.hoisted(() => ({ value: {} as Record<string, any> }));
vi.mock('@/hooks/useAgentVettingV2', () => ({ useAgentVettingV2: () => v2.value }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
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
  // v2 defaults: nothing else missing, so the LC1 step counts as done.
  v2.value = { missing: [], missingFailed: false, gate: null, saveHomeLc1: vi.fn().mockResolvedValue({}), savingHomeLc1: false, homeLc1Saved: false };
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

  const parentStep = (link: Record<string, unknown>) => {
    state.value.vetting = parseAgentVetting({ status: 'unverified', phone: { value: '+256700000001' }, email: { value: 'agent@example.com' },
      residence: { district: 'Wakiso', village: 'Kira' }, national_id: { source: 'parent' },
      parent_agent: { id: 'parent-1', name: 'Parent Agent', phone: '+256700000002' } });
    state.value.parentIdLink = { found: true, has_parent: true, request_id: 'req-1', ...link };
    state.value.requestParentIdLink = vi.fn().mockResolvedValue({ success: true });
    state.value.confirmParentIdCode = vi.fn();
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  };

  it('sends the code for an open parent-ID request that never had one sent', () => {
    parentStep({ status: 'awaiting_owner', code_sent_at: null, code_verified_at: null });
    expect(screen.queryByRole('textbox', { name: '6-digit code' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask Parent Agent' }));
    expect(state.value.requestParentIdLink).toHaveBeenCalledTimes(1);
  });

  it('asks for the parent code once sent, and can send it again', () => {
    parentStep({ status: 'awaiting_owner', code_sent_at: '2026-11-04T08:00:00Z', code_verified_at: null });
    expect(screen.getByRole('textbox', { name: '6-digit code' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send the code again' }));
    expect(state.value.requestParentIdLink).toHaveBeenCalledTimes(1);
  });

  it('waits for the parent to approve once the code is confirmed', () => {
    parentStep({ status: 'awaiting_owner', code_sent_at: '2026-11-04T08:00:00Z', code_verified_at: '2026-11-04T08:01:00Z' });
    expect(screen.getByText('Waiting for Parent Agent to approve in their app.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '6-digit code' })).toBeNull();
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
    v2.value.missing = [{ text: 'LC1 letter for your home', kind: 'home_lc1', step: 'home_lc1', href: null }];
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
    // Opens at Contact; Contact -> Where you stay -> Identity -> Selfie -> Next of kin -> LC1 letter -> Live location
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Contact');
    for (let step = 0; step < 6; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
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
    for (let step = 0; step < 7; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Review and submit');
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next of kin' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Next of kin');
  });

  it('lists what is still needed below the live location card on review', () => {
    completeAll();
    state.value.vetting.next_of_kin.name = null;
    mount();
    for (let step = 0; step < 7; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Review and submit');
    const locationCard = screen.getByRole('heading', { level: 2, name: 'Live location' });
    const stillNeeded = screen.getByText('Still needed before you can submit');
    expect(locationCard.compareDocumentPosition(stillNeeded) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });


  it('submits once every step is filled', () => {
    completeAll();
    state.value.submit = vi.fn().mockResolvedValue({ success: true, message: 'Sent for review' });
    mount();
    for (let step = 0; step < 7; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(state.value.submit).toHaveBeenCalledTimes(1);
  });

  it('still shows the server list when it refuses a record the wizard considers complete', async () => {
    completeAll();
    mount();
    for (let step = 0; step < 7; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
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
    for (let step = 0; step < 7; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const phone = screen.getByRole('link', { name: '+256700000001' });
    const email = screen.getByRole('link', { name: 'agent@example.com' });
    expect(phone).toHaveAttribute('href', 'tel:+256700000001');
    expect(email).toHaveAttribute('href', 'mailto:agent@example.com');
    expect(phone).toHaveClass('text-primary');
    expect(email).toHaveClass('text-primary');
  });
});

describe('Agent verification v2 (E78)', () => {
  const lc1Step = () => {
    state.value.vetting.residence.district = 'Wakiso';
    mount();
    for (let step = 0; step < 5; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('LC1 letter for your home');
  };

  it('asks for the home LC1 letter, previews it, then saves it', async () => {
    URL.createObjectURL = vi.fn().mockReturnValue('blob:lc1');
    URL.revokeObjectURL = vi.fn();
    v2.value.missing = [{ text: 'LC1 letter for your home', kind: 'home_lc1', step: 'home_lc1', href: null }];
    lc1Step();
    expect(screen.getByText('Step 6 of 8')).toBeInTheDocument();
    const file = new File(['letter'], 'lc1.jpg', { type: 'image/jpeg' });
    const input = screen.getByLabelText('LC1 letter photo') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);
    expect(screen.getByRole('img', { name: 'New LC1 letter' })).toHaveAttribute('src', 'blob:lc1');
    expect(v2.value.saveHomeLc1).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use this photo' }));
    await waitFor(() => expect(v2.value.saveHomeLc1).toHaveBeenCalledWith(file));
  });

  it('shows the server error from saving the LC1 letter as it is', async () => {
    URL.createObjectURL = vi.fn().mockReturnValue('blob:lc1');
    URL.revokeObjectURL = vi.fn();
    v2.value.missing = [{ text: 'LC1 letter for your home', kind: 'home_lc1', step: 'home_lc1', href: null }];
    v2.value.saveHomeLc1 = vi.fn().mockRejectedValue(new Error('LC1_INVALID: path must start with your user id'));
    lc1Step();
    const input = screen.getByLabelText('LC1 letter photo') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'lc1.jpg', { type: 'image/jpeg' })] });
    fireEvent.change(input);
    fireEvent.click(screen.getByRole('button', { name: 'Use this photo' }));
    expect(await screen.findByText('LC1_INVALID: path must start with your user id')).toBeInTheDocument();
  });

  it('keeps Submit disabled while the server still lists the LC1 letter', () => {
    Object.assign(state.value.vetting.phone, { verified_at: new Date().toISOString() });
    Object.assign(state.value.vetting.email, { verified_at: new Date().toISOString() });
    Object.assign(state.value.vetting.residence, { district: 'Wakiso', village: 'Kigungu' });
    Object.assign(state.value.vetting.national_id, { ok: true, source: 'own', has_front: true, has_back: true });
    Object.assign(state.value.vetting.passport_photo, { path: 'kyc/passport.png' });
    Object.assign(state.value.vetting.next_of_kin, { name: 'Kin Person', phone: '+256700000009' });
    Object.assign(state.value.vetting.gps, { lat: 0.35, lng: 32.58, accuracy_m: 20, captured_at: new Date().toISOString() });
    v2.value.missing = [{ text: 'LC1 letter for your home', kind: 'home_lc1', step: 'home_lc1', href: null }];
    mount();
    for (let step = 0; step < 7; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'LC1 letter for your home' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('LC1 letter for your home');
  });

  it('lists what is missing with links to the agent agreement and the mobile money settings', () => {
    state.value.vetting.status = 'verified';
    v2.value.missing = [
      { text: 'Signed agent agreement', kind: 'agreement', step: null, href: '/agent-agreement' },
      { text: 'Mobile money in your own name', kind: 'mobile_money', step: null, href: '/settings?section=account&tab=withdrawal' },
      { text: 'LC1 letter for your home', kind: 'home_lc1', step: 'home_lc1', href: null },
    ];
    mount();
    expect(screen.getByText('Still missing for your verification')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Signed agent agreement' })).toHaveAttribute('href', '/agent-agreement');
    expect(screen.getByRole('link', { name: 'Mobile money in your own name' })).toHaveAttribute('href', '/settings?section=account&tab=withdrawal');
    // A verified agent confirms before the LC1 step opens for editing.
    fireEvent.click(screen.getByRole('button', { name: 'LC1 letter for your home' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('LC1 letter for your home');
  });

  it('shows "Verified until" from the gate status', () => {
    state.value.vetting.status = 'verified';
    v2.value.gate = { enforced: true, status: 'verified', blocked: false, reason: null, expires_at: '2027-11-11T09:00:00Z' };
    mount();
    expect(screen.getByText('Verified until 11 Nov 2027')).toBeInTheDocument();
  });

  it('shows the re-verify message as it is when the verification has expired', () => {
    state.value.vetting.status = 'verified';
    const reason = 'Your verification expired on 1 Nov 2026. Upload your LC1 letter and confirm your details to verify again.';
    v2.value.gate = { enforced: true, status: 'expired', blocked: true, reason, expires_at: '2026-11-01T00:00:00Z' };
    mount();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByText(/^Verified until/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Verify again/ }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Contact');
    expect(screen.getByText(reason)).toBeInTheDocument();
  });
});
