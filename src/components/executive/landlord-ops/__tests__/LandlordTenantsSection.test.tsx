import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fs from 'node:fs';
import path from 'node:path';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

import { LandlordTenantsSection } from '../LandlordTenantsSection';
import type { LandlordTenantRow } from '@/lib/landlordTenants';

const base: LandlordTenantRow = {
  rent_request_id: 'r1', tenant_id: 't1', tenant_name: 'Grace Nakato', tenant_phone: '0772123456', rent_amount: 300000, daily_repayment: 11000, total_repayment: 330000,
  amount_repaid: 110000, balance_left: 220000, plan_status: 'repaying', funded_at: '2026-09-01T00:00:00Z', assigned_agent_id: 'a1', assigned_agent_name: 'Joy Agent',
  assigned_agent_phone: '0701000000', registering_agent_id: 'a1', registering_agent_name: 'Joy Agent', funding_stage: 'Repaying',
};
const withRows = (rows: Partial<LandlordTenantRow>[]) => rows.map((r, i) => ({ ...base, rent_request_id: `r${i}`, tenant_id: `t${i}`, ...r }));

const renderSection = (props: Partial<React.ComponentProps<typeof LandlordTenantsSection>> = {}) => {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><LandlordTenantsSection landlordId="ll-1" {...props} /></QueryClientProvider>);
};

beforeEach(() => { rpcMock.mockReset(); });

describe('LandlordTenantsSection', () => {
  it('loads from landlord_tenant_overview for the landlord', async () => {
    rpcMock.mockResolvedValue({ data: withRows([{}]), error: null });
    renderSection();
    await screen.findByText('Grace Nakato');
    expect(rpcMock).toHaveBeenCalledWith('landlord_tenant_overview', { p_landlord_id: 'll-1' });
  });

  it('shows, for each tenant: name, phone with call buttons, rent, daily, repaid, balance, plan stage, funding badge, agent with call buttons', async () => {
    rpcMock.mockResolvedValue({ data: withRows([{ funding_stage: 'Funded – money with agent', plan_status: 'funded' }]), error: null });
    renderSection();
    const card = within(await screen.findByTestId('tenant-card'));
    expect(card.getByText('Grace Nakato')).toBeInTheDocument();
    expect(card.getByText('0772123456')).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Call Grace Nakato on 0772123456/ })).toHaveAttribute('href', 'tel:+256772123456');
    expect(card.getByRole('link', { name: 'WhatsApp Grace Nakato' })).toHaveAttribute('href', expect.stringContaining('https://wa.me/256772123456'));
    for (const t of ['UGX 300,000', 'UGX 11,000', 'UGX 110,000', 'UGX 220,000']) expect(card.getByText(t)).toBeInTheDocument();
    for (const label of ['Rent', 'Daily', 'Repaid so far', 'Balance left']) expect(card.getByText(label)).toBeInTheDocument();
    expect(card.getByText('Funded')).toBeInTheDocument(); // plan stage
    expect(card.getByText('Funded – money with agent')).toBeInTheDocument(); // funding stage badge
    expect(card.getByText('Joy Agent')).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Call Joy Agent on 0701000000/ })).toHaveAttribute('href', 'tel:+256701000000');
  });

  it('shows the total line: tenants, total rent and total balance, in UGX', async () => {
    rpcMock.mockResolvedValue({ data: withRows([{ rent_amount: 300000, balance_left: 220000 }, { rent_amount: 1200000, balance_left: 800000 }]), error: null });
    renderSection();
    const total = await screen.findByTestId('tenants-total');
    expect(total).toHaveTextContent('2 tenants');
    expect(total).toHaveTextContent('Total rent UGX 1,500,000');
    expect(total).toHaveTextContent('Total balance UGX 1,020,000');
  });

  it('lists rejected plans but does not count them, and says so', async () => {
    rpcMock.mockResolvedValue({ data: withRows([{}, { funding_stage: 'Rejected/Cancelled', rent_amount: 500000, balance_left: 0, plan_status: 'rejected' }]), error: null });
    renderSection();
    const total = await screen.findByTestId('tenants-total');
    expect(total).toHaveTextContent('1 tenant');
    expect(total).toHaveTextContent('Total rent UGX 300,000');
    expect(total).toHaveTextContent('1 rejected or cancelled Rent Plan is listed below but not counted.');
    expect(screen.getAllByTestId('tenant-card')).toHaveLength(2);
  });

  it('shows an empty message when there are no tenants', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    renderSection();
    expect(await screen.findByText('This landlord has no tenants on a Rent Plan yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('tenants-total')).not.toBeInTheDocument();
  });

  it('shows a clear error when loading fails, and Try again loads it', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load this landlord's tenants.");
    rpcMock.mockResolvedValueOnce({ data: withRows([{}]), error: null });
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Grace Nakato')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('tells a person without access why, instead of showing an empty list', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'NOT_AUTHORISED: only Landlord Ops' } });
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent("You don't have access to this landlord's tenants.");
  });

  it('shows a loading state first', async () => {
    rpcMock.mockReturnValue(new Promise(() => {}));
    renderSection();
    expect(screen.getByRole('status')).toHaveTextContent('Loading tenants');
  });

  it('copes with a tenant who has no phone and a plan with no agent', async () => {
    rpcMock.mockResolvedValue({ data: withRows([{ tenant_phone: null, assigned_agent_name: null, assigned_agent_phone: null }]), error: null });
    renderSection();
    expect(await screen.findByText('No phone on file')).toBeInTheDocument();
    expect(screen.getByText('No agent on this Rent Plan')).toBeInTheDocument();
  });

  it('lists a long landlord 25 at a time, with the totals over all of them', async () => {
    rpcMock.mockResolvedValue({ data: withRows(Array.from({ length: 60 }, () => ({ rent_amount: 100000, balance_left: 10000 }))), error: null });
    renderSection();
    await screen.findByTestId('tenants-total');
    expect(screen.getByTestId('tenants-total')).toHaveTextContent('60 tenants');
    expect(screen.getByTestId('tenants-total')).toHaveTextContent('Total rent UGX 6,000,000');
    expect(screen.getAllByTestId('tenant-card')).toHaveLength(25);
    await userEvent.click(screen.getByRole('button', { name: /Show more \(35 more\)/ }));
    expect(screen.getAllByTestId('tenant-card')).toHaveLength(50);
    await userEvent.click(screen.getByRole('button', { name: /Show more \(10 more\)/ }));
    expect(screen.getAllByTestId('tenant-card')).toHaveLength(60);
    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });

  it('does not call the server until it is enabled, or without a landlord', async () => {
    renderSection({ enabled: false });
    renderSection({ landlordId: null });
    await new Promise((r) => setTimeout(r, 30));
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('uses the regulatory wording and none of the banned words', async () => {
    rpcMock.mockResolvedValue({ data: withRows([{}]), error: null });
    renderSection();
    await screen.findByText('Grace Nakato');
    expect(document.body.textContent).not.toMatch(/\b(loan|lender|interest|ROI)\b/i);
  });
});

describe('where the section is wired in', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../../../', rel), 'utf8');
  it('is in the Review panel of the Landlords list and in the Edit Landlord dialog, and the existing actions are still there', () => {
    const dashboard = read('components/executive/LandlordOpsDashboard.tsx');
    expect(dashboard).toContain('<LandlordTenantsSection landlordId={landlord.id} />');
    for (const kept of ['approveLabel="Review & Approve"', 'rejectLabel="Reject"', 'onApprove={(note) => handleApproveLandlord(landlord, note)}', 'onReject={(note) => handleRejectLandlord(landlord, note)}', 'onClick={() => setEditLandlord({ ...landlord })}']) {
      expect(dashboard).toContain(kept);
    }
    const dialog = read('components/executive/landlord-ops/EditLandlordDialog.tsx');
    expect(dialog).toContain('<LandlordTenantsSection landlordId={landlord?.id} enabled={open}');
    // below the Save button, so the form and Save stay where they were
    expect(dialog.indexOf('Save Changes')).toBeLessThan(dialog.indexOf('<LandlordTenantsSection'));
    expect(dialog).toContain('Save Changes');
  });
});
