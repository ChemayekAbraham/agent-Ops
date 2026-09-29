import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemSwipePicker } from '../ItemSwipePicker';

const items = [
  { label: 'Welile Rent', hint: 'Rent payment' },
  { label: 'Welile Gift', hint: 'Gift' },
  { label: 'Welile Chapati', hint: 'Chapati' },
] as const;

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
});

describe('ItemSwipePicker accessibility', () => {
  it('labels the dialog, current item, images, and controls for screen readers', async () => {
    render(<ItemSwipePicker open items={items} onPick={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Choose what you are sending' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('img', { name: 'Rent payment item' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose Rent payment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next item: Gift' })).toBeInTheDocument();
    expect(screen.getByText('Rent payment. Item 1 of 3.')).toHaveAttribute('aria-live', 'polite');
  });

  it('supports arrow, Home, End, and Escape keys', async () => {
    const onClose = vi.fn();
    render(<ItemSwipePicker open items={items} onPick={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Choose what you are sending' });

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByText('Gift. Item 2 of 3.')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'End' });
    expect(screen.getByText('Chapati. Item 3 of 3.')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Home' });
    expect(screen.getByText('Rent payment. Item 1 of 3.')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps keyboard focus inside the full-screen picker', async () => {
    const user = userEvent.setup();
    render(<ItemSwipePicker open items={items} onPick={vi.fn()} onClose={vi.fn()} />);

    const close = screen.getByRole('button', { name: 'Close item picker' });
    const choose = screen.getByRole('button', { name: 'Choose Rent payment' });
    close.focus();
    await user.tab({ shift: true });
    expect(choose).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it('uses instant scrolling when reduced motion is requested', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    render(<ItemSwipePicker open items={items} onPick={vi.fn()} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Next item: Gift' }));
    expect(Element.prototype.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'instant' }));
  });
});