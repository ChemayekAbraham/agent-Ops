/**
 * Helpers for agent-posted house walkthrough videos.
 *
 * Videos are NOT stored in our database or storage — agents paste a link to an
 * externally hosted clip (YouTube or Google Drive). We only keep the URL string
 * in `house_listings.video_url`. This keeps the database lean at 40M+ scale while
 * still letting tenants watch a short (≤30s) walkthrough on the listing page.
 *
 * `parseHouseVideo` validates the pasted link, returns an embeddable URL, and a
 * canonical storage URL. Unsupported links return null.
 */

export type HouseVideoProvider = 'youtube' | 'google_drive';

export interface ParsedHouseVideo {
  provider: HouseVideoProvider;
  /** URL safe to drop into an <iframe src>. */
  embedUrl: string;
  /** Normalized canonical URL stored in the database (e.g. youtu.be/{id} or drive.google.com/file/d/{id}/view). */
  canonicalUrl: string;
}

function parseYouTube(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');
  // youtu.be/<id>
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id || null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    // watch?v=<id>
    const v = url.searchParams.get('v');
    if (v) return v;
    // /shorts/<id> or /embed/<id>
    const parts = url.pathname.split('/').filter(Boolean);
    if ((parts[0] === 'shorts' || parts[0] === 'embed') && parts[1]) return parts[1];
  }
  return null;
}

function parseDriveId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'drive.google.com') return null;
  // /file/d/<id>/view
  const parts = url.pathname.split('/').filter(Boolean);
  const dIdx = parts.indexOf('d');
  if (dIdx >= 0 && parts[dIdx + 1]) return parts[dIdx + 1];
  // open?id=<id>
  const id = url.searchParams.get('id');
  return id || null;
}

export function parseHouseVideo(raw: string | null | undefined): ParsedHouseVideo | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const ytId = parseYouTube(url);
  if (ytId) {
    return {
      provider: 'youtube',
      embedUrl: `https://www.youtube-nocookie.com/embed/${ytId}`,
      canonicalUrl: `https://youtu.be/${ytId}`,
    };
  }

  const driveId = parseDriveId(url);
  if (driveId) {
    return {
      provider: 'google_drive',
      embedUrl: `https://drive.google.com/file/d/${driveId}/preview`,
      canonicalUrl: `https://drive.google.com/file/d/${driveId}/view`,
    };
  }

  return null;
}

/** Returns the normalized canonical URL string, or null if invalid. */
export function normalizeHouseVideoUrl(raw: string | null | undefined): string | null {
  return parseHouseVideo(raw)?.canonicalUrl ?? null;
}

/** True when the link is a recognised, embeddable house video. */
export function isValidHouseVideoUrl(raw: string | null | undefined): boolean {
  return parseHouseVideo(raw) !== null;
}
