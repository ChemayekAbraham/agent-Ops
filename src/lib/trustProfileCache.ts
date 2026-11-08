/**
 * localStorage cache for trust profiles (src/hooks/useTrustProfile.ts).
 *
 * The server answers per viewer: contact details follow permissions.can_see_pii, and from Partner
 * Returns migration 4b the Returns figures (and the vouch figures built from them) are null for anyone
 * but the person, partner staff and their approved proxy agent (D9). So a cached copy belongs to the
 * viewer who fetched it and is never shown to anyone else, which matters on a shared office device.
 *
 * Key: welile_trust_profile_<viewer>:<'pub_' in public mode><AI ID>, where viewer is the signed-in
 * user id, or 'anon' when signed out. Keys written before viewers were part of the key
 * ("welile_trust_profile_WEL-…", "welile_trust_profile_pub_WEL-…") belong to nobody and are dropped.
 */
export const TRUST_PROFILE_CACHE_PREFIX = 'welile_trust_profile_';
export const TRUST_PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;

/** The cache owner for a signed-out viewer. A user id is a uuid, so it can never equal this. */
const ANONYMOUS_VIEWER = 'anon';

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked storage (privacy mode): nothing is cached
  }
}

const ownerFor = (viewerId: string | null): string => viewerId || ANONYMOUS_VIEWER;

export function trustProfileCacheKey(viewerId: string | null, aiId: string, publicMode: boolean): string {
  return `${TRUST_PROFILE_CACHE_PREFIX}${ownerFor(viewerId)}:${publicMode ? 'pub_' : ''}${aiId.trim().toUpperCase()}`;
}

/** The viewer a cache key belongs to; null for a key written before viewers were keyed. */
function keyOwner(key: string): string | null {
  const rest = key.slice(TRUST_PROFILE_CACHE_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon > 0 ? rest.slice(0, colon) : null;
}

/** Removes every cached trust profile whose owner `drop` selects. One pass over localStorage. */
function dropCaches(drop: (owner: string | null) => boolean): void {
  const s = storage();
  if (!s) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key && key.startsWith(TRUST_PROFILE_CACHE_PREFIX) && drop(keyOwner(key))) doomed.push(key);
    }
    for (const key of doomed) s.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/**
 * The viewer's cached copy of a trust profile, or null (none, expired or unreadable). Copies cached for
 * any other viewer, and copies without an owner, are dropped first, so a profile cached by the previous
 * person on this device never outlives the next read.
 */
export function readTrustProfileCache<T>(viewerId: string | null, aiId: string, publicMode: boolean, now = Date.now()): T | null {
  const own = ownerFor(viewerId);
  dropCaches((owner) => owner !== own);
  const s = storage();
  if (!s) return null;
  const key = trustProfileCacheKey(viewerId, aiId, publicMode);
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<CacheEntry<T>> | null;
    if (entry && entry.data && typeof entry.cachedAt === 'number' && now - entry.cachedAt < TRUST_PROFILE_CACHE_TTL_MS) {
      return entry.data;
    }
  } catch {
    /* unreadable entry: dropped below */
  }
  try { s.removeItem(key); } catch { /* ignore */ }
  return null;
}

export function writeTrustProfileCache<T>(viewerId: string | null, aiId: string, publicMode: boolean, data: T, now = Date.now()): void {
  const s = storage();
  if (!s) return;
  const entry: CacheEntry<T> = { data, cachedAt: now };
  try {
    s.setItem(trustProfileCacheKey(viewerId, aiId, publicMode), JSON.stringify(entry));
  } catch {
    /* quota or blocked storage: not cached */
  }
}

/**
 * Sign-out (called from clearSessionCache): drops every signed-in viewer's cached trust profiles and the
 * old unowned ones. Signed-out ('anon') copies hold only what anyone may see and are kept unless
 * `includeAnonymous` is set.
 */
export function clearTrustProfileCaches(opts: { includeAnonymous?: boolean } = {}): void {
  dropCaches((owner) => opts.includeAnonymous === true || owner !== ANONYMOUS_VIEWER);
}
