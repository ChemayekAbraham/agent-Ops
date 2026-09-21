/**
 * Format a raw snake/kebab-cased label for display.
 * Replaces underscores/hyphens with spaces and title-cases the result.
 */
export const prettyName = (raw?: string | null): string =>
  (raw ?? '')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Rental home';
