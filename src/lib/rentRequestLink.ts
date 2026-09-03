import { getPublicOrigin } from './getPublicOrigin';
import { createShortLink } from './createShortLink';

/**
 * Deep-link helpers for the agent "Post Rent Request" form.
 *
 * The agent dashboard (`/dashboard/agent`) already listens for the
 * `action=rent-request` query param and opens the rent-request dialog on arrival.
 * These helpers produce either a long URL or a persisted short link.
 */

export const RENT_REQUEST_TARGET_PATH = '/dashboard/agent';

export const RENT_REQUEST_TARGET_PARAMS: Record<string, string> = {
  action: 'rent-request',
};

/** Returns a full deep link such as https://welileapp.com/dashboard/agent?action=rent-request */
export function buildRentRequestLongLink(): string {
  const url = new URL(RENT_REQUEST_TARGET_PATH, getPublicOrigin());
  for (const [key, value] of Object.entries(RENT_REQUEST_TARGET_PARAMS)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Creates a short link (e.g. https://welileapp.com/r/X7kM2p) that opens the
 * Post Rent Request form. Requires a user id to scope the short_links row.
 */
export async function createRentRequestShortLink(userId: string): Promise<string> {
  return createShortLink(userId, RENT_REQUEST_TARGET_PATH, RENT_REQUEST_TARGET_PARAMS);
}
