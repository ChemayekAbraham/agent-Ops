import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';

function planItem(withGps: boolean) {
  return {
    rent_request_id: 'plan-1',
    house_category: 'Single Room',
    funding_amount: 700000,
    landlord_name: 'Test Landlord',
    tenant_full_name: 'Test Tenant',
    ...(withGps ? { request_latitude: 0.1087905, request_longitude: 32.5157895 } : {}),
  } as unknown as Parameters<typeof FunderNewHouseCard>[0]['item'];
}

const baseProps = {
  category: 'ready' as const,
  saved: false,
  selected: false,
  distance: null,
  onSave: vi.fn(),
  onSelect: vi.fn(),
  onDetail: vi.fn(),
};

describe('house card GPS map button', () => {
  it('opens Google Maps with the plan coordinates', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<FunderNewHouseCard item={planItem(true)} {...baseProps} />);
    const button = screen.getByRole('button', { name: /Open Google Maps location for/i });
    await userEvent.click(button);
    expect(openSpy).toHaveBeenCalledTimes(1);
    const url = String(openSpy.mock.calls[0][0]);
    expect(url).toContain('https://www.google.com/maps/');
    expect(url).toContain('0.1087905');
    expect(url).toContain('32.5157895');
    expect(baseProps.onSelect).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('shows no map button when the plan has no GPS', () => {
    render(<FunderNewHouseCard item={planItem(false)} {...baseProps} />);
    expect(screen.queryByRole('button', { name: /Open Google Maps location for/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Fund this House/i })).toBeTruthy();
  });
});
