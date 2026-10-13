import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DaysWithoutPaymentControl } from './DaysWithoutPaymentControl';

describe('DaysWithoutPaymentControl', () => {
  it('offers the presets and marks the chosen one', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DaysWithoutPaymentControl days={20} onChange={onChange} />);
    for (const n of [7, 14, 20, 30, 45, 60]) expect(screen.getByRole('button', { name: String(n) })).toBeTruthy();
    expect(screen.getByRole('button', { name: '20' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '30' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(screen.getByRole('button', { name: '45' }));
    expect(onChange).toHaveBeenCalledWith(45);
  });

  it('applies a custom number from 1 to 365', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DaysWithoutPaymentControl days={20} onChange={onChange} />);
    await user.type(screen.getByLabelText(/Custom number of days/), '90');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith(90);
  });

  it('refuses 0, 366 and text, with a message, and sends nothing', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DaysWithoutPaymentControl days={20} onChange={onChange} />);
    const box = screen.getByLabelText(/Custom number of days/);
    for (const bad of ['0', '366', 'abc']) {
      await user.clear(box);
      await user.type(box, bad);
      await user.click(screen.getByRole('button', { name: 'Apply' }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/whole number from 1 to 365/);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a custom number that is not a preset', () => {
    render(<DaysWithoutPaymentControl days={90} onChange={() => {}} />);
    expect((screen.getByLabelText(/Custom number of days/) as HTMLInputElement).value).toBe('90');
  });
});
