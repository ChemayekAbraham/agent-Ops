import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SignatureRentRequestCard } from './SignatureRentRequestCard';

vi.mock('@/lib/haptics', () => ({ hapticTap: vi.fn() }));

describe('SignatureRentRequestCard', () => {
  it('uses the current agent name and opens the existing request action', () => {
    const onPostRequest = vi.fn();
    render(<SignatureRentRequestCard fullName="PIUS LUBEGA" onPostRequest={onPostRequest} />);
    expect(screen.getByText('Hi, PIUS')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Post rent request' }));
    expect(onPostRequest).toHaveBeenCalledOnce();
  });

  it('explains all three milestones and labels the estimate as non-guaranteed', () => {
    render(<SignatureRentRequestCard onPostRequest={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /How do I earn/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('1%')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
    expect(screen.getByText(/not a verified maximum or a guarantee/)).toBeInTheDocument();
  });
});