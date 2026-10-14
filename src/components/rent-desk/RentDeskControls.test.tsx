import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RentDeskControls } from './RentDeskControls';
import { PaymentLabelChip } from './PaymentLabelChip';
import { NO_RENT_DESK_FILTERS, type RentDeskFilters } from '@/lib/rentDeskFilters';

const setup = (filters: RentDeskFilters = NO_RENT_DESK_FILTERS, extra: Partial<Parameters<typeof RentDeskControls>[0]> = {}) => {
  const onFiltersChange = vi.fn();
  const onClear = vi.fn();
  render(<RentDeskControls filters={filters} onFiltersChange={onFiltersChange} onClear={onClear} {...extra} />);
  return { onFiltersChange, onClear };
};

describe('RentDeskControls', () => {
  it('offers the four paying labels and adds one to the filters when pressed', async () => {
    const { onFiltersChange } = setup();
    for (const name of ['Proven good', 'Good agent pick', 'Average', 'Watch']) {
      expect(screen.getByRole('button', { name: new RegExp(`Payer label: ${name}`) })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole('button', { name: /Payer label: Watch/ }));
    expect(onFiltersChange).toHaveBeenCalledWith({ labels: ['watch'], arrived: 'any', from: null, to: null });
  });

  it('removes a label that is pressed again', async () => {
    const { onFiltersChange } = setup({ ...NO_RENT_DESK_FILTERS, labels: ['watch', 'average'] });
    await userEvent.click(screen.getByRole('button', { name: /Payer label: Watch/ }));
    expect(onFiltersChange).toHaveBeenCalledWith({ labels: ['average'], arrived: 'any', from: null, to: null });
  });

  it('shows the custom range days only for a custom range, and reports a day when one is chosen', () => {
    const { onFiltersChange } = setup({ labels: [], arrived: 'custom', from: '2026-10-01', to: null });
    expect(screen.getByLabelText('Arrived from')).toHaveValue('2026-10-01');
    fireEvent.change(screen.getByLabelText('Arrived to'), { target: { value: '2026-10-14' } });
    expect(onFiltersChange).toHaveBeenCalledWith({ labels: [], arrived: 'custom', from: '2026-10-01', to: '2026-10-14' });
  });

  it('has no date inputs for any time, today or the last 7 days', () => {
    setup({ labels: [], arrived: '7d', from: null, to: null });
    expect(screen.queryByLabelText('Arrived from')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Arrived to')).not.toBeInTheDocument();
    expect(screen.getByText('Last 7 days')).toBeInTheDocument();
  });

  it('offers Clear filters only while something is filtered, and clears', async () => {
    const off = setup();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    expect(off.onClear).not.toHaveBeenCalled();
  });

  it('clears when asked', async () => {
    const { onClear } = setup({ labels: ['watch'], arrived: 'any', from: null, to: null });
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('shows the server\'s count, and only while filtered', () => {
    setup({ labels: ['watch'], arrived: 'any', from: null, to: null }, { matchCount: 1254, totalCount: 6514 });
    expect(screen.getByTestId('rent-desk-count')).toHaveTextContent('Showing 1,254 of 6,514');
  });

  it('shows no count with no filter', () => {
    setup(NO_RENT_DESK_FILTERS, { matchCount: 6514, totalCount: 6514 });
    expect(screen.queryByTestId('rent-desk-count')).not.toBeInTheDocument();
  });

  it('says the filters are unavailable, instead of a count, when the server call failed', () => {
    setup({ labels: ['watch'], arrived: 'any', from: null, to: null }, { matchCount: 3, totalCount: 3, error: true });
    expect(screen.getByRole('alert')).toHaveTextContent('every request is shown');
    expect(screen.queryByTestId('rent-desk-count')).not.toBeInTheDocument();
  });

  it('shows a sort selector only when it is given sort options', () => {
    setup(NO_RENT_DESK_FILTERS, { sort: 'best_payers', onSortChange: vi.fn(), sortOptions: [{ value: 'best_payers', label: 'Best payers first' }, { value: 'newest', label: 'Newest first' }] });
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Best payers first');
  });

  it('uses the Rent Plan wording rules: none of the banned words appear', () => {
    setup({ labels: ['watch'], arrived: 'custom', from: null, to: null }, { matchCount: 1, totalCount: 2 });
    expect(document.body.textContent ?? '').not.toMatch(/\b(loan|lender|roi|interest)\b/i);
  });
});

describe('PaymentLabelChip', () => {
  it('shows the label, the score and the one-line reason', () => {
    render(<PaymentLabelChip label="proven_good" score={90} reason="Paid 100% of what was owed, 6 of 6 due days on time, 1 of 1 Rent Plan completed, no 20+ day gap" />);
    expect(screen.getByTestId('payment-label-chip')).toHaveTextContent('Proven good');
    expect(screen.getByTestId('payment-label-chip')).toHaveTextContent('90');
    expect(screen.getByTestId('payment-label-reason')).toHaveTextContent('1 of 1 Rent Plan completed');
  });

  it('can hide the reason line but keeps it as the chip\'s tooltip', () => {
    render(<PaymentLabelChip label="watch" reason="Paid 3% of what was owed" showReason={false} />);
    expect(screen.queryByTestId('payment-label-reason')).not.toBeInTheDocument();
    expect(screen.getByTitle('Paid 3% of what was owed')).toHaveTextContent('Watch');
  });

  it('renders nothing until the server has given a label', () => {
    const { container } = render(<PaymentLabelChip label={null} reason="x" />);
    expect(container).toBeEmptyDOMElement();
  });
});
