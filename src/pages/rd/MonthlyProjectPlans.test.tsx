import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MonthlyProjectPlans from './MonthlyProjectPlans';
import { monthlyPlansKey, readMonthlyPlans } from './monthlyProjectPlans';

beforeEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
describe('Recording monthly plans', () => {
  const props = { userId: 'rd-user', projects: [{ id: 'car', name: 'Welile Car' }] };
  it('saves a budget and targets and restores them after reopening', () => {
    const { unmount } = render(<MonthlyProjectPlans {...props} />);
    fireEvent.change(screen.getByLabelText('Planning month'), { target: { value: '2026-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record monthly plan for Welile Car' }));
    fireEvent.change(screen.getByLabelText('Budget (UGX)'), { target: { value: '3000000' } });
    fireEvent.change(screen.getByLabelText('Targets'), { target: { value: 'Register 12 customers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
    expect(readMonthlyPlans(localStorage.getItem(monthlyPlansKey(props.userId)))[0]).toMatchObject({ month: '2026-11', budget: 3000000, targets: 'Register 12 customers' });
    unmount();
    render(<MonthlyProjectPlans {...props} />);
    fireEvent.change(screen.getByLabelText('Planning month'), { target: { value: '2026-11' } });
    expect(screen.getByText('Register 12 customers')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Planning month'), { target: { value: '2026-12' } });
    expect(screen.queryByText('Register 12 customers')).not.toBeInTheDocument();
  });
  it('does not report success when storage fails', () => {
    render(<MonthlyProjectPlans {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record monthly plan for Welile Car' }));
    fireEvent.change(screen.getByLabelText('Budget (UGX)'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Targets'), { target: { value: 'Complete curriculum' } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
    expect(screen.getByRole('button', { name: 'Save plan' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});