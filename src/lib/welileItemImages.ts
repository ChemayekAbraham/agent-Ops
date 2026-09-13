/**
 * Real market photos for each Welile item, so a transfer feels like handing
 * over an actual thing. Keyed by the exact item label stored as the transfer
 * description (also matched loosely, since legacy descriptions may carry
 * extra text around the item name).
 */
import rentImg from '@/assets/items/welile-rent.jpg';
import breadImg from '@/assets/items/welile-bread.jpg';
import chapatiImg from '@/assets/items/welile-chapati.jpg';
import eggsImg from '@/assets/items/welile-eggs.jpg';
import fuelImg from '@/assets/items/welile-fuel.jpg';
import rewardImg from '@/assets/items/welile-reward.jpg';
import bodaImg from '@/assets/items/welile-boda.jpg';
import taxImg from '@/assets/items/welile-tax.jpg';

export const WELILE_ITEM_IMAGES: Record<string, string> = {
  'Welile Rent': rentImg,
  'Welile Bread': breadImg,
  'Welile Chapati': chapatiImg,
  'Welile Eggs': eggsImg,
  'Welile Fuel': fuelImg,
  'Welile Reward': rewardImg,
  'Welile Boda fees': bodaImg,
  'Welile tax': taxImg,
};

/** Photo for a transfer description, or null when it names no known item. */
export function welileItemImage(description?: string | null): string | null {
  const text = (description || '').trim().toLowerCase();
  if (!text) return null;
  const exact = Object.keys(WELILE_ITEM_IMAGES).find((k) => k.toLowerCase() === text);
  if (exact) return WELILE_ITEM_IMAGES[exact];
  const loose = Object.keys(WELILE_ITEM_IMAGES).find((k) => text.includes(k.toLowerCase()));
  return loose ? WELILE_ITEM_IMAGES[loose] : null;
}
