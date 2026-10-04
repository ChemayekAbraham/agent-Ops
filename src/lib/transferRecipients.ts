/**
 * Local "address book" for the Send Money flow.
 *
 * Remembers the people a user has recently transferred money to (so they don't
 * have to retype a phone number / email) and lets them pin numbers as
 * favourites. Stored per-user in localStorage — this is purely a UX convenience
 * cache and is never the source of truth for routing a transfer (the recipient
 * is always re-resolved on the server before sending).
 */

export interface SavedRecipient {
  /** Resolved Welile user id, when known. */
  id?: string;
  /** Display name shown on the chip. */
  name: string;
  /** User-defined nickname to recognise the recipient faster. */
  nickname?: string;
  /** Raw phone number the user typed (used to refill the input). */
  phone?: string;
  /** Raw email the user typed (used to refill the input). */
  email?: string;
  /** Which input the recipient was reached through. */
  mode: 'phone' | 'email';
  /** Whether the user pinned this recipient. */
  favorite?: boolean;
  /** Last time we sent to (or saved) this recipient — for recency sort. */
  lastUsed: number;
}

const MAX_RECENTS = 12;

const keyFor = (userId?: string | null) =>
  `welile_transfer_recipients_${userId || 'anon'}`;

/** A stable identity for a recipient, used to de-dupe entries. */
const identity = (r: Pick<SavedRecipient, 'mode' | 'phone' | 'email' | 'id'>): string => {
  if (r.id) return `id:${r.id}`;
  if (r.mode === 'email') return `email:${(r.email || '').trim().toLowerCase()}`;
  return `phone:${(r.phone || '').replace(/\D/g, '').slice(-9)}`;
};

export function loadRecipients(userId?: string | null): SavedRecipient[] {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedRecipient[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function persist(userId: string | null | undefined, list: SavedRecipient[]) {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(list));
  } catch {
    /* ignore quota / serialization errors — this cache is best-effort */
  }
}

/** Derive a friendly nickname from name / phone / email. */
function autoNickname(name: string, phone?: string, email?: string): string {
  if (name && name.trim() && name.trim() !== 'Welile user') {
    const first = name.trim().split(/\s+/)[0];
    if (first && first.length > 1) return first;
  }
  if (phone) {
    const digits = phone.replace(/\D/g, '').slice(-4);
    if (digits) return `Phone …${digits}`;
  }
  if (email) {
    const prefix = email.split('@')[0];
    if (prefix && prefix.length > 1) return prefix;
  }
  return name || 'Contact';
}

/** Record (or refresh) a recipient after a successful transfer. */
export function rememberRecipient(
  userId: string | null | undefined,
  recipient: Omit<SavedRecipient, 'lastUsed' | 'favorite'>,
): SavedRecipient[] {
  const list = loadRecipients(userId);
  const id = identity(recipient);
  const existing = list.find((r) => identity(r) === id);
  const next: SavedRecipient = {
    ...existing,
    ...recipient,
    favorite: existing?.favorite ?? false,
    lastUsed: Date.now(),
  };
  // Auto-generate a nickname for brand-new recipients so they’re easy to recognise.
  if (!existing && !next.nickname) {
    next.nickname = autoNickname(next.name, next.phone, next.email);
  }
  const others = list.filter((r) => identity(r) !== id);
  // Keep all favourites + the most recent non-favourites up to the cap.
  const favorites = others.filter((r) => r.favorite);
  const recents = others.filter((r) => !r.favorite).slice(0, MAX_RECENTS - 1);
  const merged = [next, ...favorites, ...recents];
  persist(userId, merged);
  return merged;
}

/** Toggle the favourite flag on a recipient. */
export function toggleFavorite(
  userId: string | null | undefined,
  recipient: Pick<SavedRecipient, 'mode' | 'phone' | 'email' | 'id'>,
): SavedRecipient[] {
  const list = loadRecipients(userId);
  const id = identity(recipient);
  const next = list.map((r) =>
    identity(r) === id ? { ...r, favorite: !r.favorite } : r,
  );
  persist(userId, next);
  return next;
}

/** Remove a recipient from the list entirely. */
export function removeRecipient(
  userId: string | null | undefined,
  recipient: Pick<SavedRecipient, 'mode' | 'phone' | 'email' | 'id'>,
): SavedRecipient[] {
  const list = loadRecipients(userId);
  const id = identity(recipient);
  const next = list.filter((r) => identity(r) !== id);
  persist(userId, next);
  return next;
}

/** Set or clear a nickname on a recipient. */
export function updateNickname(
  userId: string | null | undefined,
  recipient: Pick<SavedRecipient, 'mode' | 'phone' | 'email' | 'id'>,
  nickname: string | undefined,
): SavedRecipient[] {
  const list = loadRecipients(userId);
  const id = identity(recipient);
  const next = list.map((r) =>
    identity(r) === id ? { ...r, nickname: nickname?.trim() || undefined } : r,
  );
  persist(userId, next);
  return next;
}

/** Favourites first (newest first), then recents (newest first). */
export function sortRecipients(list: SavedRecipient[]): SavedRecipient[] {
  return [...list].sort((a, b) => {
    if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
    return b.lastUsed - a.lastUsed;
  });
}
