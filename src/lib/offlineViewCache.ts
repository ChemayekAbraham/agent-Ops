/**
 * Tiny localStorage-backed view cache for read-only offline access.
 * Used by Financial Statement, My Receipts, etc. to render last-known
 * data when the device is offline. NEVER use for writes or balance
 * computation — UI-only snapshot.
 */
const PREFIX = 'welile_view_v1';

export function saveViewCache<T>(key: string, userId: string | undefined, data: T) {
  if (!userId) return;
  try {
    localStorage.setItem(
      `${PREFIX}:${key}:${userId}`,
      JSON.stringify({ data, ts: Date.now() }),
    );
  } catch {
    /* quota or private mode — ignore */
  }
}

export function loadViewCache<T>(
  key: string,
  userId: string | undefined,
): { data: T; ts: number } | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(`${PREFIX}:${key}:${userId}`);
    if (!raw) return null;
    return JSON.parse(raw) as { data: T; ts: number };
  } catch {
    return null;
  }
}