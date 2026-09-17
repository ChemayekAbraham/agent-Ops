/**
 * Mobile money / bank name check before a payout number may be verified.
 *
 * The reviewer does a real send-money name lookup on their own phone (MTN or
 * Airtel), types the registered name exactly as the network showed it, and this
 * module compares it with the name read from the National ID. Verify only opens
 * when the two names are the same person.
 *
 * The recorded check is kept per payout destination in the browser so moving
 * through the queue and back does not lose it. It is also written into the
 * decision note, which is the durable audit trail.
 */

const STORE_KEY = 'welile-payout-name-check-v1';

export type NameCheckOutcome = 'match' | 'partial' | 'different';

export interface PayoutNameCheck {
  /** Name exactly as the mobile money / bank lookup displayed it. */
  networkName: string;
  outcome: NameCheckOutcome;
  /** ISO timestamp of when the reviewer recorded it. */
  checkedAt: string;
}

type Store = Record<string, PayoutNameCheck>;

function readStore(): Store {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // storage unavailable — the in-memory state for this session still works
  }
}

export function loadNameCheck(destinationId: string | null | undefined): PayoutNameCheck | null {
  if (!destinationId) return null;
  return readStore()[destinationId] ?? null;
}

export function saveNameCheck(destinationId: string, check: PayoutNameCheck) {
  const store = readStore();
  store[destinationId] = check;
  writeStore(store);
}

export function clearNameCheck(destinationId: string) {
  const store = readStore();
  delete store[destinationId];
  writeStore(store);
}

/** Letters only, upper case, single spaces — so punctuation and spacing never decide. */
function tokens(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Compare the name the network showed with the name on the National ID.
 *
 * - match: every meaningful word of the shorter name appears in the longer one,
 *   and at least two words are shared. Word order does not matter, and a
 *   dropped middle name is still a match.
 * - partial: exactly one shared word, or one word of the shorter name missing.
 * - different: anything else.
 */
export function compareNames(networkName: string, idName: string): NameCheckOutcome {
  const a = tokens(networkName);
  const b = tokens(idName);
  if (a.length === 0 || b.length === 0) return 'different';

  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  const longSet = new Set(long);
  const shared = short.filter((t) => longSet.has(t));
  const missing = short.length - shared.length;

  if (shared.length >= 2 && missing === 0) return 'match';
  if (shared.length >= 2 && missing <= 1) return 'partial';
  if (shared.length === 1 && short.length === 1 && long.length === 1) return 'partial';
  if (shared.length >= 1) return 'partial';
  return 'different';
}

/** Which network's send-money menu the reviewer should use, and how to reach it. */
export function networkForNumber(
  provider: string | null | undefined,
  number: string | null | undefined,
): { label: string; ussd: string | null } {
  const p = (provider ?? '').toLowerCase();
  const digits = (number ?? '').replace(/\D/g, '');
  const prefix = digits.slice(-9, -6);

  const isMtn = p.includes('mtn') || ['077', '078', '076', '039'].includes(prefix);
  const isAirtel = p.includes('airtel') || ['070', '075', '074', '020'].includes(prefix);

  if (isMtn) return { label: 'MTN MoMo', ussd: '*165*1#' };
  if (isAirtel) return { label: 'Airtel Money', ussd: '*185*1#' };
  return { label: provider || 'Mobile money', ussd: null };
}
