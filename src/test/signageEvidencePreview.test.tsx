import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SignageEvidence } from '@/components/signages/SignageEvidence';

vi.mock('@/hooks/useWelileSignages', () => ({
  useSignageDetail: () => ({
    data: {
      photos: [
        { id: 'one', url: '/exterior.jpg', caption: 'Shop exterior', category: 'exterior' },
        { id: 'two', url: '/position.jpg', category: 'proposed_position' },
      ],
      installation_photos: [{ id: 'three', url: '/installed.jpg', category: 'installed_signage' }],
    }, isPending: false, error: null,
  }),
}));

describe('Agent Ops evidence photo inspection', () => {
  it('opens each selected original photo and closes back to the gallery', () => {
    render(<SignageEvidence signageId="signage" fullPhotoPreview />);
    for (const [label, source] of [
      ['Shop exterior', '/exterior.jpg'],
      ['proposed position', '/position.jpg'],
      ['installed signage', '/installed.jpg'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: `Open ${label} photo` }));
      const dialog = screen.getByRole('dialog', { name: 'Photographic Evidence' });
      expect(within(dialog).getByRole('img', { name: label })).toHaveAttribute('src', source);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    }
  });

  it('leaves other inspection surfaces unchanged unless opted in', () => {
    render(<SignageEvidence signageId="signage" />);
    expect(screen.queryByRole('button', { name: /Open .* photo/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(3);
  });
});