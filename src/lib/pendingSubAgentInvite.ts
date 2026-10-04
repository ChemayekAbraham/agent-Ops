/**
 * Persistent sub-agent invite session.
 *
 * When a logged-out user opens a sub-agent invite link (`/sub-agent-invite?token=...`),
 * we stash the token in localStorage so that after they sign in they can be taken
 * straight back to the acceptance screen — no need to re-click the original link.
 */

const STORAGE_KEY = 'welile.pendingSubAgentInvite';
// Invites are time-bound; don't resume something the user opened weeks ago.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface StoredInvite {
  token: string;
  savedAt: number;
}

export function savePendingSubAgentInvite(token: string): void {
  if (!token) return;
  try {
    const payload: StoredInvite = { token, savedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable (private mode / quota) — ignore */
  }
}

export function getPendingSubAgentInvite(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredInvite;
    if (!parsed?.token) {
      clearPendingSubAgentInvite();
      return null;
    }
    if (Date.now() - (parsed.savedAt || 0) > MAX_AGE_MS) {
      clearPendingSubAgentInvite();
      return null;
    }
    return parsed.token;
  } catch {
    return null;
  }
}

export function clearPendingSubAgentInvite(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
