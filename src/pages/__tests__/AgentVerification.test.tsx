import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseAgentVetting } from '@/lib/agentVetting';

const state = vi.hoisted(() => ({ value: {} as Record<string, any> }));
vi.mock('@/hooks/useAgentVetting', () => ({ useAgentVetting: () => state.value }));
vi.mock('@/hooks/useIdentityPhotos', () => ({ identityPhotoUrl: vi.fn().mockResolvedValue(null) }));
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
  it('resumes the first unfinished checklist group rather than marking skipped steps complete', () => {
    state.value.vetting.phone.verified_at = new Date().toISOString();
    state.value.vetting.email.verified_at = new Date().toISOString();
    mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Where you stay');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(state.value.vetting.residence.district).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Identity document');
  });

  it('puts live location last, just before review, so its reading is still fresh at submit', () => {
    state.value.vetting.residence.district = 'Wakiso';
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Step 6: Live location' }));
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

  it('uses existing submit and opens missing requirements immediately with step navigation', async () => {
    state.value.vetting.residence.district = 'Wakiso';
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Step 7: Review and submit' }));
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
});