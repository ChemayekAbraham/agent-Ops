/**
 * E72b funders board tags: names, order and colours. No backend client here,
 * so cards and pure helpers can use them without loading Supabase.
 */

/** The server's tags. Empty houses (house_listings) are never in funders_board_items: they are 'empty_house'. */
export type BoardTag = 'verified' | 'booked' | 'funded' | 'pending_verification' | 'empty_house';
export type BoardRequestTag = Exclude<BoardTag, 'empty_house'>;

/** FB-ORDER: Verified, Booked, Funded, Pending verification, then Empty houses. */
export const BOARD_TAG_ORDER: Record<BoardTag, number> = {
  verified: 1,
  booked: 2,
  funded: 3,
  pending_verification: 4,
  empty_house: 5,
};
export const BOARD_GROUPS: BoardTag[] = ['verified', 'booked', 'funded', 'pending_verification', 'empty_house'];

/** The server's colours for each tag (funders_board_items.tags). */
export const BOARD_TAG_COLOR: Record<BoardTag, string> = {
  verified: '#16A34A',
  booked: '#2563EB',
  funded: '#6900CC',
  pending_verification: '#D97706',
  empty_house: '#6B7280',
};

export const BOARD_TAG_LABEL: Record<BoardTag, string> = {
  verified: 'Verified',
  booked: 'Booked',
  funded: 'Funded',
  pending_verification: 'Pending verification',
  empty_house: 'Empty house',
};
