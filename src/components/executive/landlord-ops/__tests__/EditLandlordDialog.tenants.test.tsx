import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();
const landlordRow = { id: 'll-1', name: 'Mr Okello', phone: '0772000111', mobile_money_name: '', mobile_money_number: '', bank_name: '', account_number: '', monthly_rent: 300000,
  has_smartphone: false, number_of_houses: 2, caretaker_name: '', caretaker_phone: '', tin: '', electricity_meter_number: '', water_meter_number: '', village: 'Kisaasi', district: 'Kampala', region: 'Central', property_address: 'Plot 4' };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpcMock(...a),
    from: () => { const c: any = { select: () => c, eq: () => c, single: () => Promise.resolve({ data: landlordRow, error: null }) }; return c; },
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'ops-1' } }) }));
vi.mock('@/components/landlord/agreement/LandlordAgreementUploader', () => ({ LandlordAgreementUploader: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { EditLandlordDialog } from '../EditLandlordDialog';

const tenant = (over: Record<string, unknown> = {}) => ({
  rent_request_id: 'r1', tenant_id: 't1', tenant_name: 'Grace Nakato', tenant_phone: '0772123456', rent_amount: 300000, daily_repayment: 11000, total_repayment: 330000,
  amount_repaid: 110000, balance_left: 220000, plan_status: 'repaying', funded_at: null, assigned_agent_id: 'a1', assigned_agent_name: 'Joy Agent', assigned_agent_phone: '0701000000',
  registering_agent_id: 'a1', registering_agent_name: 'Joy Agent', funding_stage: 'Repaying', ...over,
});

const renderDialog = (open = true) => render(
  <QueryClientProvider client={new QueryClient()}>
    <EditLandlordDialog landlord={{ id: 'll-1', name: 'Mr Okello', phone: '0772000111' }} open={open} onClose={vi.fn()} onSaved={vi.fn()} />
  </QueryClientProvider>,
);

beforeEach(() => { rpcMock.mockReset(); });

describe('Edit Landlord dialog: Tenants section', () => {
  it('shows the landlord\'s tenants under the form, loaded from landlord_tenant_overview', async () => {
    rpcMock.mockResolvedValue({ data: [tenant(), tenant({ rent_request_id: 'r2', tenant_id: 't2', tenant_name: 'Peter Ssemwogerere', funding_stage: 'In review', plan_status: 'service_center_review', balance_left: 330000 })], error: null });
    renderDialog();
    const dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByText('Grace Nakato')).toBeInTheDocument();
    expect(dialog.getByText('Peter Ssemwogerere')).toBeInTheDocument();
    expect(dialog.getByText('In review')).toBeInTheDocument();
    expect(dialog.getByTestId('tenants-total')).toHaveTextContent('2 tenants');
    expect(rpcMock).toHaveBeenCalledWith('landlord_tenant_overview', { p_landlord_id: 'll-1' });
  });

  it('shows the empty message and the error message inside the dialog', async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });
    const first = renderDialog();
    expect(await screen.findByText('This landlord has no tenants on a Rent Plan yet.')).toBeInTheDocument();
    first.unmount();
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load this landlord's tenants.");
  });

  it('leaves the existing form and the Save flow exactly as they were: the fields are filled and Save still asks for confirmation', async () => {
    rpcMock.mockResolvedValue({ data: [tenant()], error: null });
    renderDialog();
    await screen.findByText('Grace Nakato');
    expect(screen.getByDisplayValue('Mr Okello')).toBeInTheDocument();
    expect(screen.getByDisplayValue('0772000111')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    expect(await screen.findByText('Confirm Changes')).toBeInTheDocument();
  });

  it('does not load tenants while the dialog is closed', async () => {
    rpcMock.mockResolvedValue({ data: [tenant()], error: null });
    renderDialog(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
