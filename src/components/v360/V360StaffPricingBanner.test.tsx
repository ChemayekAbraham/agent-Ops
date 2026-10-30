import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { V360StaffPricingBanner } from './V360StaffPricingBanner';

const authState = vi.hoisted(() => ({
  enabledRoles: [] as string[],
  rolesResolved: true,
}));

const settingsRow = vi.hoisted(() => ({
  data: { new_plans_enabled: false, updated_at: null as string | null, updated_by: null as string | null },
  error: null as { message: string } | null,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => settingsRow,
        }),
      }),
    }),
    rpc: async () => ({ data: null, error: null }),
  },
}));

function renderBanner() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <V360StaffPricingBanner />
    </QueryClientProvider>,
  );
}

describe('V360StaffPricingBanner', () => {
  it('hides the banner from tenants, agents, landlords and partners', () => {
    for (const role of ['tenant', 'agent', 'landlord', 'supporter']) {
      authState.enabledRoles = [role];
      authState.rolesResolved = true;
      const { unmount } = renderBanner();
      expect(screen.queryByTestId('v360-staff-pricing-banner')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('stays hidden until roles are resolved', () => {
    authState.enabledRoles = ['ceo'];
    authState.rolesResolved = false;
    renderBanner();
    expect(screen.queryByTestId('v360-staff-pricing-banner')).not.toBeInTheDocument();
  });

  it('shows the OFF status to the CEO and directors without the switch', async () => {
    settingsRow.data = { new_plans_enabled: false, updated_at: null, updated_by: null };
    settingsRow.error = null;
    for (const role of ['ceo', 'manager']) {
      authState.enabledRoles = [role];
      authState.rolesResolved = true;
      const { unmount } = renderBanner();
      expect(await screen.findByTestId('v360-staff-pricing-banner')).toBeInTheDocument();
      expect(await screen.findByText('OFF')).toBeInTheDocument();
      expect(screen.getByText(/OFF = new Rent Plans use current pricing/)).toBeInTheDocument();
      expect(screen.getByText(/CFO, COO and super admin control this switch/)).toBeInTheDocument();
      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
      expect(screen.getByTestId('v360-staff-pricing-banner')).toHaveAttribute('data-can-change', 'no');
      unmount();
    }
  });

  it('gives cfo, coo and super admin the confirm switch inside the same banner', async () => {
    settingsRow.data = { new_plans_enabled: false, updated_at: null, updated_by: null };
    for (const role of ['cfo', 'coo', 'super_admin']) {
      authState.enabledRoles = [role];
      authState.rolesResolved = true;
      const { unmount } = renderBanner();
      expect(await screen.findByTestId('v360-staff-pricing-banner')).toHaveAttribute('data-can-change', 'yes');
      expect(await screen.findByText('OFF')).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: '360-day pricing for new Rent Plans' })).toBeInTheDocument();
      unmount();
    }
  });

  it('does not give an agent who also holds a non-toggle staff role the switch', async () => {
    authState.enabledRoles = ['agent', 'manager'];
    authState.rolesResolved = true;
    renderBanner();
    expect(await screen.findByTestId('v360-staff-pricing-banner')).toHaveAttribute('data-can-change', 'no');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});
