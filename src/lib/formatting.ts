/**
 * Format a raw snake/kebab-cased label for display.
 * Replaces underscores/hyphens with spaces and title-cases the result.
 */
export const prettyName = (raw?: string | null): string =>
  (raw ?? '')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Rental home';

const HOUSE_LIKE_CATEGORIES = new Set([
  'single_room',
  'double_room',
  'one_bedroom',
  'two_bedroom',
  'three_bedroom',
  'bedsitter',
  'studio',
]);

/**
 * Format a raw house_category value for display.
 * Residential room-type categories get "House" appended (e.g. "Single Room House");
 * commercial categories are left as title-cased labels.
 */
export const formatHouseCategory = (raw?: string | null): string => {
  const base = prettyName(raw);
  if (!raw) return base;
  const normalized = raw.trim().toLowerCase();
  return HOUSE_LIKE_CATEGORIES.has(normalized) ? `${base} House` : base;
};
