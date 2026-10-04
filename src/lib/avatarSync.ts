/**
 * Avatar sync — one place that announces "this person's profile picture changed".
 *
 * Profile pictures are read in dozens of places (own profile, verification
 * queues, audit logs, leaderboards, chat, public seller/holistic profiles),
 * each with its own cache. Whoever writes `profiles.avatar_url` must call
 * `publishAvatarUpdate` so every mounted view — and every other open tab —
 * repaints immediately instead of waiting for its cache to expire.
 *
 * No wallet/ledger state is touched here; this is presentation data only.
 */

export const AVATAR_UPDATED_EVENT = 'welile-avatar-updated';
const OVERRIDE_KEY = 'welile-avatar-overrides';
const CHANNEL_NAME = 'welile-avatar-sync';

export interface AvatarUpdate {
  userId: string;
  avatarUrl: string | null;
  at: number;
}

type OverrideMap = Record<string, { url: string | null; at: number }>;

function readOverrides(): OverrideMap {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as OverrideMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeOverride(userId: string, url: string | null) {
  try {
    const map = readOverrides();
    map[userId] = { url, at: Date.now() };
    // Keep the store small — only the 50 most recent updates matter.
    const trimmed = Object.entries(map)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 50);
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    /* storage full or unavailable — the in-page event still fires */
  }
}

/**
 * The freshest known picture for a user: a locally published update wins over
 * whatever a cached row still carries, so a just-changed photo never flickers
 * back to the old one.
 */
export function resolveAvatarUrl(userId: string | null | undefined, fallback: string | null | undefined): string | null {
  if (!userId) return fallback ?? null;
  const hit = readOverrides()[userId];
  if (hit) return hit.url;
  return fallback ?? null;
}

/** Announce a new (or removed) profile picture. Safe to call outside the browser. */
export function publishAvatarUpdate(userId: string, avatarUrl: string | null): void {
  if (!userId || typeof window === 'undefined') return;
  writeOverride(userId, avatarUrl);
  const detail: AvatarUpdate = { userId, avatarUrl, at: Date.now() };
  window.dispatchEvent(new CustomEvent<AvatarUpdate>(AVATAR_UPDATED_EVENT, { detail }));
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(detail);
    channel.close();
  } catch {
    /* BroadcastChannel unsupported (older Safari) — same-tab event still fires */
  }
}

/** Listen for profile picture changes in this tab and in other open tabs. */
export function subscribeAvatarUpdates(handler: (update: AvatarUpdate) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onEvent = (e: Event) => {
    const detail = (e as CustomEvent<AvatarUpdate>).detail;
    if (detail?.userId) handler(detail);
  };
  window.addEventListener(AVATAR_UPDATED_EVENT, onEvent);

  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (msg) => {
      const detail = msg.data as AvatarUpdate;
      if (detail?.userId) {
        writeOverride(detail.userId, detail.avatarUrl);
        handler(detail);
      }
    };
  } catch {
    channel = null;
  }

  return () => {
    window.removeEventListener(AVATAR_UPDATED_EVENT, onEvent);
    try {
      channel?.close();
    } catch {
      /* ignore */
    }
  };
}
