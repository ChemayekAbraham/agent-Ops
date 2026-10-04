import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AngelCalculator } from './AngelCalculator';

// End-to-end UI test: toggling the USD/UGX view during angel onboarding
// must keep the same underlying value — one share = UGX 20,000 = US$5.

function getAmountInput() {
  return screen.getByRole('textbox') as HTMLInputElement;
}

describe('AngelCalculator USD/UGX toggle (US$5 = UGX 20,000)', () => {
  it('always shows the locked parity statement', () => {
    render(<AngelCalculator />);
    expect(screen.getByText('1 share = UGX 20,000 = US$5')).toBeInTheDocument();
  });

  it('keeps the value at US$5 = UGX 20,000 when toggling the amount field', () => {
    render(<AngelCalculator />);

    // Enter exactly one share in UGX.
    fireEvent.change(getAmountInput(), { target: { value: '20,000' } });
    expect(getAmountInput().value).toBe('20,000');
    expect(screen.getByText('Investment Amount (UGX)')).toBeInTheDocument();

    // Switch to USD — same single share must read US$5.
    fireEvent.click(screen.getByRole('button', { name: 'USD' }));
    expect(getAmountInput().value).toBe('5');
    expect(screen.getByText('Investment Amount (USD)')).toBeInTheDocument();

    // Switch back to UGX — must return to exactly UGX 20,000.
    fireEvent.click(screen.getByRole('button', { name: 'UGX' }));
    expect(getAmountInput().value).toBe('20,000');
  });

  it('treats a US$5 entry as UGX 20,000 (one share)', () => {
    render(<AngelCalculator />);

    fireEvent.click(screen.getByRole('button', { name: 'USD' }));
    fireEvent.change(getAmountInput(), { target: { value: '5' } });
    expect(getAmountInput().value).toBe('5');

    // One share exactly.
    const sharesCell = screen.getByText('Shares').closest('div')!;
    expect(within(sharesCell).getByText('1')).toBeInTheDocument();

    // Back to UGX: the same share is UGX 20,000.
    fireEvent.click(screen.getByRole('button', { name: 'UGX' }));
    expect(getAmountInput().value).toBe('20,000');
  });

  it('mirrors the slider min label across both currencies (UGX 20K ↔ US$5)', () => {
    render(<AngelCalculator />);

    // Default UGX view: min slider label is one share in UGX.
    expect(screen.getByText('UGX 20.0K')).toBeInTheDocument();

    // USD view: the same minimum reads US$5.
    fireEvent.click(screen.getByRole('button', { name: 'USD' }));
    expect(screen.getByText('US$5')).toBeInTheDocument();
  });

  it('keeps the future-value estimate equivalent across currencies', () => {
    render(<AngelCalculator />);

    // Full pool (25,000 shares = 8% company) at $5B valuation.
    // 8% * $5B = $400M → * 4,000 UGX/US$1 = UGX 1,600B.
    fireEvent.change(getAmountInput(), { target: { value: '500,000,000' } });
    fireEvent.click(screen.getByRole('button', { name: '$5B' }));

    // UGX view.
    expect(screen.getByText('UGX 1600.0B')).toBeInTheDocument();

    // USD view — the same estimate in dollars (4,000 UGX per US$1).
    fireEvent.click(screen.getByRole('button', { name: 'USD' }));
    expect(screen.getByText('US$400.0M')).toBeInTheDocument();
  });
});