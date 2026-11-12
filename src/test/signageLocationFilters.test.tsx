import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WelileSignagesOps } from '@/components/executive/agent-ops-v2/WelileSignagesOps';

Object.assign(HTMLElement.prototype, {
  hasPointerCapture: () => false,
  setPointerCapture: () => {},
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

vi.mock('@/hooks/useUgLocations', async importOriginal => ({
  ...await importOriginal<typeof import('@/hooks/useUgLocations')>(),
  useUgDistricts: () => ({ data: [{ id: 1, name: 'Kampala', region: 'Central' }, { id: 2, name: 'Gulu', region: 'Northern' }] }),
}));
vi.mock('@/hooks/useWelileSignages', () => ({
  useReviewSignage: () => ({ isPending: false }),
  useSignageOpsQueue: () => ({ data: [
    { id: 'one', property_name: 'Central shop', district_name: 'Kampala', county_name: 'Kyadondo', sub_county_name: 'Kawempe', parish_name: 'Bwaise', village_name: 'Kazo' },
    { id: 'two', property_name: 'Northern shop', district_name: 'Gulu', village_name: 'Layibi' },
  ].map(row => ({ ...row, reference_no: row.id, owner_phone: '0700000000', owner_full_name: 'Owner', owner_payment_method: 'bank', property_type: 'shop', status: 'pending', gps_accuracy_meters: 10 })), refetch: vi.fn() }),
}));

describe('Agent Ops signage location filtering', () => {
  it.each(['Central', 'Kampala', 'Kyadondo', 'Kawempe', 'Bwaise', 'Kazo'])('matches %s in the location hierarchy', location => {
    render(<WelileSignagesOps onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search property/), { target: { value: ` ${location.toUpperCase()} ` } });
    expect(screen.getByText('Central shop')).toBeInTheDocument();
    expect(screen.queryByText('Northern shop')).not.toBeInTheDocument();
  });

  it('combines the region selection with location search and restores all regions', async () => {
    render(<WelileSignagesOps onBack={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Region' }));
    await userEvent.click(screen.getByRole('option', { name: 'Northern' }));
    expect(screen.getByText('Northern shop')).toBeInTheDocument();
    expect(screen.queryByText('Central shop')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Search property/), { target: { value: 'Bwaise' } });
    expect(screen.queryByText('Central shop')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Region' }));
    await userEvent.click(screen.getByRole('option', { name: 'All regions' }));
    expect(screen.getByText('Central shop')).toBeInTheDocument();
  });
});