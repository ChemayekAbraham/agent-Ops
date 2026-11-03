import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The sheet's share button needs a live client; the photo view under test never
// reaches it, so stub the client out.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn().mockResolvedValue({ data: null, error: null }), auth: { getUser: vi.fn() } },
}));

import { FunderPreviewHomeSheet } from '@/components/funder-preview/FunderPreviewHomeSheet';

const PHOTOS = [
  'https://example.com/room-one.jpg',
  'https://example.com/room-two.jpg',
  'https://example.com/room-three.jpg',
];

const entry = {
  category: 'empty',
  item: {
    id: 'house-1',
    listing_id: 'house-1',
    image_urls: PHOTOS,
    monthly_rent: 250000,
    request_city: 'Kampala',
    number_of_rooms: 2,
  },
} as never;

function openSheet() {
  return render(
    <FunderPreviewHomeSheet
      entry={entry}
      open
      onOpenChange={() => {}}
      picked={false}
      onTogglePick={() => {}}
      saved={false}
      onToggleSave={() => {}}
    />,
  );
}

function viewer() {
  return document.body.querySelector('[aria-label$="photo viewer"]');
}

describe('funder preview photo view', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('starts with no full-screen view open', () => {
    openSheet();
    expect(viewer()).toBeNull();
  });

  it('opens the full view on the photo that was tapped', () => {
    openSheet();
    fireEvent.click(screen.getByLabelText('View photo 2 of 3 full screen'));

    const box = viewer();
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain('2 / 3');
    expect(document.body.querySelector('[aria-live="polite"]')?.textContent).toContain('Image 2 of 3');
  });

  it('slides to the next and previous photo from inside the full view', () => {
    openSheet();
    fireEvent.click(screen.getByLabelText('View photo 2 of 3 full screen'));
    expect(viewer()?.textContent).toContain('2 / 3');

    fireEvent.click(screen.getByLabelText('Next image'));
    expect(viewer()?.textContent).toContain('3 / 3');

    fireEvent.click(screen.getByLabelText('Previous image'));
    expect(viewer()?.textContent).toContain('2 / 3');
  });

  it('closes the full view and leaves the home sheet open', async () => {
    openSheet();
    fireEvent.click(screen.getByLabelText('View photo 1 of 3 full screen'));
    expect(viewer()).not.toBeNull();

    fireEvent.click(screen.getByLabelText('Close photo viewer'));
    // The view fades out, so wait for the fade to finish before checking it is gone.
    await waitFor(() => expect(viewer()).toBeNull());
    expect(screen.getByLabelText('Back to houses')).toBeDefined();
  });
});
