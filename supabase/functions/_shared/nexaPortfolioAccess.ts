/**
 * Portfolio verification for callers who are not signed in (web visitors, WhatsApp bridge).
 * Flow: portfolio code -> SMS OTP to the phone on file -> short-lived session scoped to ONE portfolio.
 * Responses never reveal whether a code exists. Every step is audited. PINs are never used here.
 */
import { sendSMS } from './sendSmsMultiProvider.ts';
import { recordAccessAlert, type AccessAlert } from './nexaAccess.ts';
export type AlertCtx = Pick<AccessAlert, 'userId' | 'phone' | 'channel' | 'roles'>;

export const OTP_TTL_SECONDS = 600;
export const SESSION_TTL_SECONDS = 900;
export const MAX_VERIFY_ATTEMPTS = 3;
export const LOCKOUT_SECONDS = 3600;
export const MAX_REQUESTS_PER_IP_HOUR = 5;
export const MAX_REQUESTS_PER_CODE_HOUR = 3;
export const GENERIC_SENT = 'If that portfolio code is registered, we have sent a 6-digit code by SMS to the phone number on file. Enter it in the verify box within 10 minutes.';
export const GENERIC_FAIL = 'That code did not work or has expired. Request a new code and try again.';

export async function sha256Hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function normalizePortfolioCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase().replace(/\s+/g, '');
  return /^(WIP\d{10}(-S\d{1,3})?|WPF-\d{3,8}|WSR\d{10})$/.test(c) ? c : null;
}
function secureOtp(): string {
  const a = new Uint32Array(1); crypto.getRandomValues(a);
  return String(a[0] % 1_000_000).padStart(6, '0');
}
function secureToken(): string {
  const a = new Uint8Array(32); crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}
const since = (s: number) => new Date(Date.now() - s * 1000).toISOString();

// deno-lint-ignore no-explicit-any
type Admin = any;
async function audit(admin: Admin, event: string, f: { portfolioId?: string | null; codeHash?: string | null; ipHash?: string | null; challengeId?: string | null; detail?: string }) {
  await admin.from('nexa_portfolio_access_audit').insert({ event, portfolio_id: f.portfolioId ?? null, code_hash: f.codeHash ?? null, ip_hash: f.ipHash ?? null, challenge_id: f.challengeId ?? null, detail: f.detail ?? null });
}

export async function requestPortfolioOtp(admin: Admin, rawCode: unknown, ip: string, ctx: AlertCtx = {}): Promise<{ ok: true; challengeId: string; message: string } | { ok: false; status: number; message: string }> {
  const ipHash = await sha256Hex(`ip:${ip}`);
  const code = normalizePortfolioCode(rawCode);
  // A fake challenge id is returned for unknown codes so the response shape never leaks existence.
  const decoy = crypto.randomUUID();
  if (!code) { await audit(admin, 'otp_request_bad_format', { ipHash }); return { ok: true, challengeId: decoy, message: GENERIC_SENT }; }
  const codeHash = await sha256Hex(`code:${code}`);
  const [{ count: ipCount }, { count: codeCount }] = await Promise.all([
    admin.from('nexa_portfolio_access_audit').select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash).like('event', 'otp_request%').gte('created_at', since(3600)),
    admin.from('nexa_portfolio_access_audit').select('id', { count: 'exact', head: true }).eq('code_hash', codeHash).like('event', 'otp_request%').gte('created_at', since(3600)),
  ]);
  if ((ipCount ?? 0) >= MAX_REQUESTS_PER_IP_HOUR || (codeCount ?? 0) >= MAX_REQUESTS_PER_CODE_HOUR) {
    await audit(admin, 'otp_request_rate_limited', { codeHash, ipHash });
    return { ok: false, status: 429, message: 'Too many requests. Please wait an hour and try again.' };
  }
  const { data: target } = await admin.rpc('nexa_portfolio_otp_target', { p_portfolio_code: code });
  const row = Array.isArray(target) ? target[0] : target;
  if (!row?.portfolio_id || !row?.phone) { await audit(admin, 'otp_request_no_target', { codeHash, ipHash }); return { ok: true, challengeId: decoy, message: GENERIC_SENT }; }
  const { data: locked } = await admin.from('nexa_portfolio_otp_challenges').select('id').eq('portfolio_id', row.portfolio_id).gt('locked_until', new Date().toISOString()).limit(1);
  if (ctx.userId && row.investor_id && ctx.userId !== row.investor_id) {
    await audit(admin, 'otp_request_not_owner', { portfolioId: row.portfolio_id, codeHash, ipHash });
    await recordAccessAlert(admin, { ...ctx, attemptedResource: 'portfolio_otp_request', reason: 'Signed-in caller requested a code for a portfolio they do not own' });
    return { ok: true, challengeId: decoy, message: GENERIC_SENT };
  }
  if (locked?.length) { await recordAccessAlert(admin, { ...ctx, attemptedResource: 'portfolio_otp_request', reason: 'OTP requested while portfolio verification is locked' }); await audit(admin, 'otp_request_locked', { portfolioId: row.portfolio_id, codeHash, ipHash }); return { ok: true, challengeId: decoy, message: GENERIC_SENT }; }
  const otp = secureOtp();
  const { data: ch, error } = await admin.from('nexa_portfolio_otp_challenges').insert({ portfolio_id: row.portfolio_id, otp_hash: await sha256Hex(`otp:${otp}`), expires_at: new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString(), ip_hash: ipHash }).select('id').single();
  if (error || !ch) return { ok: false, status: 503, message: 'Verification is unavailable right now. Please try again later.' };
  const sent = await sendSMS(row.phone, `Welile Nexa code: ${otp}. Valid 10 min. Never share it. Welile will never ask for your PIN.`, { admin, source: 'nexa-portfolio-otp', reference_id: ch.id, recipient_user_id: row.investor_id ?? null });
  await audit(admin, sent ? 'otp_request_sent' : 'otp_request_send_failed', { portfolioId: row.portfolio_id, codeHash, ipHash, challengeId: ch.id });
  return { ok: true, challengeId: ch.id, message: GENERIC_SENT };
}

export async function verifyPortfolioOtp(admin: Admin, challengeId: unknown, otp: unknown, ip: string, ctx: AlertCtx = {}): Promise<{ ok: true; sessionToken: string; expiresInSeconds: number } | { ok: false; message: string }> {
  const ipHash = await sha256Hex(`ip:${ip}`);
  if (typeof challengeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(challengeId) || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) return { ok: false, message: GENERIC_FAIL };
  const { data: ch } = await admin.from('nexa_portfolio_otp_challenges').select('id,portfolio_id,otp_hash,expires_at,attempts,consumed_at,locked_until').eq('id', challengeId).maybeSingle();
  if (!ch) { await audit(admin, 'otp_verify_unknown', { ipHash }); return { ok: false, message: GENERIC_FAIL }; }
  const now = Date.now();
  if (ch.consumed_at || new Date(ch.expires_at).getTime() < now || (ch.locked_until && new Date(ch.locked_until).getTime() > now) || ch.attempts >= MAX_VERIFY_ATTEMPTS) {
    await audit(admin, 'otp_verify_rejected', { portfolioId: ch.portfolio_id, ipHash, challengeId: ch.id }); return { ok: false, message: GENERIC_FAIL };
  }
  if ((await sha256Hex(`otp:${otp}`)) !== ch.otp_hash) {
    const attempts = ch.attempts + 1;
    await admin.from('nexa_portfolio_otp_challenges').update({ attempts, locked_until: attempts >= MAX_VERIFY_ATTEMPTS ? new Date(now + LOCKOUT_SECONDS * 1000).toISOString() : null }).eq('id', ch.id);
    await audit(admin, attempts >= MAX_VERIFY_ATTEMPTS ? 'otp_verify_locked' : 'otp_verify_wrong', { portfolioId: ch.portfolio_id, ipHash, challengeId: ch.id });
    if (attempts >= MAX_VERIFY_ATTEMPTS) await recordAccessAlert(admin, { ...ctx, attemptedResource: 'portfolio_otp_verify', reason: `Portfolio verification locked after ${MAX_VERIFY_ATTEMPTS} wrong codes` });
    return { ok: false, message: GENERIC_FAIL };
  }
  // Single use: only consume if still unconsumed (guards against a race).
  const { data: consumed } = await admin.from('nexa_portfolio_otp_challenges').update({ consumed_at: new Date().toISOString() }).eq('id', ch.id).is('consumed_at', null).select('id');
  if (!consumed?.length) return { ok: false, message: GENERIC_FAIL };
  const token = secureToken();
  await admin.from('nexa_portfolio_sessions').insert({ token_hash: await sha256Hex(`session:${token}`), portfolio_id: ch.portfolio_id, expires_at: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString() });
  await audit(admin, 'otp_verify_ok', { portfolioId: ch.portfolio_id, ipHash, challengeId: ch.id });
  return { ok: true, sessionToken: token, expiresInSeconds: SESSION_TTL_SECONDS };
}

/** Resolve a session token to exactly one portfolio id, or null. */
export async function portfolioIdFromSession(admin: Admin, token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const { data } = await admin.from('nexa_portfolio_sessions').select('portfolio_id,expires_at,revoked_at').eq('token_hash', await sha256Hex(`session:${token}`)).maybeSingle();
  if (!data || data.revoked_at || new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.portfolio_id;
}
export { audit as auditPortfolioAccess };
