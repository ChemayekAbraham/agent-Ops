// Pure helpers for partner-tenant-daily-backup. No I/O.

export const BACKUP_KEEP_DAYS = 7;

// No 0/O, 1/l/I: the password is read off an email and typed into 7-Zip.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Random password from crypto.getRandomValues, rejection-sampled (no modulo bias). */
export function generateBackupPassword(length = 24): string {
  const n = PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < length) out += PASSWORD_ALPHABET[b % n];
    }
  }
  return out;
}

/** Kampala (UTC+3, no DST) date and HHMM for a moment. */
export function kampalaStamp(at: Date): { day: string; time: string } {
  const k = new Date(at.getTime() + 3 * 60 * 60 * 1000).toISOString();
  return { day: k.slice(0, 10), time: k.slice(11, 13) + k.slice(14, 16) };
}

const FILE_RE = /^welile-partner-tenant_(\d{4}-\d{2}-\d{2})_(\d{4})\.zip$/;

/** One file per run; a same-day re-run gets its own name so it never overwrites a good file. */
export function backupFileName(at: Date): string {
  const { day, time } = kampalaStamp(at);
  return `welile-partner-tenant_${day}_${time}.zip`;
}

/**
 * Files to delete so that only the newest verified backup of each of the
 * newest `keepDays` days remains. A backup file that was never verified (its
 * run was killed before the check, so nobody has its password) is deleted
 * too, unless it is in `inFlight` (a run still checking it). Names that are
 * not backup files are never returned. Only call this after the new backup
 * has been verified and its password sent.
 */
export function backupFilesToDelete(
  names: string[],
  verified: Set<string>,
  inFlight: Set<string> = new Set(),
  keepDays = BACKUP_KEEP_DAYS,
): string[] {
  const newestPerDay = new Map<string, string>();
  const backups: string[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m || inFlight.has(name)) continue;
    backups.push(name);
    if (!verified.has(name)) continue;
    const cur = newestPerDay.get(m[1]);
    if (!cur || name > cur) newestPerDay.set(m[1], name);
  }
  const keptDays = [...newestPerDay.keys()].sort().reverse().slice(0, keepDays);
  const keep = new Set(keptDays.map((d) => newestPerDay.get(d)!));
  return backups.filter((n) => !keep.has(n)).sort();
}

/**
 * Rows can be added or removed while the export runs (it pages by id), so the
 * written count may differ slightly from the count taken at the start. A gap
 * larger than this means rows went missing.
 */
export function rowDriftAcceptable(expected: number, written: number): boolean {
  if (expected > 0 && written === 0) return false;
  return Math.abs(written - expected) <= Math.max(10, Math.ceil(expected * 0.005));
}
