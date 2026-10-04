// 24-hour staff access password cache
// Stores verified manager user_id so they skip re-auth when switching roles

const STAFF_SESSION_KEY = 'welile_staff_session';
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface StaffSession {
  userId: string;
  name: string;
  verifiedAt: number;
}

export function getStaffSession(): StaffSession | null {
  try {
    const raw = localStorage.getItem(STAFF_SESSION_KEY);
    if (!raw) return null;
    const session: StaffSession = JSON.parse(raw);
    if (Date.now() - session.verifiedAt > SESSION_TTL) {
      localStorage.removeItem(STAFF_SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function setStaffSession(userId: string, name: string): void {
  try {
    const session: StaffSession = { userId, name, verifiedAt: Date.now() };
    localStorage.setItem(STAFF_SESSION_KEY, JSON.stringify(session));
  } catch {}
}

export function clearStaffSession(): void {
  try {
    localStorage.removeItem(STAFF_SESSION_KEY);
  } catch {}
}
