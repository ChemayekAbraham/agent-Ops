import { safeUUID } from '@/lib/safeUUID';

/**
 * Lightweight, stable-per-browser device fingerprint used for anti-fraud
 * gating at signup and for spotting one device signing in to many accounts.
 * Not a security boundary — a determined attacker can wipe all site data —
 * but combined with phone OTP and server-side caps it stops casual account
 * farming.
 *
 * Two values:
 *   - getDeviceFingerprint(): a per-browser seed bound to slow-changing device
 *     signals. Used for the signup cap and the sign-in step-up. v1 hashed the
 *     full user-agent string, so every browser auto-update (and every Chrome
 *     version bump) turned the same phone into a "new device"; v2 keeps only
 *     the OS and browser family. The seed is kept in localStorage AND a
 *     first-party cookie, so clearing one of them alone no longer resets it.
 *   - getHardwareFingerprint(): the same device signals WITHOUT the seed. It
 *     survives clearing site data, but two phones of the same model in the same
 *     time zone can collide, so it is only ever a review signal — never a block.
 */

const STORAGE_KEY = 'welile_device_fp_v2';
const LEGACY_STORAGE_KEY = 'welile_device_fp_v1';
const SEED_KEY = 'welile_device_seed_v1';
const SEED_COOKIE = 'welile_ds';
const SEED_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60; // browsers cap cookie lifetime at 400 days

async function sha256Hex(input: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    // Fallback: cheap non-crypto hash — good enough for a fingerprint identifier.
    let h = 0;
    for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
    return 'fb_' + Math.abs(h).toString(16);
  }
}

const SEED_RE = /^[A-Za-z0-9-]{8,64}$/;

function readSeedCookie(): string | null {
  try {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + SEED_COOKIE + '=([^;]+)'));
    const v = m ? decodeURIComponent(m[1]) : null;
    return v && SEED_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

function writeSeedCookie(seed: string): void {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${SEED_COOKIE}=${encodeURIComponent(seed)}; Max-Age=${SEED_COOKIE_MAX_AGE_S}; Path=/; SameSite=Lax${secure}`;
  } catch {
    /* ignore */
  }
}

/** The per-browser seed, restored from whichever store still holds it and written back to both. */
function getSeed(): string {
  let seed: string | null = null;
  try {
    const stored = localStorage.getItem(SEED_KEY);
    if (stored && SEED_RE.test(stored)) seed = stored;
  } catch {
    /* ignore */
  }
  if (!seed) seed = readSeedCookie();
  if (!seed) seed = safeUUID();
  try {
    localStorage.setItem(SEED_KEY, seed);
  } catch {
    /* ignore */
  }
  writeSeedCookie(seed);
  return seed;
}

/** OS and browser family only — never versions, which change on every update. */
export function coarseUserAgent(ua: string): string {
  let os = 'other';
  if (/Android/i.test(ua)) os = 'android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'ios';
  else if (/Windows/i.test(ua)) os = 'windows';
  else if (/CrOS/i.test(ua)) os = 'chromeos';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'mac';
  else if (/Linux/i.test(ua)) os = 'linux';
  let browser = 'other';
  if (/Edg\//i.test(ua)) browser = 'edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'opera';
  else if (/SamsungBrowser/i.test(ua)) browser = 'samsung';
  else if (/Firefox\/|FxiOS/i.test(ua)) browser = 'firefox';
  else if (/Chrome\/|CriOS/i.test(ua)) browser = 'chrome';
  else if (/Safari\//i.test(ua)) browser = 'safari';
  return `${os}/${browser}`;
}

function canvasSignature(): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 40;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'nocanvas';
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 100, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('welile-fp:☁︎', 2, 2);
    return canvas.toDataURL().slice(-64);
  } catch {
    return 'nocanvas';
  }
}

/** Slow-changing device signals: no versions, no seed. */
function deviceSignals(): string[] {
  const w = Math.max(screen.width || 0, screen.height || 0);
  const h = Math.min(screen.width || 0, screen.height || 0); // orientation-independent
  return [
    coarseUserAgent(navigator.userAgent || ''),
    `${w}x${h}x${screen.colorDepth || ''}`,
    String(new Date().getTimezoneOffset()),
    String((navigator as any).hardwareConcurrency || ''),
    String((navigator as any).deviceMemory || ''),
    String((navigator as any).maxTouchPoints ?? ''),
  ];
}

export async function getDeviceFingerprint(): Promise<string> {
  const hash = await sha256Hex(['v2', getSeed(), ...deviceSignals()].join('|'));
  // "Don't trust user input": we ALWAYS recompute the fingerprint from live
  // browser signals rather than trusting whatever value happens to be sitting
  // in localStorage. If the cached value has been tampered with (edited via
  // devtools, forged by an extension, or copied between browsers) we detect
  // the mismatch, wipe the bad cache, and use the freshly computed hash.
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached && cached !== hash) {
      localStorage.removeItem(STORAGE_KEY);
    }
    localStorage.setItem(STORAGE_KEY, hash);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch { /* ignore */ }
  return hash;
}

/** Device signals without the seed — survives clearing site data, may collide across identical phones. Review only. */
export async function getHardwareFingerprint(): Promise<string> {
  return sha256Hex(['hw1', ...deviceSignals(), navigator.language || '', canvasSignature()].join('|'));
}

/**
 * Shape guard used before we ship the fingerprint to the server. A valid
 * fingerprint is either the SHA-256 hex digest (64 lowercase hex chars) or
 * the documented `fb_<hex>` fallback. Anything else is treated as tampered
 * input and dropped so the server can decide how to react.
 */
export function isValidFingerprintShape(fp: string | null | undefined): boolean {
  if (!fp || typeof fp !== 'string') return false;
  if (fp.length > 128) return false;
  return /^[a-f0-9]{64}$/.test(fp) || /^fb_[a-f0-9]{1,64}$/.test(fp);
}
